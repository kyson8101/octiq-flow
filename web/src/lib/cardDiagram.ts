// A card diagram an agent wrote into a reply.
//
// The format is ours, and small on purpose: a fenced code block whose info
// string is `octiq-diagram`, holding JSON
//
//   { "rows": [ [ { "title": "…", "note"?: "…", "icon"?: "…", "plain"?: true } ] ] }
//
// Rows run top to bottom with an arrow between them; the nodes of a row sit
// side by side. `plain` draws a node without a frame (a conclusion). The
// same words are told to agents where they get their host rules
// (`DIAGRAM_PROMPT` in agent_provider.rs, the MCP server's instructions);
// `cardDiagram.test.ts` reads both, so the two cannot drift.
//
// Everything here is the half that can be wrong, and none of it touches the
// page. What an agent writes is untrusted text: it may be huge, nested a
// thousand deep, the wrong type everywhere, or full of markup. So the reader
// answers a diagram or `null`, and `null` is drawn as the ordinary code block
// it also is. Nothing is repaired and nothing is cut to fit: a block over a
// limit is not a diagram. Every string stays a string; the renderer draws
// them as text.

/** The fence's info string. */
export const DIAGRAM_LANG = "octiq-diagram";

export const DIAGRAM_LIMITS = {
  rows: 8,
  nodes: 4,
  /** Unicode characters, after whitespace is collapsed. */
  title: 60,
  note: 120,
  /** UTF-16 units of the whole block. The largest block the limits above
   *  allow is well under this; past it nothing is parsed at all. */
  source: 16_000,
} as const;

/** The icons a node may name. An unknown or missing name draws none. */
export const DIAGRAM_ICONS = [
  "moon", "coffee", "screen", "user", "users", "server", "database", "file",
  "folder", "code", "terminal", "branch", "check", "cross", "alert", "clock",
  "lock", "key", "globe", "cloud", "bolt", "search", "message", "box",
] as const;

export type DiagramIcon = (typeof DIAGRAM_ICONS)[number];

export type DiagramNode = { title: string; note?: string; icon?: DiagramIcon; plain?: true };
export type Diagram = { rows: DiagramNode[][] };

const KNOWN: ReadonlySet<string> = new Set(DIAGRAM_ICONS);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A node's words: one line, whatever whitespace it was written with. `null`
 *  for anything but a string, a string with a control character in it, or
 *  one over its limit. */
function words(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  // Longer than any string that could pass, before any work is done on it.
  if (value.length > limit * 8) return null;
  const line = value.replace(/\s+/g, " ").trim();
  if (/[\u0000-\u001f\u007f]/.test(line)) return null;
  return [...line].length <= limit ? line : null;
}

function readNode(raw: unknown): DiagramNode | null {
  const bag = record(raw);
  if (!bag) return null;
  const title = words(bag.title, DIAGRAM_LIMITS.title);
  if (!title) return null;
  const node: DiagramNode = { title };
  if (bag.note !== undefined) {
    const note = words(bag.note, DIAGRAM_LIMITS.note);
    if (note === null) return null;
    if (note) node.note = note;
  }
  if (bag.icon !== undefined) {
    if (typeof bag.icon !== "string") return null;
    if (KNOWN.has(bag.icon)) node.icon = bag.icon as DiagramIcon;
  }
  if (bag.plain !== undefined) {
    if (typeof bag.plain !== "boolean") return null;
    if (bag.plain) node.plain = true;
  }
  return node;
}

function readRow(raw: unknown): DiagramNode[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > DIAGRAM_LIMITS.nodes) return null;
  const row: DiagramNode[] = [];
  for (const item of raw) {
    const node = readNode(item);
    if (!node) return null;
    row.push(node);
  }
  return row;
}

/** Read a block's body. `null` for anything that is not a whole, valid
 *  diagram within every limit. Never throws. */
export function parseDiagram(source: string): Diagram | null {
  if (typeof source !== "string" || source.length > DIAGRAM_LIMITS.source) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    // Not JSON, or nested past what the engine will parse.
    return null;
  }
  const bag = record(raw);
  if (!bag || !Array.isArray(bag.rows)) return null;
  if (bag.rows.length < 1 || bag.rows.length > DIAGRAM_LIMITS.rows) return null;
  const rows: DiagramNode[][] = [];
  for (const item of bag.rows) {
    const row = readRow(item);
    if (!row) return null;
    rows.push(row);
  }
  return { rows };
}

/** What a diagram is called to a reader who cannot see it: its titles, in
 *  order. */
export function diagramLabel(diagram: Diagram): string {
  const rows = diagram.rows.map((row) => row.map((node) => node.title).join(" and "));
  return `Diagram: ${rows.join(", then ")}`;
}

/* ---- The fence ----------------------------------------------------------- */

// A reply written with Windows line endings leaves a `\r` at the end of
// every line once it is split on `\n`: it is part of the line's end.
const OPENS = /^ {0,3}(`{3,}|~{3,})[ \t]*octiq-diagram[ \t]*\r?$/;
const CLOSES = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/;

/** A top-level markdown block (`lib/blocks.splitBlocks`) that is a diagram's
 *  fence: its body, and whether its closing fence has arrived. `null` for
 *  any other block. */
export function diagramFence(block: string): { body: string; closed: boolean } | null {
  // The opening line is short; a block that does not start with a fence
  // character is every paragraph of every reply.
  const first = block.charCodeAt(0);
  if (first !== 96 && first !== 126 && first !== 32) return null;
  const lines = block.split("\n");
  const open = OPENS.exec(lines[0]);
  if (!open) return null;
  for (let i = 1; i < lines.length; i += 1) {
    const close = CLOSES.exec(lines[i]);
    if (close && close[1][0] === open[1][0] && close[1].length >= open[1].length) {
      // Anything after the closer makes this more than a diagram's block.
      if (lines.slice(i + 1).some((line) => line.trim())) return null;
      return { body: lines.slice(1, i).join("\n"), closed: true };
    }
  }
  return { body: lines.slice(1).join("\n"), closed: false };
}

/** What a reply's block is drawn as, when it is a diagram's fence. */
export type DiagramBlock =
  | { kind: "diagram"; diagram: Diagram }
  /** Still being written: one quiet line, over the rows whole so far. */
  | { kind: "pending"; rows: DiagramNode[][] | null };

/** Read one top-level block of a reply. `null` is "draw it as the markdown
 *  it is": every block that is not a diagram's fence, and every fence that
 *  is not a whole, valid diagram.
 *
 *  Only a block that is CLOSED, parses and validates is a diagram. One still
 *  open is a quiet line while the reply is being written (`writing`), and an
 *  ordinary code block in a reply that ended without closing it. */
export function diagramBlock(block: string, writing: boolean): DiagramBlock | null {
  const fence = diagramFence(block);
  if (!fence) return null;
  if (fence.closed) {
    const diagram = parseDiagram(fence.body);
    return diagram ? { kind: "diagram", diagram } : null;
  }
  return writing ? { kind: "pending", rows: partialRows(fence.body) } : null;
}

/** The rows written so far in a body still being written, so the page can
 *  hold their height before the block resolves: every row that is whole,
 *  and the nodes that are whole of the row being written. `null` once a
 *  whole node or row is not a valid one (the block will be an ordinary code
 *  block), or when there is nothing to count yet.
 *
 *  Counted by the node and not only by the row, because the last row closes
 *  a few characters before the fence does: held only then, its height would
 *  arrive in the same delta as the diagram and move everything under it.
 *
 *  A scan, not a parse: it follows strings and brackets to find where each
 *  node of each row of `rows` closes, and reads only those. */
export function partialRows(body: string): DiagramNode[][] | null {
  if (body.length > DIAGRAM_LIMITS.source) return null;
  const rows: DiagramNode[][] = [];
  /** The nodes that are whole of the row still open, or `null` between rows. */
  let open: DiagramNode[] | null = null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let stringStart = 0;
  /** The last string read at depth 1: a key of the root object. */
  let key = "";
  let inRows = false;
  let nodeStart = -1;
  const written = () => {
    const all = open?.length ? [...rows, open] : rows;
    return all.length ? all : null;
  };
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') {
        inString = false;
        if (depth === 1) key = body.slice(stringStart + 1, i);
      }
      continue;
    }
    if (ch === '"') {
      // A row holds nodes and nothing else.
      if (depth === 3 && inRows) return null;
      inString = true;
      stringStart = i;
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth += 1;
      if (ch === "[" && depth === 2 && key === "rows") inRows = true;
      else if (!inRows) continue;
      else if (ch === "[" && depth === 3) {
        if (rows.length >= DIAGRAM_LIMITS.rows) return null;
        open = [];
      } else if (depth === 3) return null;
      else if (depth === 4 && ch === "{") nodeStart = i;
      else if (depth === 4) return null;
      continue;
    }
    if (ch === "}" || ch === "]") {
      if (inRows && depth === 4 && ch === "}" && nodeStart >= 0 && open) {
        let raw: unknown;
        try { raw = JSON.parse(body.slice(nodeStart, i + 1)); } catch { return null; }
        const node = readNode(raw);
        if (!node || open.length >= DIAGRAM_LIMITS.nodes) return null;
        open.push(node);
        nodeStart = -1;
      } else if (inRows && depth === 3 && ch === "]" && open) {
        if (!open.length) return null;
        rows.push(open);
        open = null;
      } else if (inRows && depth === 2 && ch === "]") return written();
      depth -= 1;
    }
  }
  return written();
}
