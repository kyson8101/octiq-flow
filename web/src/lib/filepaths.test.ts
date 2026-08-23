// Finding the file paths in a reply, so they can be clicked.
//
// Every case here is a false positive waiting to happen: an agent writes prose
// full of dotted words, and a link that opens nothing is worse than plain text.
// So this file is mostly about what must NOT be picked up.
import { describe, expect, it } from "vitest";

import { PATH_TAG, pathRuns, rehypeFilePaths } from "./filepaths";

type Node = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
};

const text = (value: string): Node => ({ type: "text", value });
const el = (tagName: string, ...children: Node[]): Node => ({
  type: "element",
  tagName,
  properties: {},
  children,
});

/** A document, the shape the plugin is handed one. */
const run = (...children: Node[]): Node => {
  const tree: Node = { type: "root", children };
  rehypeFilePaths()(tree);
  return tree;
};

describe("pathRuns", () => {
  it("cuts a path out of the words around it", () => {
    expect(pathRuns("see web/src/lib/files.ts for it")).toEqual([
      { text: "see " },
      { text: "web/src/lib/files.ts", path: "web/src/lib/files.ts" },
      { text: " for it" },
    ]);
  });

  it("leaves the sentence's full stop out of the path", () => {
    expect(pathRuns("it is in src/main.rs.")).toEqual([
      { text: "it is in " },
      { text: "src/main.rs", path: "src/main.rs" },
      { text: "." },
    ]);
  });

  it("keeps a line number in the words but not in the path to open", () => {
    expect(pathRuns("src/pty.rs:120 is the spot")).toEqual([
      { text: "src/pty.rs:120", path: "src/pty.rs" },
      { text: " is the spot" },
    ]);
  });

  it("takes a bare filename, which is how a reply usually names one", () => {
    expect(pathRuns("I changed package.json")).toEqual([
      { text: "I changed " },
      { text: "package.json", path: "package.json" },
    ]);
  });

  it("is not fooled by a version number", () => {
    expect(pathRuns("bumped to 1.2.3 today")).toEqual([{ text: "bumped to 1.2.3 today" }]);
  });

  it("leaves a folder alone — it exists, and nothing can open it", () => {
    expect(pathRuns("look in web/src/lib for it")).toEqual([
      { text: "look in web/src/lib for it" },
    ]);
  });

  it("gives plain words back as one run", () => {
    expect(pathRuns("nothing to see here")).toEqual([{ text: "nothing to see here" }]);
  });
});

describe("rehypeFilePaths", () => {
  it("marks a path in a paragraph", () => {
    const tree = run(el("p", text("open src/main.rs now")));
    const kids = tree.children![0].children!;
    expect(kids.map((k) => k.tagName ?? k.value)).toEqual(["open ", PATH_TAG, " now"]);
    expect(kids[1].properties).toEqual({ path: "src/main.rs" });
    expect(kids[1].children).toEqual([{ type: "text", value: "src/main.rs" }]);
  });

  it("turns inline code that IS a path into one, keeping it code", () => {
    const tree = run(el("p", el("code", text("web/src/App.tsx"))));
    const marked = tree.children![0].children![0];
    expect(marked.tagName).toBe(PATH_TAG);
    expect(marked.properties).toEqual({ path: "web/src/App.tsx", code: "1" });
  });

  it("leaves inline code that is not a path alone", () => {
    const tree = run(el("p", el("code", text("pnpm test"))));
    expect(tree.children![0].children![0].tagName).toBe("code");
  });

  it("leaves a code BLOCK entirely alone", () => {
    const tree = run(el("pre", el("code", text("cat src/main.rs"))));
    const code = tree.children![0].children![0];
    expect(code.children![0]).toEqual({ type: "text", value: "cat src/main.rs" });
  });

  it("does not touch a link's words — it is already somewhere to go", () => {
    const tree = run(el("p", el("a", text("docs/readme.md"))));
    expect(tree.children![0].children![0].children![0]).toEqual({
      type: "text",
      value: "docs/readme.md",
    });
  });
});
