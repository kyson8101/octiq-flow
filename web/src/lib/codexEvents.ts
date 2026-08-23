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
  | { kind: "say"; text: string }
  /** Codex ran something. `id` is stable across the started/completed pair. */
  | { kind: "tool"; id: string; name: string; args: unknown; state: ToolState; result?: string }
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

/** Read one Codex event, or `null` when it is not one — which includes
 *  `thread.started` and `turn.started`, both of which say only that something is
 *  about to happen and draw nothing. */
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
      return completed && text ? { kind: "say", text } : null;
    }

    // Codex in the shell. Named `Bash` so it takes the icon, the colour and the
    // card every other shell call in this app already has — a reader scanning a
    // transcript is looking for "it ran something", not for whose protocol said
    // so.
    case "command_execution":
      return {
        kind: "tool",
        id,
        name: "Bash",
        args: { command: str(item.command) },
        state: runState(status, completed),
        ...(completed ? { result: str(item.aggregated_output) } : {}),
      };

    // A write. `changes` is a list; the card shows the first path, which is
    // what the row has room for, and the rest are in the arguments.
    case "file_change": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const first = obj(changes[0]);
      return {
        kind: "tool",
        id,
        name: "Edit",
        args: { file_path: str(first.path), changes },
        state: runState(status, completed),
      };
    }

    case "web_search":
      return {
        kind: "tool",
        id,
        name: "WebSearch",
        args: { query: str(item.query) },
        state: runState(status, completed),
      };

    default:
      return null;
  }
}
