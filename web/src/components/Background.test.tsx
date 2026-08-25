// The two marks that say work is still running after the turn said it was not.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { Block } from "../lib/chat";
import type { BackgroundTask } from "../lib/background";
import { BackgroundProvider, BackgroundStrip } from "./Background";
import { ToolCard } from "./ToolCard";

type Tool = Extract<Block, { kind: "tool" }>;

/** A background command, as it sits on screen: the call answered the moment it
 *  started, and the ending has not arrived. */
const backgrounded = (over: Partial<Tool> = {}): Tool => ({
  kind: "tool",
  id: "toolu_bg",
  name: "Bash",
  argsJson: "",
  args: { command: "codex exec …", run_in_background: true },
  result: "Command running in background with ID ba0qlummq",
  state: "done",
  ...over,
});

const card = (tool: Tool, running: string[]) =>
  renderToStaticMarkup(
    <BackgroundProvider value={new Set(running)}>
      <ToolCard tool={tool} />
    </BackgroundProvider>,
  );

const task = (over: Partial<BackgroundTask> = {}): BackgroundTask => ({
  id: "b1",
  toolUseId: "toolu_bg",
  label: "codex exec",
  kind: "local_bash",
  startedAt: Date.now() - 252_000,
  ...over,
});

describe("the card", () => {
  it("holds back the tick while the work it started is still going", () => {
    const html = card(backgrounded(), ["toolu_bg"]);
    expect(html).toContain("in background");
    expect(html).not.toContain('aria-label="done"');
  });

  it("ticks as usual when nothing of its is running", () => {
    const html = card(backgrounded(), []);
    expect(html).not.toContain("in background");
    expect(html).toContain('aria-label="done"');
  });

  it("gives way the moment the ending lands, which is the better word", () => {
    const html = card(
      backgrounded({
        finish: {
          taskId: "b1",
          toolUseId: "toolu_bg",
          status: "completed",
          summary: "codex wrote the outline",
        },
      }),
      ["toolu_bg"],
    );
    expect(html).not.toContain("in background");
    expect(html).toContain('data-status="completed"');
  });

  it("leaves a call that is still in flight to say so for itself", () => {
    const html = card(backgrounded({ state: "running" }), ["toolu_bg"]);
    expect(html).not.toContain("in background");
    expect(html).toContain(">running<");
  });
});

describe("the strip", () => {
  it("draws nothing at all in a chat with nothing running", () => {
    expect(renderToStaticMarkup(<BackgroundStrip tasks={[]} />)).toBe("");
  });

  it("names the run and how long it has been going", () => {
    const html = renderToStaticMarkup(<BackgroundStrip tasks={[task()]} />);
    expect(html).toContain("still running");
    expect(html).toContain("codex exec");
    expect(html).toContain("4m 12s");
  });

  it("counts them when there is more than one", () => {
    const html = renderToStaticMarkup(
      <BackgroundStrip tasks={[task(), task({ id: "b2", toolUseId: "toolu_2" })]} />,
    );
    expect(html).toContain("2 still running");
  });
});
