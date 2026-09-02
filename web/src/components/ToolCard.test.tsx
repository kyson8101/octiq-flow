import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Block } from "../lib/chat";
import { ToolCard } from "./ToolCard";

type Tool = Extract<Block, { kind: "tool" }>;

/** A background command, as it sits on screen: the call answered the moment it
 *  started, and the ending arrived long afterwards. */
const backgrounded = (finish?: Tool["finish"]): Tool => ({
  kind: "tool",
  id: "toolu_bg",
  name: "Bash",
  argsJson: "",
  args: { command: "codex exec …", run_in_background: true },
  result: "Command running in background with ID ba0qlummq",
  state: "done",
  finish,
});

const render = (tool: Tool) => renderToStaticMarkup(<ToolCard tool={tool} />);

describe("a card whose work ran in the background", () => {
  it("says on the folded row how that work ended", () => {
    const html = render(
      backgrounded({
        taskId: "ba0qlummq",
        toolUseId: "toolu_bg",
        status: "completed",
        summary: 'Background command "Launch Codex" completed (exit code 0)',
      }),
    );

    expect(html).toContain('data-status="completed"');
    expect(html).toContain(">completed<");
  });

  it("marks a command that did not survive, which is the case worth seeing", () => {
    const html = render(
      backgrounded({
        taskId: "b4s0cwfb7",
        toolUseId: "toolu_bg",
        status: "failed",
        summary: "Background command failed with exit code 144",
      }),
    );

    expect(html).toContain('data-status="failed"');
  });

  it("keeps the row as it was when nothing has reported back yet", () => {
    expect(render(backgrounded())).not.toContain("tool-finish");
  });

  it("puts expanded details inside their own reveal panel", () => {
    const html = renderToStaticMarkup(<ToolCard tool={backgrounded()} open />);

    expect(html).toContain('class="tool-expand"');
    expect(html).toContain('class="tool-body"');
  });

  it("puts the report itself inside the card, under the answer the call gave", () => {
    // Only a card that opens ITSELF can be read at rest, and that is the
    // subagent card — so the body is checked through one. The section is the
    // same either way; what differs is who unfolds it.
    const tool: Tool = { ...backgrounded(), state: "running" };
    const html = renderToStaticMarkup(
      <ToolCard
        tool={{
          ...tool,
          name: "Task",
          finish: {
            taskId: "ba0qlummq",
            toolUseId: "toolu_bg",
            outputFile: "/tmp/tasks/ba0qlummq.output",
            status: "completed",
            summary: 'Background command "Launch Codex" completed (exit code 0)',
          },
        }}
        agent={{ steps: 2, body: null }}
      />,
    );

    expect(html).toContain("finished");
    expect(html).toContain("/tmp/tasks/ba0qlummq.output");
    expect(html).toContain("completed (exit code 0)");
  });
});

describe("a subagent call", () => {
  const task: Tool = {
    kind: "tool",
    id: "task-1",
    name: "Task",
    argsJson: "",
    args: { description: "Check the migration" },
    state: "done",
  };

  it("uses a normal tool row that opens the agent's read-only chat", () => {
    const html = renderToStaticMarkup(<ToolCard tool={task} onOpenAgent={() => {}} />);

    expect(html).toContain('class="tool tool-done"');
    expect(html).not.toContain("tool-agent");
    expect(html).toContain('aria-label="Open read-only agent chat"');
    expect(html).toContain('title="Open read-only agent chat"');
  });

  it("gives the caret its own control, so the card still folds", () => {
    const html = renderToStaticMarkup(<ToolCard tool={task} onOpenAgent={() => {}} />);

    // The caret is no longer inside the head — clicking it would have opened
    // the agent's screen instead of folding the card.
    expect(html).toContain('class="tool-fold"');
    expect(html).toContain('aria-label="Expand this call"');
    // The only caret on the card is the one inside that control.
    expect(html.indexOf("tool-fold")).toBeLessThan(html.indexOf("tool-caret"));
  });

  it("folds from the head itself when there is no agent screen to open", () => {
    const html = renderToStaticMarkup(<ToolCard tool={task} />);

    expect(html).not.toContain("tool-fold");
    expect(html).toContain("tool-caret");
  });

  it("keeps the normal tool-row styling before its agent metadata arrives", () => {
    const html = renderToStaticMarkup(<ToolCard tool={task} agent={{ steps: 0, body: null }} />);

    expect(html).not.toContain("tool-agent");
  });
});
