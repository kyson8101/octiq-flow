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

describe("the reported tool name", () => {
  const called = (name: string, args: unknown): Tool => ({
    kind: "tool",
    id: `tool-${name}`,
    name,
    argsJson: JSON.stringify(args),
    args,
    state: "done",
  });

  it("shows Skill as the tool and keeps the requested skill in its arguments", () => {
    const html = render(called("Skill", { skill: "pandahrms:slice", args: "--fast" }));

    expect(html).toContain('<span class="tool-name">Skill</span>');
    expect(html).toContain("pandahrms:slice --fast");
    expect(html).not.toContain('<span class="tool-name">/slice</span>');
  });

  it("shows an MCP tool's server and callable in a compact label", () => {
    const html = render(called("mcp__docspace__save_decision", {}));

    expect(html).toContain('<span class="tool-name">mcp(docspace:save_decision)</span>');
    expect(html).toContain('title="mcp__docspace__save_decision"');
  });

  it("shows a file_change event as edit while retaining its raw name", () => {
    const html = render(called("file_change", { file_path: "src/chat.ts" }));

    expect(html).toContain('<span class="tool-name">edit(src/chat.ts)</span>');
    expect(html).toContain('title="file_change"');
    expect(html).not.toContain('<span class="tool-detail"');
  });

  it("puts the full tool identity above its command detail", () => {
    const html = render(
      called("command_execution", {
        command: "find bible/seasons/01 -maxdepth 1 -type f -print | sort",
      }),
    );

    expect(html).toMatch(
      /class="tool-copy"><span class="tool-identity"><span class="tool-name">command_execution<\/span><\/span><span class="tool-detail"/,
    );
    expect(html).toContain("find bible/seasons/01");
  });

  it("shows the CLI called through zsh instead of its long launcher command", () => {
    const command = "/bin/zsh -lc \"ssh build-host 'pnpm install --frozen-lockfile; ./install.sh'\"";
    const tool = { ...called("command_execution", { command }), state: "running" as const };
    const folded = render(tool);

    expect(folded).toContain('<span class="tool-name">zsh(ssh)</span>');
    expect(folded).toContain('class="tool-state is-running"');
    expect(folded).not.toContain("pnpm install --frozen-lockfile");

    const expanded = renderToStaticMarkup(<ToolCard tool={tool} open />);
    expect(expanded).toContain("pnpm install --frozen-lockfile");
  });

  it("skips shell setup before the CLI", () => {
    const command = "/bin/zsh -lc 'set -e; cd repo && GH_HOST=github.com gh pr view 42'";
    const html = render(called("command_execution", { command }));

    expect(html).toContain('<span class="tool-name">gh(pr view)</span>');
    expect(html).not.toContain("GH_HOST=github.com");
  });

  it("shows search and read intent for known zsh commands", () => {
    const search = render(called("command_execution", { command: "/bin/zsh -lc 'rg -n needle src'" }));
    const read = render(called("command_execution", { command: "/bin/zsh -lc 'sed -n 1,80p README.md'" }));

    expect(search).toContain('<span class="tool-name">search(rg: needle)</span>');
    expect(search).toContain('data-kind="search"');
    expect(read).toContain('<span class="tool-name">read(README.md)</span>');
    expect(read).toContain('data-kind="read"');
  });

  it("shows the git operation instead of the shell launcher", () => {
    const log = render(called("command_execution", { command: "/bin/zsh -lc 'git --no-pager log --oneline'" }));
    const commit = render(called("command_execution", { command: "/bin/zsh -lc 'git commit -m message'" }));
    const push = render(called("command_execution", { command: "/bin/zsh -lc 'git push origin main'" }));

    expect(log).toContain('<span class="tool-name">git(log)</span>');
    expect(commit).toContain('<span class="tool-name">git(commit)</span>');
    expect(push).toContain('<span class="tool-name">git(push)</span>');
  });

  it("shows the gh operations instead of command_execution", () => {
    const command = "/bin/bash -c 'set -euo pipefail\ncurrent=\"$(gh pr view 162)\"\ngh pr review 162 --approve\ngh pr merge 162'";
    const html = render(called("command_execution", { command }));

    expect(html).toContain('<span class="tool-name">gh(pr view, pr review, pr merge)</span>');
    expect(html).not.toContain("gh pr review 162");
  });

  it("shows the gh operation in a chained shell command", () => {
    const command = "/bin/zsh -lc 'git remote -v && gh pr list --state open --author pyong'";
    const html = render(called("command_execution", { command }));

    expect(html).toContain('<span class="tool-name">gh(pr list)</span>');
  });

  it("classifies a direct Bash grep without showing its long command", () => {
    const command = 'grep -n "ProjectAvatar\\|project-avatar\\|is-tiny" /Users/kyson/project/web/src/components/Sidebar.tsx';
    const html = render(called("Bash", { command, description: "Find avatar size usage in Sidebar" }));

    expect(html).toContain('<span class="tool-name">search(grep: ProjectAvatar\\|project-avatar\\|is-tiny)</span>');
    expect(html).toContain('data-kind="search"');
    expect(html).toContain('title="Bash"');
    expect(html).not.toContain("/Users/kyson/project/web/src/components/Sidebar.tsx");
  });

  it("keeps a direct command as the useful row detail", () => {
    const html = render(called("command_execution", { command: "pnpm test" }));

    expect(html).toContain('<span class="tool-name">command_execution</span>');
    expect(html).toContain("pnpm test");
  });
});

describe("an MCP call's return", () => {
  const mcp = (over: Partial<Tool> = {}): Tool => ({
    kind: "tool",
    id: "mcp-1",
    name: "mcp__octiq__read_conversation",
    argsJson: "{}",
    args: { url: "https://example.test/chat" },
    result: '{"content":[{"type":"text","text":"transport payload"}],"structured_content":null}',
    state: "done",
    ...over,
  });

  it("does not render a successful return in the expanded card", () => {
    const html = renderToStaticMarkup(<ToolCard tool={mcp()} open />);

    expect(html).not.toContain("transport payload");
    expect(html).not.toContain(">result<");
  });

  it("keeps a failed return available for diagnosis", () => {
    const html = renderToStaticMarkup(
      <ToolCard tool={mcp({ state: "error", result: "Conversation could not be read" })} open />,
    );

    expect(html).toContain("Conversation could not be read");
    expect(html).toContain(">result<");
  });
});

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
