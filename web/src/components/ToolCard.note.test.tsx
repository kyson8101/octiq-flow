// Card 73 — a fenced block that follows a tool call, drawn inside that card.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { Tool } from "../lib/toolGroups";
import { ToolCard } from "./ToolCard";

const bash = (over: Partial<Tool> = {}): Tool =>
  ({
    kind: "tool",
    id: "t1",
    name: "Bash",
    argsJson: "{}",
    args: { command: "cargo test" },
    state: "done",
    ...over,
  }) as Tool;

const note = { lang: "", body: "VERIFY RESULT: PASS" };

describe("a tool card carrying a note", () => {
  it("draws the note inside the card", () => {
    const html = renderToStaticMarkup(<ToolCard tool={bash()} note={note} open />);

    expect(html).toContain("VERIFY RESULT: PASS");
  });

  it("never labels it as the tool's result", () => {
    // The text is the AGENT'S prose. A code block after a Bash call can be
    // anything — a snippet being proposed, an unrelated example — so calling it
    // "result" would make the card claim the command produced it.
    const html = renderToStaticMarkup(<ToolCard tool={bash()} note={note} open />);

    expect(html).not.toContain(">result<");
    expect(html).toContain("note");
  });

  it("still draws the tool's own result beside it, when there is one", () => {
    const html = renderToStaticMarkup(
      <ToolCard tool={bash({ result: "test result: ok. 33 passed" })} note={note} open />,
    );

    expect(html).toContain("33 passed");
    expect(html).toContain("VERIFY RESULT: PASS");
  });

  it("is unchanged when there is no note", () => {
    const html = renderToStaticMarkup(<ToolCard tool={bash()} open />);

    expect(html).not.toContain("tool-note-body");
  });
});
