// What the page reads into the island from the rest of the app: what each
// agent's robot should be doing, from the app's one reading of the agents
// (`agentRoster`), and the words a new chat is handed to grant a wish.
// Pure, so both are tests.
import type { AgentRow } from "../agentsDashboard";
import type { Wish } from "./model";
import type { AgentMode } from "./sim";

/** A turn in flight is work at its desk, a card is a hand up, a failure is
 *  trouble; anything else (idle, queued, blocked on someone else) is a free
 *  robot doing as it likes. A free one says how long it has had nothing,
 *  from the newest thing the roster saw it touch: only how bored its robot
 *  starts out, so a host clock a few minutes off this page's moves nothing
 *  that matters. */
export function agentModes(rows: readonly AgentRow[], now = Date.now()): Map<string, AgentMode> {
  const modes = new Map<string, AgentMode>();
  for (const row of rows) {
    const title = (state: AgentRow["state"]) => row.activities.find((a) => a.state === state)?.title;
    const mode: AgentMode = row.state === "working" ? { state: "working", label: title("working") }
      : row.state === "needs_you" ? { state: "needs_you", label: title("needs_you") }
      : row.state === "failed" ? { state: "failed", label: title("failed") }
      : { state: "free", ...(row.recent ? { idleFor: Math.max(0, Math.round((now - row.recent.at) / 60000)) } : {}) };
    modes.set(`agent:${row.id}`, mode);
  }
  return modes;
}

/** The message a new chat is handed to grant a wish: the host's (`brief`),
 *  or, from a host that sends none, the same sentences made here. */
export function grantBrief(wish: Wish, name: string): string {
  if (wish.brief?.trim()) return wish.brief;
  const kind = wish.want === "accessory" && wish.slot ? `an accessory for the ${wish.slot} slot`
    : wish.want === "look" ? "a new look"
    : `a ${wish.want}`;
  return `Grant ${name}'s wish on the OctiqFlow island: ${name} wishes for ${wish.text}. (wish ${wish.id})\n`
    + `Call island_look with this wish id to see ${name}, build ${kind} with island_build, then give it with island_grant.`;
}

/** "3 min ago", from the page's own clock. */
export function ago(at: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - at) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
