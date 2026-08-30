// Where a run of file cards is, said once above them.
//
// Every case here is a case where the alternative is a header making a claim
// about files it does not sit above — which is worse than no header at all,
// because a reader who trusts it reads the wrong location for the right file.
import { describe, expect, it } from "vitest";

import type { Block } from "./chat";
import type { Row, Tool } from "./toolGroups";
import { baseOf, dirOf, filePath, folderLabel, rowFolder, rowFolders } from "./folderHead";

let n = 0;
const uid = () => `t${(n += 1)}`;

function tool(args: Record<string, unknown>, name = "Edit", details?: unknown): Tool {
  return {
    kind: "tool",
    id: uid(),
    name,
    argsJson: JSON.stringify(args),
    args,
    details,
    state: "done",
  } as Tool;
}

const file = (path: string, name = "Edit") => tool({ file_path: path }, name);
const row = (block: Block): Row => ({ kind: "block", block, index: 0 });
const text = (s: string): Row => row({ kind: "text", text: s } as Block);
const group = (tools: Tool[]): Row => ({
  kind: "group",
  tools: tools.slice(0, -1),
  newest: tools[tools.length - 1],
  index: 0,
});

describe("dirOf / baseOf", () => {
  it("splits a posix path", () => {
    expect(dirOf("/a/b/c.ts")).toBe("/a/b");
    expect(baseOf("/a/b/c.ts")).toBe("c.ts");
  });

  it("splits a windows path", () => {
    // A path in a transcript came from whatever machine the agent ran on.
    expect(dirOf("C:\\work\\app\\main.rs")).toBe("C:\\work\\app");
    expect(baseOf("C:\\work\\app\\main.rs")).toBe("main.rs");
  });

  it("gives a bare name no folder", () => {
    expect(dirOf("README.md")).toBe("");
    expect(baseOf("README.md")).toBe("README.md");
  });

  it("gives a file at the root no folder either", () => {
    // "/hosts" cuts at 0, and the empty string is not a folder anyone needs
    // announcing above a card.
    expect(dirOf("/hosts")).toBe("");
    expect(baseOf("/hosts")).toBe("hosts");
  });
});

describe("filePath", () => {
  it("reads the argument a file tool was called with", () => {
    expect(filePath(file("/a/b.ts"))).toBe("/a/b.ts");
    expect(filePath(tool({ path: "/a/c.ts" }, "Read"))).toBe("/a/c.ts");
    expect(filePath(tool({ notebook_path: "/a/d.ipynb" }, "NotebookEdit"))).toBe("/a/d.ipynb");
  });

  it("prefers what the call RESOLVED to over what it was asked for", () => {
    const t = tool({ file_path: "./rel.ts" }, "Edit", { filePath: "/abs/rel.ts" });
    expect(filePath(t)).toBe("/abs/rel.ts");
  });

  it("refuses everything that is not a path", () => {
    // The whole reason this is not `toolDetail`: that one falls back through
    // `command`, `pattern`, `query` and `url` to find something to show, and a
    // folder header built out of a shell command is nonsense.
    expect(filePath(tool({ command: "rg -n foo /etc" }, "Bash"))).toBe("");
    expect(filePath(tool({ pattern: "**/*.ts" }, "Glob"))).toBe("");
    expect(filePath(tool({ url: "https://example.com/a/b" }, "WebFetch"))).toBe("");
  });
});

describe("rowFolder", () => {
  it("names the folder of a single file card", () => {
    expect(rowFolder(row(file("/repo/web/src/chat.ts")))).toBe("/repo/web/src");
  });

  it("gives nothing for a row that is not a tool at all", () => {
    expect(rowFolder(text("some prose"))).toBe("");
  });

  it("names a folded run's folder when every call agrees", () => {
    expect(rowFolder(group([file("/a/b/one.ts"), file("/a/b/two.ts"), file("/a/b/three.ts")]))).toBe(
      "/a/b",
    );
  });

  it("refuses a folded run whose calls disagree", () => {
    // A header over a group is a claim about EVERY call in it. Taking the
    // majority's folder would file the odd one out under a place it was never
    // in — and the group's own tally already names the files.
    expect(rowFolder(group([file("/a/b/one.ts"), file("/a/b/two.ts"), file("/x/y/three.ts")]))).toBe(
      "",
    );
  });

  it("refuses a folded run holding anything that names no file", () => {
    expect(rowFolder(group([file("/a/b/one.ts"), tool({ command: "ls" }, "Bash")]))).toBe("");
  });
});

describe("rowFolders", () => {
  it("carries a folder across a run so only the first row heads it", () => {
    const rows = [row(file("/a/b/one.ts")), row(file("/a/b/two.ts")), row(file("/a/b/three.ts"))];
    expect(rowFolders(rows)).toEqual(["/a/b", "/a/b", "/a/b"]);
  });

  it("changes when the run moves somewhere else", () => {
    const rows = [row(file("/a/b/one.ts")), row(file("/x/y/two.ts"))];
    expect(rowFolders(rows)).toEqual(["/a/b", "/x/y"]);
  });

  it("breaks the run on a row that names no file", () => {
    // The header groups the cards DIRECTLY under it. Prose between two edits in
    // the same folder ends what it sits above, so coming back to that folder is
    // a new run and gets its own header — the caller draws one wherever the
    // answer differs from the row before, and "" differs from "/a/b".
    const rows = [row(file("/a/b/one.ts")), text("and then"), row(file("/a/b/two.ts"))];
    expect(rowFolders(rows)).toEqual(["/a/b", "", "/a/b"]);
  });
});

describe("folderLabel", () => {
  it("keeps the end of the path, not the whole of it", () => {
    // A transcript's paths are absolute, and a header reading the whole of one
    // is a line of chrome wider than anything it sits above.
    expect(folderLabel("/Users/someone/projects/thing/web/src/lib")).toBe("src/lib");
  });

  it("keeps TWO segments, because one is usually a word every repo uses", () => {
    // `src` over one run and `src` over another does not tell a reader the
    // location changed — it tells them it did not, which is the opposite of the
    // truth. These two are one segment apart and must not read as the same
    // place.
    expect(folderLabel("/repo/src-tauri/src")).toBe("src-tauri/src");
    expect(folderLabel("/repo/web/src")).toBe("web/src");
  });

  it("takes what there is when there is only one segment", () => {
    expect(folderLabel("lib")).toBe("lib");
    expect(folderLabel("/lib")).toBe("lib");
  });

  it("says a windows path the way the rest of the app does", () => {
    expect(folderLabel("C:\\work\\app\\src")).toBe("app/src");
  });
});
