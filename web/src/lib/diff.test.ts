// The diff builder, against the shapes the agent really sends.
//
// The `structuredPatch` payloads below are copied out of a captured stream
// rather than imagined: the field names, the leading space on a context line
// and the "\ No newline" note are all things that are easy to guess wrong and
// impossible to notice being wrong. The capture itself is kept — an Edit and a
// Write, recorded with the flag set `build_command` uses (agent_chat.rs) —
// and the last test here reads the payloads straight out of it, so a change in
// what the agent sends fails a test instead of quietly emptying a card:
//
//   printf '%s\n' '{"type":"user","message":{"role":"user","content":[
//       {"type":"text","text":"<prompt>"}]}}' \
//   | claude -p --output-format stream-json --input-format stream-json \
//           --include-partial-messages --replay-user-messages --verbose \
//           --model haiku --permission-mode acceptEdits
import { describe, expect, it } from "vitest";

import editStream from "./__fixtures__/file-edits.jsonl?raw";
import { fileDiff, lineDiff } from "./diff";

/** The result of an Edit that changed `beta` to `BETA` in a four-line file. */
const EDIT_RESULT = {
  filePath: "/tmp/f.txt",
  oldString: "beta",
  newString: "BETA",
  originalFile: "alpha\nbeta\ngamma\ndelta\n",
  structuredPatch: [
    { oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, lines: [" alpha", "-beta", "+BETA", " gamma", " delta"] },
  ],
  userModified: false,
  replaceAll: false,
};

/** The result of a Write that made a file that was not there. */
const CREATE_RESULT = {
  type: "create",
  filePath: "/tmp/g.txt",
  content: "hello\nworld",
  structuredPatch: [],
  originalFile: null,
  userModified: false,
};

/** The result of a Write over a file that already had something in it. */
const OVERWRITE_RESULT = {
  type: "update",
  filePath: "/tmp/f.txt",
  content: "alpha\nBETA two\ngamma",
  structuredPatch: [
    {
      oldStart: 1,
      oldLines: 4,
      newStart: 1,
      newLines: 3,
      lines: [" alpha", "-BETA", "-gamma", "-delta", "+BETA two", "+gamma", "\\ No newline at end of file"],
    },
  ],
  originalFile: "alpha\nBETA\ngamma\ndelta\n",
  userModified: false,
};

describe("fileDiff", () => {
  it("leaves tools that do not touch a file alone", () => {
    expect(fileDiff("Bash", { command: "ls" })).toBeNull();
    expect(fileDiff("Read", { file_path: "/tmp/f.txt" })).toBeNull();
  });

  it("numbers an edit from the agent's own patch", () => {
    const d = fileDiff("Edit", { file_path: "/tmp/f.txt", old_string: "beta", new_string: "BETA" }, EDIT_RESULT);
    expect(d).not.toBeNull();
    expect(d!.numbered).toBe(true);
    expect(d!.kind).toBe("edit");
    expect(d!.added).toBe(1);
    expect(d!.removed).toBe(1);
    expect(d!.rows).toEqual([
      { kind: "ctx", old: 1, new: 1, text: "alpha" },
      { kind: "del", old: 2, text: "beta" },
      { kind: "add", new: 2, text: "BETA" },
      { kind: "ctx", old: 3, new: 3, text: "gamma" },
      { kind: "ctx", old: 4, new: 4, text: "delta" },
    ]);
  });

  it("keeps the old numbering on a removed line and the new on an added one", () => {
    // The pair of columns is the whole point: a removed line's number belongs
    // to the file as it WAS, and mixing the two into one column is what makes a
    // correct diff read as a broken one.
    const d = fileDiff("Write", { file_path: "/tmp/f.txt" }, OVERWRITE_RESULT)!;
    const del = d.rows.filter((r) => r.kind === "del");
    const add = d.rows.filter((r) => r.kind === "add");
    expect(del.map((r) => r.old)).toEqual([2, 3, 4]);
    expect(del.every((r) => r.new === undefined)).toBe(true);
    expect(add.map((r) => r.new)).toEqual([2, 3]);
    expect(add.every((r) => r.old === undefined)).toBe(true);
  });

  it("drops the no-newline note instead of drawing it as a line", () => {
    const d = fileDiff("Write", { file_path: "/tmp/f.txt" }, OVERWRITE_RESULT)!;
    expect(d.rows.some((r) => r.text.startsWith("No newline"))).toBe(false);
    expect(d.rows).toHaveLength(6);
  });

  it("shows a new file as every line added, from line 1", () => {
    const d = fileDiff("Write", { file_path: "/tmp/g.txt", content: "hello\nworld" }, CREATE_RESULT)!;
    expect(d.kind).toBe("create");
    expect(d.numbered).toBe(true);
    expect(d.rows).toEqual([
      { kind: "add", new: 1, text: "hello" },
      { kind: "add", new: 2, text: "world" },
    ]);
  });

  it("says how many lines a hunk skipped", () => {
    const d = fileDiff(
      "Edit",
      { file_path: "/tmp/f.txt" },
      {
        filePath: "/tmp/f.txt",
        structuredPatch: [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [" one", "+two"] },
          { oldStart: 20, oldLines: 1, newStart: 21, newLines: 1, lines: ["-old", "+new"] },
        ],
      },
    )!;
    const gap = d.rows.find((r) => r.kind === "gap")!;
    expect(gap.text).toBe("⋯ 18 unchanged lines");
    expect(d.added).toBe(2);
    expect(d.removed).toBe(1);
  });

  it("calls a write that changed nothing an empty diff, not no diff", () => {
    const d = fileDiff("Write", { file_path: "/tmp/f.txt" }, { type: "update", filePath: "/tmp/f.txt", structuredPatch: [] })!;
    expect(d.rows).toEqual([]);
    expect(d.added + d.removed).toBe(0);
  });

  it("falls back to the arguments before the tool has run, and admits it", () => {
    // What a permission question has: the two strings, and no file to count
    // against. The rows are right; the line numbers are simply not claimed.
    const d = fileDiff("Edit", { file_path: "/tmp/f.txt", old_string: "a\nb\nc", new_string: "a\nB\nc" })!;
    expect(d.numbered).toBe(false);
    expect(d.rows.every((r) => r.old === undefined && r.new === undefined)).toBe(true);
    expect(d.rows.map((r) => `${r.kind}:${r.text}`)).toEqual(["ctx:a", "del:b", "add:B", "ctx:c"]);
  });

  it("previews a Write from its content alone", () => {
    const d = fileDiff("Write", { file_path: "/tmp/g.txt", content: "one\ntwo\n" })!;
    expect(d.rows.map((r) => r.text)).toEqual(["one", "two"]);
    expect(d.added).toBe(2);
  });

  it("previews a MultiEdit as one diff per edit", () => {
    const d = fileDiff("MultiEdit", {
      file_path: "/tmp/f.txt",
      edits: [
        { old_string: "a", new_string: "A" },
        { old_string: "z", new_string: "Z" },
      ],
    })!;
    expect(d.rows.filter((r) => r.kind === "gap")).toHaveLength(1);
    expect(d.added).toBe(2);
    expect(d.removed).toBe(2);
  });

  it("has nothing to draw for a call whose arguments have not arrived", () => {
    expect(fileDiff("Edit", {})).toBeNull();
    expect(fileDiff("Write", { file_path: "/tmp/g.txt" })).toBeNull();
  });
});

describe("the captured stream", () => {
  /** Every (tool name, arguments, structured result) the capture holds, paired
   *  the way the reducer pairs them: the call by its `tool_use` id, the result
   *  by the `tool_use_result` riding on the message that answers it. */
  function calls() {
    const uses = new Map<string, { name: string; args: unknown }>();
    const out: { name: string; args: unknown; details: unknown }[] = [];
    for (const line of editStream.split("\n")) {
      if (!line.trim().startsWith("{")) continue;
      const ev = JSON.parse(line) as Record<string, any>;
      for (const block of ev.message?.content ?? []) {
        if (block.type === "tool_use") uses.set(block.id, { name: block.name, args: block.input });
        if (block.type === "tool_result") {
          const use = uses.get(block.tool_use_id);
          if (use) out.push({ ...use, details: ev.tool_use_result });
        }
      }
    }
    return out;
  }

  it("draws the Edit and the Write in it, and nothing else", () => {
    const drawn = calls().map((c) => ({ name: c.name, diff: fileDiff(c.name, c.args, c.details) }));
    expect(drawn.filter((d) => d.diff).map((d) => d.name)).toEqual(["Edit", "Write"]);

    const edit = drawn.find((d) => d.name === "Edit")!.diff!;
    expect(edit.numbered).toBe(true);
    expect(edit.rows.map((r) => `${r.kind}:${r.old ?? ""}:${r.new ?? ""}`)).toEqual([
      "ctx:1:1",
      "del:2:",
      "add::2",
      "ctx:3:3",
      "ctx:4:4",
    ]);

    const write = drawn.find((d) => d.name === "Write")!.diff!;
    expect(write.kind).toBe("create");
    expect(write.rows.map((r) => r.text)).toEqual(["hello", "world"]);
  });
});

describe("lineDiff", () => {
  it("keeps the lines that did not move as context", () => {
    expect(lineDiff(["a", "b", "c"], ["a", "x", "c"]).map((r) => r.kind)).toEqual(["ctx", "del", "add", "ctx"]);
  });

  it("reads an insertion as an insertion, not as a rewrite of everything after it", () => {
    const rows = lineDiff(["a", "b"], ["a", "new", "b"]);
    expect(rows.map((r) => `${r.kind}:${r.text}`)).toEqual(["ctx:a", "add:new", "ctx:b"]);
  });

  it("handles an empty side", () => {
    expect(lineDiff([], ["a"]).map((r) => r.kind)).toEqual(["add"]);
    expect(lineDiff(["a"], []).map((r) => r.kind)).toEqual(["del"]);
  });
});
