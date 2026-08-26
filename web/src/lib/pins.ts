// The files worth opening, chosen by the agent rather than guessed at.
//
// This column used to be a SCRAPER. It read every path-shaped word out of the
// transcript — tool arguments and prose both — asked the backend which of them
// existed, and listed the survivors newest-first. It worked, and it answered
// the wrong question: "what did this chat touch" is a log, and a log of forty
// files is a thing nobody opens. What you actually want to know is which two
// of them to read, and the only party in the conversation who knows that is
// the agent.
//
// So the agent says. `pin_file` (scripts/mcp) takes a path, one line of why,
// and optionally the line to land on. Like `todo_write`, it calls nothing —
// the tool call itself travels down the chat stream, and this file reads the
// newest one back out of it. Nothing to fetch, nothing to store, and it
// survives a reload for free because the transcript does.
//
// There are TWO kinds of row, and the difference is who decided:
//
//   * **pinned** — the agent called `pin_file`. Carries a reason, sorts first,
//     and keeps the agent's own order, because it ranked them.
//   * **changed** — the agent ran `Write` or `Edit` on it. Nobody had to ask:
//     altering a file IS a claim that it matters. This is what stops the column
//     being empty in the ordinary case where the agent never pinned anything,
//     and it is the half a scraper got right.
//
// A file the agent only READ appears nowhere unless it was pinned. That is the
// whole point of the change: reading is how an agent looks around, and looking
// around is not news.
import type { Message } from "./chat";

/** Both spellings of our tool: through MCP, and bare. */
const PIN_TOOLS = new Set(["mcp__octiq__pin_file", "pin_file"]);

/** Tools that CHANGE a file on disk, as opposed to looking at one. Lowercased
 *  at the point of comparison, so a provider that spells them differently in
 *  case still matches. */
const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "notebookedit", "apply_patch"]);

/** Tool argument fields that hold the path a write went to. */
const PATH_KEYS = ["file_path", "filePath", "path", "notebook_path", "target_file"];

/** How many rows the column holds. Past two dozen it has stopped being "what
 *  to read" and gone back to being the log this file replaced. Explicit pins
 *  are counted first, so a well-pinned chat never loses one to a flood of
 *  edits. */
const MAX_PINS = 25;

export type PinKind = "pinned" | "changed";

export type Pin = {
  /** As the agent gave it: absolute, or relative to the project root. Resolved
   *  against the filesystem by the panel, which drops what does not exist. */
  path: string;
  /** One line on why it is worth opening. Only ever set on a `pinned` row —
   *  nobody wrote a reason for a file that was merely edited. */
  why?: string;
  /** The line to land on, when one place in the file is the point. */
  line?: number;
  kind: PinKind;
};

export function pinPaths(pins: Pin[]): string[] {
  return pins.map((p) => p.path);
}

/**
 * The column, as it should look right now.
 *
 * Explicit pins first, in the agent's own order; then the files it changed,
 * newest first. A path in both appears once, as the pin — both facts are true
 * and the reason is the half worth keeping.
 */
export function latestPins(messages: Message[]): Pin[] {
  const pinned = newestPinCall(messages);
  const seen = new Set(pinned.map((p) => p.path));
  const out = [...pinned];

  for (const path of changedPaths(messages)) {
    if (out.length >= MAX_PINS) break;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ path, kind: "changed" });
  }
  return out.slice(0, MAX_PINS);
}

/** The newest `pin_file` call in the conversation, read as a list.
 *
 *  Backwards, and only from the MAIN agent's turns: a subagent pins what
 *  mattered to the one errand it was given, and letting that through would
 *  replace the column with one step of the work.
 *
 *  A call still being written has no arguments yet, and is stepped over rather
 *  than read as an empty list — the column stays up instead of blinking out
 *  and in again while the new one arrives. An EMPTY list IS a real answer,
 *  though: `readPins` gives [] for that and null only for "nothing to read". */
function newestPinCall(messages: Message[]): Pin[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.parent) continue;
    for (let j = message.blocks.length - 1; j >= 0; j -= 1) {
      const block = message.blocks[j];
      if (block.kind !== "tool") continue;
      if (!PIN_TOOLS.has(block.name.toLowerCase())) continue;
      const pins = readPins(block.args);
      if (pins) return pins;
    }
  }
  return [];
}

function readPins(args: unknown): Pin[] | null {
  if (!args || typeof args !== "object") return null;
  const raw = (args as { files?: unknown }).files;
  if (!Array.isArray(raw)) return null;
  const out: Pin[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as { path?: unknown; why?: unknown; line?: unknown };
    const path = typeof row.path === "string" ? row.path.trim() : "";
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const why = typeof row.why === "string" ? row.why.trim() : "";
    // A line number is only kept when it is one — a string, a float or a
    // negative would open the file somewhere surprising, and no anchor at all
    // is the better failure.
    const line = typeof row.line === "number" && Number.isInteger(row.line) && row.line > 0
      ? row.line
      : undefined;
    out.push({ path, kind: "pinned", ...(why ? { why } : {}), ...(line ? { line } : {}) });
  }
  return out;
}

/** Every file the conversation WROTE to, newest first.
 *
 *  Subagents count here, unlike pins. A pin is an opinion about what to read,
 *  and a subagent's opinion is about its own errand; an edit is not an opinion
 *  at all. A subagent that rewrote a file rewrote YOUR file, and leaving it out
 *  of the column would be a lie about what happened. */
function changedPaths(messages: Message[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    for (let j = messages[i].blocks.length - 1; j >= 0; j -= 1) {
      const block = messages[i].blocks[j];
      if (block.kind !== "tool") continue;
      if (!WRITE_TOOLS.has(bareName(block.name))) continue;
      const path = writtenPath(block.args);
      if (!path || seen.has(path)) continue;
      seen.add(path);
      out.push(path);
      if (out.length >= MAX_PINS) return out;
    }
  }
  return out;
}

/** A tool's name without whatever namespace it arrived under: an MCP server
 *  offering its own `Edit` reaches us as `mcp__thing__Edit`. */
function bareName(name: string): string {
  const cut = name.lastIndexOf("__");
  return (cut >= 0 ? name.slice(cut + 2) : name).toLowerCase();
}

function writtenPath(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const row = args as Record<string, unknown>;
  for (const key of PATH_KEYS) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}
