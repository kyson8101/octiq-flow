// What an edit did to a file, as numbered lines.
//
// The agent announces a file change twice and neither half is the whole story.
// The tool call carries the arguments — the old text and the new one — which
// say WHAT changed but not where in the file it landed. The result carries a
// `structuredPatch`: real hunks with real line numbers, but only once the edit
// has actually happened.
//
// So both are read, in that order of trust:
//
//   structuredPatch   the file's own numbering, exact          (after the edit)
//   type: "create"    a new file — every line is line N of N   (after)
//   old/new string    the change with no idea where it sits    (before, or if
//                                                               the agent sent
//                                                               no patch)
//
// The last of those is what a permission question has to work with: it is asked
// BEFORE the tool runs, so there is no patch to read and no file to count
// against. A diff built that way is marked `numbered: false` and drawn without
// a line-number gutter, because inventing numbers for it would put a specific,
// checkable, wrong claim on screen — worse than admitting the offset is not
// known yet.

export type RowKind = "ctx" | "add" | "del" | "gap";

export type DiffRow = {
  kind: RowKind;
  /** The line's number in the file BEFORE the edit. Missing on an added line,
   *  and on every line of a diff built from the arguments alone. */
  old?: number;
  /** Its number in the file after. Missing on a removed line. */
  new?: number;
  text: string;
};

export type FileDiff = {
  path: string;
  /** A file that did not exist a moment ago, or a change to one that did. */
  kind: "create" | "edit";
  rows: DiffRow[];
  added: number;
  removed: number;
  /** True when `old`/`new` are the file's real line numbers. */
  numbered: boolean;
};

/** The tools whose whole job is to change a file. `update` is here because it
 *  is what the agent's own terminal calls an Edit, and a name that reaches a
 *  reader should be one the code answers to as well. */
const FILE_TOOLS = new Set(["edit", "update", "write", "multiedit", "applypatch", "notebookedit"]);

export function isFileTool(name: string): boolean {
  return FILE_TOOLS.has((name || "").toLowerCase());
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The diff a card should draw for one tool call, or null when this call did
 *  not touch a file — or touched one in a way there is nothing to show for. */
export function fileDiff(name: string, args: unknown, details?: unknown): FileDiff | null {
  if (!isFileTool(name)) return null;
  const tool = (name || "").toLowerCase();
  const a = obj(args);
  const d = obj(details);
  const path = str(d.filePath) || str(a.file_path) || str(a.path) || str(a.notebook_path);

  const fromResult = patchDiff(path, d);
  if (fromResult) return fromResult;

  // Nothing has happened yet (the call is still running, or this is the
  // permission question in front of it), so the arguments are all there is.
  if (tool === "write") {
    const content = str(a.content);
    if (!content) return null;
    return whole(path, content, "create");
  }
  if (tool === "multiedit") return multiDiff(path, a);

  const before = str(a.old_string);
  const after = str(a.new_string);
  if (!before && !after) return null;
  return count({ path, kind: "edit", rows: lineDiff(split(before), split(after)), numbered: false });
}

/** The agent's own patch: hunk by hunk, each line already marked. */
function patchDiff(path: string, d: Json): FileDiff | null {
  const created = str(d.type) === "create";
  const patch = Array.isArray(d.structuredPatch) ? d.structuredPatch : null;
  if (!patch) return null;

  // A brand-new file has no hunks — there is no before to diff against — so
  // the whole content is the diff, and it starts at line 1.
  if (!patch.length) {
    if (created) return whole(path, str(d.content), "create");
    // An `update` that produced no hunks wrote the file with the same bytes it
    // already held. Saying so is the point: an empty diff is a real answer.
    return { path, kind: "edit", rows: [], added: 0, removed: 0, numbered: true };
  }

  const rows: DiffRow[] = [];
  let prevEnd = 0;
  for (const raw of patch) {
    const hunk = obj(raw);
    let o = num(hunk.oldStart) || 1;
    let n = num(hunk.newStart) || 1;
    // The lines between two hunks are unchanged and not sent. How many were
    // skipped is worth a row of its own: without it, a jump in the numbering
    // reads as the diff having lost its place.
    if (rows.length) rows.push({ kind: "gap", text: gapText(n - prevEnd) });
    for (const line of (Array.isArray(hunk.lines) ? hunk.lines : []).map(str)) {
      // "\ No newline at end of file" is a note about the file, not a line in
      // it, and drawing it as one adds a line that does not exist.
      if (line.startsWith("\\")) continue;
      const text = line.slice(1);
      if (line.startsWith("+")) rows.push({ kind: "add", new: n++, text });
      else if (line.startsWith("-")) rows.push({ kind: "del", old: o++, text });
      else rows.push({ kind: "ctx", old: o++, new: n++, text });
    }
    prevEnd = n;
  }
  return count({ path, kind: created ? "create" : "edit", rows, numbered: true });
}

function gapText(skipped: number): string {
  if (skipped <= 0) return "⋯";
  return `⋯ ${skipped} unchanged line${skipped === 1 ? "" : "s"}`;
}

/** A whole file as one block of added lines, numbered from 1. */
function whole(path: string, content: string, kind: FileDiff["kind"]): FileDiff {
  const lines = split(content);
  return count({
    path,
    kind,
    rows: lines.map((text, i) => ({ kind: "add" as const, new: i + 1, text })),
    numbered: true,
  });
}

/** MultiEdit before it runs: several edits to one file, each with its own
 *  before and after, and no idea where any of them lands. */
function multiDiff(path: string, a: Json): FileDiff | null {
  const edits = Array.isArray(a.edits) ? a.edits : [];
  if (!edits.length) return null;
  const rows: DiffRow[] = [];
  for (const raw of edits) {
    const e = obj(raw);
    if (rows.length) rows.push({ kind: "gap", text: "⋯" });
    rows.push(...lineDiff(split(str(e.old_string)), split(str(e.new_string))));
  }
  return count({ path, kind: "edit", rows, numbered: false });
}

/** Text into lines, without the phantom last line a trailing newline makes. */
function split(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Above this many cells the table below costs more than the answer is worth,
 *  and the honest fallback — the old block out, the new block in — is what a
 *  reader takes from a wall of changed lines anyway. */
const MAX_CELLS = 400_000;

/** The longest common subsequence of two line lists, walked back into rows.
 *
 *  This is the classic table rather than anything cleverer: the strings an Edit
 *  carries are a handful of lines, and a diff nobody can point at a bug in is
 *  worth more here than one that is fast on input this never sees. */
export function lineDiff(before: string[], after: string[]): DiffRow[] {
  const n = before.length;
  const m = after.length;
  if (!n) return after.map((text) => ({ kind: "add" as const, text }));
  if (!m) return before.map((text) => ({ kind: "del" as const, text }));
  if (n * m > MAX_CELLS) {
    return [
      ...before.map((text) => ({ kind: "del" as const, text })),
      ...after.map((text) => ({ kind: "add" as const, text })),
    ];
  }

  // lcs[i][j] = the length of the longest common run of before[i…] / after[j…],
  // held flat because a table of arrays for this is all overhead.
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] =
        before[i] === after[j]
          ? lcs[(i + 1) * w + j + 1] + 1
          : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      rows.push({ kind: "ctx", text: before[i] });
      i++;
      j++;
    } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
      rows.push({ kind: "del", text: before[i++] });
    } else {
      rows.push({ kind: "add", text: after[j++] });
    }
  }
  while (i < n) rows.push({ kind: "del", text: before[i++] });
  while (j < m) rows.push({ kind: "add", text: after[j++] });
  return rows;
}

function count(d: Omit<FileDiff, "added" | "removed">): FileDiff {
  let added = 0;
  let removed = 0;
  for (const r of d.rows) {
    if (r.kind === "add") added++;
    if (r.kind === "del") removed++;
  }
  return { ...d, added, removed };
}
