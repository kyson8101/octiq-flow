// The files worth opening — read back out of the transcript.
import { describe, expect, it } from "vitest";

import type { Block, Message } from "./chat";
import { latestPins, pinPaths } from "./pins";

let n = 0;
const uid = () => `x${(n += 1)}`;

function pin(files: unknown, name = "mcp__octiq__pin_file"): Block {
  return {
    kind: "tool",
    id: uid(),
    name,
    argsJson: JSON.stringify({ files }),
    args: { files },
    state: "done",
  };
}

/** A write/edit call, which pins its own file without being asked. */
function wrote(path: string, name = "Edit"): Block {
  return {
    kind: "tool",
    id: uid(),
    name,
    argsJson: JSON.stringify({ file_path: path }),
    args: { file_path: path },
    state: "done",
  };
}

const turn = (blocks: Block[], parent?: string): Message => ({
  id: uid(),
  role: "assistant",
  blocks,
  streaming: false,
  ...(parent ? { parent } : {}),
});

describe("latestPins", () => {
  it("finds nothing in a conversation that pinned nothing", () => {
    expect(latestPins([turn([{ kind: "text", text: "hello" }])])).toEqual([]);
  });

  it("keeps the reason and the line the agent gave", () => {
    const messages = [
      turn([pin([{ path: "src/a.ts", why: "the retry loop", line: 40 }])]),
    ];
    expect(latestPins(messages)).toEqual([
      { path: "src/a.ts", why: "the retry loop", line: 40, kind: "pinned" },
    ]);
  });

  it("takes the NEWEST pin list, not the first — a later call replaces it", () => {
    const messages = [
      turn([pin([{ path: "old.ts" }])]),
      turn([pin([{ path: "new.ts" }])]),
    ];
    expect(pinPaths(latestPins(messages))).toEqual(["new.ts"]);
  });

  it("lets an empty list clear the column", () => {
    // An empty array is a real answer — "nothing is worth reading now" — and
    // it has to beat the list before it rather than being read as "no call".
    const messages = [turn([pin([{ path: "old.ts" }])]), turn([pin([])])];
    expect(latestPins(messages)).toEqual([]);
  });

  it("keeps the previous list while a new call is still being written", () => {
    // A call mid-stream has no arguments yet. Blinking the column out and back
    // in on every pin is the thing this guards against.
    const half: Block = {
      kind: "tool",
      id: uid(),
      name: "mcp__octiq__pin_file",
      argsJson: "",
      args: undefined,
      state: "running",
    };
    const messages = [turn([pin([{ path: "kept.ts" }])]), turn([half])];
    expect(pinPaths(latestPins(messages))).toEqual(["kept.ts"]);
  });

  it("ignores a subagent's pins", () => {
    // A subagent pins what mattered to its own errand. Letting that through
    // would replace the column with one step of the work.
    const messages = [
      turn([pin([{ path: "the-point.ts" }])]),
      turn([pin([{ path: "an-errand.ts" }])], "task-1"),
    ];
    expect(pinPaths(latestPins(messages))).toEqual(["the-point.ts"]);
  });

  it("drops rows with no path and coerces a line it cannot read", () => {
    const messages = [
      turn([
        pin([
          { path: "   " },
          { path: "real.ts", line: "nonsense" },
          { path: "zero.ts", line: 0 },
          "not an object",
          null,
        ]),
      ]),
    ];
    expect(latestPins(messages)).toEqual([
      { path: "real.ts", kind: "pinned" },
      { path: "zero.ts", kind: "pinned" },
    ]);
  });

  it("de-dups a path pinned twice, keeping the first reason", () => {
    const messages = [
      turn([pin([{ path: "a.ts", why: "first" }, { path: "a.ts", why: "second" }])]),
    ];
    expect(latestPins(messages)).toEqual([{ path: "a.ts", why: "first", kind: "pinned" }]);
  });
});

describe("latestPins — files the agent changed", () => {
  it("pins what Write and Edit touched, without being asked", () => {
    // Changing a file IS the agent saying it matters. This is what keeps the
    // column from being empty in the common case where nothing was pinned.
    const messages = [turn([wrote("/repo/a.rs", "Write"), wrote("/repo/b.ts", "Edit")])];
    expect(latestPins(messages)).toEqual([
      { path: "/repo/b.ts", kind: "changed" },
      { path: "/repo/a.rs", kind: "changed" },
    ]);
  });

  it("does not pin a file it merely READ", () => {
    expect(latestPins([turn([wrote("/repo/a.rs", "Read")])])).toEqual([]);
  });

  it("puts explicit pins above changed files", () => {
    const messages = [
      turn([wrote("/repo/changed.ts")]),
      turn([pin([{ path: "/repo/read-this.ts", why: "the cause" }])]),
    ];
    expect(pinPaths(latestPins(messages))).toEqual(["/repo/read-this.ts", "/repo/changed.ts"]);
  });

  it("an explicit pin wins over the same file being changed", () => {
    // Both are true; the reason is the half worth keeping.
    const messages = [
      turn([wrote("/repo/a.ts")]),
      turn([pin([{ path: "/repo/a.ts", why: "here is the bug" }])]),
    ];
    expect(latestPins(messages)).toEqual([
      { path: "/repo/a.ts", why: "here is the bug", kind: "pinned" },
    ]);
  });

  it("counts a subagent's edits — they changed the same tree", () => {
    // Unlike a pin, an edit is not an opinion about what to read. A subagent
    // that rewrote a file changed YOUR file, and hiding that is a lie.
    const messages = [turn([wrote("/repo/sub.ts")], "task-1")];
    expect(pinPaths(latestPins(messages))).toEqual(["/repo/sub.ts"]);
  });

  it("holds the newest changed files and no more", () => {
    const many = Array.from({ length: 40 }, (_, i) => wrote(`/repo/f${i}.ts`));
    const out = latestPins([turn(many)]);
    expect(out).toHaveLength(25);
    // Newest first: the last file written is the one at the top.
    expect(out[0].path).toBe("/repo/f39.ts");
  });
});
