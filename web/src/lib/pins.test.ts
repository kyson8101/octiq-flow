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

/** A call that touched a file without pinning it — an edit, a read, a write. */
function touched(path: string, name = "Edit"): Block {
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

  it("keeps the label, the reason and the line the agent gave", () => {
    const messages = [
      turn([pin([{ path: "src/a.ts", label: "the bug", why: "the retry loop", line: 40 }])]),
    ];
    expect(latestPins(messages)).toEqual([
      { path: "src/a.ts", label: "the bug", why: "the retry loop", line: 40 },
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
    expect(latestPins(messages)).toEqual([{ path: "real.ts" }, { path: "zero.ts" }]);
  });

  it("de-dups a path pinned twice, keeping the first reason", () => {
    const messages = [
      turn([pin([{ path: "a.ts", why: "first" }, { path: "a.ts", why: "second" }])]),
    ];
    expect(latestPins(messages)).toEqual([{ path: "a.ts", why: "first" }]);
  });

  it("holds the newest pins and no more", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ path: `/repo/f${i}.ts` }));
    const out = latestPins([turn([pin(many)])]);
    expect(out).toHaveLength(25);
    // The agent's own order, cut from the end: it put the best first.
    expect(out[0].path).toBe("/repo/f0.ts");
  });
});

describe("latestPins — a pin is the only way in", () => {
  it("does not pin a file the agent merely CHANGED", () => {
    // The column is what to read, not what happened. An agent that wants an
    // edited file in front of the person pins it like anything else.
    const messages = [
      turn([touched("/repo/a.rs", "Write"), touched("/repo/b.ts", "Edit")]),
    ];
    expect(latestPins(messages)).toEqual([]);
  });

  it("does not pin a file it merely READ", () => {
    expect(latestPins([turn([touched("/repo/a.rs", "Read")])])).toEqual([]);
  });

  it("leaves a pinned file pinned even when it was also edited", () => {
    const messages = [
      turn([touched("/repo/a.ts")]),
      turn([pin([{ path: "/repo/a.ts", why: "here is the bug" }])]),
    ];
    expect(latestPins(messages)).toEqual([{ path: "/repo/a.ts", why: "here is the bug" }]);
  });
});

describe("latestPins — labels", () => {
  it("flattens a label and drops one that is only whitespace", () => {
    const messages = [
      turn([
        pin([
          { path: "a.ts", label: "  entry\n point  " },
          { path: "b.ts", label: "   " },
          { path: "c.ts", label: 7 },
        ]),
      ]),
    ];
    expect(latestPins(messages)).toEqual([
      { path: "a.ts", label: "entry point" },
      { path: "b.ts" },
      { path: "c.ts" },
    ]);
  });

  it("cuts a label that is really a sentence", () => {
    // 24 characters and an ellipsis. The whole thought belongs in `why`.
    const long = "the file where the retry loop swallows the error";
    const messages = [turn([pin([{ path: "a.ts", label: long }])])];
    expect(latestPins(messages)).toEqual([
      { path: "a.ts", label: "the file where the retry…" },
    ]);
  });
});

