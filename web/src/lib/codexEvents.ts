// What Codex sends, and what it means.
//
// The three agents that can sit in a room speak three different protocols, and
// the reducer only ever knew two of them:
//
//   a Claude seat   `assistant` + `stream_event`     — read
//   an on-demand    `assistant` + `result`           — read (we synthesise it)
//   CODEX           `thread.started` / `turn.started`
//                   / `item.started` / `item.completed`
//                   / `turn.completed`               — NOT READ AT ALL
//
// So Codex answered nine times in this project's own room and the screen showed
// nothing, once. Every event fell through the dispatch and was dropped. This
// module is the missing half: `codex exec --json`'s thread/item protocol,
// translated into the same handful of things the reducer already knows how to
// draw.
//
// Kept apart from `chat.ts` because it is the part that can be WRONG about a
// protocol nobody documented — the shapes here were read off a real captured
// turn (`__fixtures__/codex-seat.jsonl`), not guessed.

import type { ToolState } from "./chat";

export type CodexRead =
  /** Codex wrote something. It arrives whole — there are no deltas. */
  | { kind: "say"; text: string; phase?: "commentary" | "final_answer" }
  /** Codex ran something. `id` is stable across the started/completed pair. */
  | { kind: "tool"; id: string; name: string; args: unknown; state: ToolState; result?: string; details?: { exit_code: number } }
  /** The turn is over, so nothing may be left looking like it is still writing. */
  | { kind: "done" };

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** `in_progress` → running, `completed` → done, `failed` → error.
 *
 *  A `web_search` carries no status at all: it is started and then it is
 *  completed, and the event type is the only thing that says which. */
function runState(status: string, completed: boolean): ToolState {
  if (status === "failed") return "error";
  if (status === "completed") return "done";
  if (status === "in_progress") return "running";
  return completed ? "done" : "running";
}

/** Read one Codex content event, or `null` when it has no content to draw.
 *
 * `thread.started` names the session in the main reducer and `turn.started`
 * marks the optimistic user bubble as taken up there. Neither is a transcript
 * item, so neither becomes a `CodexRead` here. */
export function readCodexEvent(raw: unknown): CodexRead | null {
  const e = obj(raw);
  const type = str(e.type);

  if (type === "turn.completed") return { kind: "done" };
  if (type !== "item.started" && type !== "item.completed") return null;

  const item = obj(e.item);
  const id = str(item.id);
  if (!id) return null;
  const completed = type === "item.completed";
  const status = str(item.status);

  switch (str(item.type)) {
    // The reply itself. Only on `completed`: a started message has no text yet,
    // and drawing an empty one would put an blank bubble under the seat's name.
    case "agent_message": {
      const text = str(item.text).trim();
      const rawPhase = str(item.phase);
      const phase = rawPhase === "commentary" || rawPhase === "final_answer"
        ? rawPhase
        : undefined;
      return completed && text ? { kind: "say", text, ...(phase ? { phase } : {}) } : null;
    }

    // Keep the provider's own item type as the tool name. Tool names are
    // evidence: changing `command_execution` to a Claude-flavoured `Bash`
    // makes the transcript claim a different tool was called. `toolLook`
    // classifies it as a run for its icon and colour without renaming it.
    case "command_execution":
      return {
        kind: "tool",
        id,
        name: "command_execution",
        args: { command: str(item.command) },
        state: runState(status, completed),
        ...(completed ? { result: str(item.aggregated_output) } : {}),
        ...(completed && typeof item.exit_code === "number" && Number.isInteger(item.exit_code)
          ? { details: { exit_code: item.exit_code } } : {}),
      };

    // A write. `changes` is a list; the card shows the first path, which is
    // what the row has room for, and the rest are in the arguments. As above,
    // the name remains the one Codex emitted rather than being rewritten to
    // another provider's `Edit` tool.
    case "file_change": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const first = obj(changes[0]);
      return {
        kind: "tool",
        id,
        name: "file_change",
        args: { file_path: str(first.path), changes },
        state: runState(status, completed),
      };
    }

    case "web_search":
      return {
        kind: "tool",
        id,
        name: "web_search",
        args: { query: str(item.query) },
        state: runState(status, completed),
      };

    default:
      return null;
  }
}
