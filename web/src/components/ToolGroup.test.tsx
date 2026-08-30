// The folded row, as it actually reaches the page.
//
// `groupSummary` is tested on its own in lib/toolGroups.test.ts. These checks
// cover the wiring that keeps the compact row honest: it names what happened,
// counts the whole run, and leaves the exact paths behind its disclosure.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Tool } from "../lib/toolGroups";
import { ToolGroup } from "./ToolGroup";

const read = (id: string, file_path: string): Tool => ({
  kind: "tool",
  id,
  name: "Read",
  argsJson: "",
  args: { file_path },
  state: "done",
});

const write = (id: string, file_path: string, content: string): Tool => ({
  kind: "tool",
  id,
  name: "Write",
  argsJson: "",
  args: { file_path, content },
  state: "done",
});

const bash = (id: string, command: string): Tool => ({
  kind: "tool",
  id,
  name: "Bash",
  argsJson: "",
  args: { command },
  state: "done",
});

/** The turn from the screenshot this change came out of: read, edit, read,
 *  edit, then the tests. Before edits folded it was eight cards in a column. */
const run = [
  read("1", "/Users/k/octiq/web/src/lib/chat.ts"),
  write("2", "/Users/k/octiq/web/src/lib/chat.ts", "one\ntwo\nthree\n"),
  read("3", "/Users/k/octiq/web/src/lib/chat.ts"),
  write("4", "/Users/k/octiq/web/src/lib/chat.ts", "one\ntwo\n"),
];

const html = () =>
  renderToStaticMarkup(<ToolGroup tools={run} newest={bash("5", "pnpm vitest run")} />);

describe("a run with edits folded into it", () => {
  it("describes the work as a compact action sentence", () => {
    const markup = html();
    expect(markup).toContain("Edited files");
    expect(markup).toContain("ran a command");
  });

  it("keeps counts in its disclosure label, not in the settled activity line", () => {
    // Finished activity is just the short sentence. The exact call total is
    // still available to a reader who hovers or opens the disclosure.
    const markup = html();
    expect(markup).toContain('title="Show all 5 calls"');
    expect(markup).not.toContain(">5</span>");
  });

  it("keeps the compact row clear of repeated paths and raw tool names", () => {
    expect(html()).not.toContain("/Users/k/octiq/web/src/lib");
    expect(html()).not.toContain("Write");
  });

  it("does not flash live detail while a new call is under one second old", () => {
    const markup = renderToStaticMarkup(
      <ToolGroup tools={run} newest={{ ...bash("5", "pnpm vitest run"), state: "running" }} />,
    );
    // Static markup is the first frame, before the delayed hook's one-second
    // timer may reveal the live command and its spinner.
    expect(markup).not.toContain("pnpm vitest run");
    expect(markup).not.toContain('aria-label="running"');
  });
});
