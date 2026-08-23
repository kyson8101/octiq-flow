import { describe, expect, it } from "vitest";
import { formatQuote, lineRange } from "./quote";

describe("lineRange", () => {
  it("numbers lines from one", () => {
    expect(lineRange("a\nb\nc", 0, 1)).toEqual({ from: 1, to: 1 });
  });

  it("spans the lines a selection touches", () => {
    expect(lineRange("a\nb\nc", 2, 5)).toEqual({ from: 2, to: 3 });
  });

  // Dragging to the end of a line puts the caret past its newline, which is on
  // the NEXT line. Counting that line in would quote one more than was
  // highlighted, every single time.
  it("does not count a line the selection only reaches the start of", () => {
    expect(lineRange("a\nb\nc", 0, 2)).toEqual({ from: 1, to: 1 });
  });

  it("keeps an empty selection on its own line", () => {
    expect(lineRange("a\nb\nc", 2, 2)).toEqual({ from: 2, to: 2 });
  });
});

describe("formatQuote", () => {
  const q = { path: "/work/app/web/src/a.ts", text: "const x = 1;", from: 12, to: 12 };

  it("writes the path relative to the project, with the line and a fence", () => {
    expect(formatQuote(q, "/work/app")).toBe("web/src/a.ts:12\n```ts\nconst x = 1;\n```\n\n");
  });

  it("writes a range when the selection covers several lines", () => {
    expect(formatQuote({ ...q, to: 14 }, "/work/app")).toStrictEqual(
      "web/src/a.ts:12-14\n```ts\nconst x = 1;\n```\n\n",
    );
  });

  it("leaves the path alone when it is not under the project", () => {
    expect(formatQuote(q, "/somewhere/else")).toContain("/work/app/web/src/a.ts:12\n");
  });

  it("names no line when the line is not known", () => {
    expect(formatQuote({ ...q, from: 0, to: 0 }, "/work/app")).toContain("web/src/a.ts\n```ts\n");
  });

  // A fence inside the text would close the block early and the rest of the
  // quote would land in the message as prose.
  it("uses a longer fence when the text has one of its own", () => {
    const out = formatQuote({ ...q, text: "```\nhi\n```" }, "/work/app");
    expect(out).toBe("web/src/a.ts:12\n````ts\n```\nhi\n```\n````\n\n");
  });

  it("has no language tag for a file it cannot name", () => {
    expect(formatQuote({ ...q, path: "/work/app/NOTES" }, "/work/app")).toBe(
      "NOTES:12\n```\nconst x = 1;\n```\n\n",
    );
  });
});
