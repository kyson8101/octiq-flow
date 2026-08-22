// The folded row, as it actually reaches the page.
//
// `groupTally` and `groupDiff` are tested on their own in lib/toolGroups.test.ts.
// What is checked here is the wiring the fold depends on: an edit folds like
// any other call now, so the row it folds into must SAY that a file changed
// without being opened. If that stops reaching the markup, the group is back to
// quietly swallowing the one call the reader came for.
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
  it("counts the lines it changed on the folded row", () => {
    // Five lines written across the two calls. The reader never has to open the
    // group to know the run was not just looking.
    expect(html()).toContain("+5");
  });

  it("names the file it changed, not the tool that changed it", () => {
    // `chat.ts ×4`, not `Read ×2 · Write ×2`: the tool names only repeat the
    // count already on the row above.
    const markup = html();
    expect(markup).toContain("chat.ts");
    expect(markup).not.toContain("Write");
  });

  it("marks that file as changed, so a fold never reads as a look", () => {
    expect(html()).toContain('data-kind="edit"');
  });

  it("keeps the folded row clear of the path it repeated four times", () => {
    // The same absolute path down four rows was half the wall. Folded, the row
    // says the file once and by its name; the whole path is on the cards
    // inside, which are drawn only once the group is opened.
    expect(html()).not.toContain("/Users/k/octiq/web/src/lib");
  });
});
