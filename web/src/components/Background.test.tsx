// The two marks that say work is still running after the turn said it was not.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { Block } from "../lib/chat";
import type { BackgroundTask } from "../lib/background";
import { BackgroundNote, BackgroundProvider } from "./Background";
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

describe("the status line", () => {
  /** What the line says for itself, with nothing running behind it. */
  const HINT = "Enter to send";
  /** And while a turn is running: its own clock, which is the one this must
   *  not double up on. */
  const TURN = "2m 19s · thinking with very high effort";

  const line = (tasks: BackgroundTask[], busy: boolean, said: string) =>
    renderToStaticMarkup(
      <BackgroundNote tasks={tasks} busy={busy}>
        {said}
      </BackgroundNote>,
    );

  it("is left exactly as it was in a chat with nothing running", () => {
    expect(line([], false, HINT)).toBe(HINT);
  });

  it("names the run after the turn's own words, and adds no second clock", () => {
    const html = line([task()], true, TURN);
    expect(html).toContain("bgwork-dot");
    expect(html).toContain(TURN);
    expect(html).toContain("codex exec");
    // The task started 4m 12s ago. The turn's clock is already on the line.
    expect(html).not.toContain("4m 12s");
  });

  it("takes the line once the turn it outlived has ended", () => {
    const html = line([task()], false, HINT);
    expect(html).toContain("bgwork-dot");
    expect(html).toContain("codex exec");
    expect(html).toContain("4m 12s");
    expect(html).not.toContain(HINT);
  });

  it("counts the rest when there is more than one", () => {
    const html = line([task(), task({ id: "b2", toolUseId: "toolu_2" })], true, TURN);
    expect(html).toContain("codex exec +1");
  });
});
