// Holding the run column's place before the ledger has been read.
//
// Whether a chat has a run is the ledger's to say, and the ledger answers
// after the chat is on screen: a moment later the page split in two columns
// and everything already drawn jumped sideways. So the split is decided from
// what the page knows at first paint, and the ledger only fills it in.
//
// Four things say a chat has a run before the ledger does: the host says so
// on the chat's own entry (`coordinatesRun`, which the page reads with the
// chat list, before the ledger), the chat is a task chat (the reserved
// `orch-` id), a task chat is open beside it (the route or the remembered
// choice names one), or this browser saw the chat coordinate a run the last
// time it read the ledger. None of them decides anything but where the
// columns are: what a chat may do is still the ledger's, and a wrong guess
// is put right when it arrives.
//
// The first is the only one that covers a plain coordinating chat opened
// cold in a browser that has never seen it. A host that does not send the
// field leaves that one case as it was: the first cold open still splits
// the page once, when the ledger arrives.
import type { OrchestrationSnapshot } from "./orchestration";
import type { Beside } from "./chatBeside";

/** The reserved prefix of a worker chat's id (`chat:orch-…`). */
const WORKER = "orch-";

/** How many coordinating chats are remembered. One id each, newest first. */
export const KNOWN_KEPT = 120;

const idOf = (key: string): string | null => (key.startsWith("chat:") ? key.slice(5) || null : null);

/** The chats that coordinate a run, newest run first, once each. */
export function runChatIds(snapshot: Pick<OrchestrationSnapshot, "runs">): string[] {
  const seen = new Set<string>();
  for (const run of [...snapshot.runs].sort((a, b) => b.createdAt - a.createdAt)) {
    const id = idOf(run.coordinatorChatKey);
    if (id) seen.add(id);
    if (seen.size >= KNOWN_KEPT) break;
  }
  return [...seen];
}

/** What is written down, or `null` when it is what is already there. */
export function knownToStore(snapshot: Pick<OrchestrationSnapshot, "runs">, stored: string | null): string | null {
  const next = runChatIds(snapshot).join(",");
  return next === (stored ?? "") ? null : next;
}

export function parseKnown(stored: string | null): ReadonlySet<string> {
  return new Set((stored ?? "").split(",").filter(Boolean).slice(0, KNOWN_KEPT));
}

/** The task chat to hold a pane for while the ledger is unread: the
 *  person's own choice, for the chat on screen, when it names a task chat
 *  that exists here. Only a reserved worker id is trusted this far; such a
 *  chat takes no messages whatever the ledger turns out to say. */
export function besideHeld(beside: Beside | null, onScreen: string | null, exists: (id: string) => boolean): string | null {
  if (!beside || !onScreen || beside.main !== onScreen) return null;
  if (!beside.task.startsWith(WORKER) || beside.task === onScreen) return null;
  return exists(beside.task) ? beside.task : null;
}

/** Whether to hold the run column's place for this chat. Asked only until
 *  the ledger has been read (`ledgerRead`), and never once it could not be:
 *  from then on what the ledger says is what is drawn. */
export function holdsRunColumn(input: {
  ledgerRead: boolean;
  ledgerFailed: boolean;
  chatId: string | null;
  besideTask: string | null;
  known: ReadonlySet<string>;
  /** The chat's own entry says it coordinates a run (`coordinatesRun`).
   *  Absent on a host that does not say. */
  coordinates?: boolean;
}): boolean {
  if (input.ledgerRead || input.ledgerFailed || !input.chatId) return false;
  return input.coordinates === true || input.chatId.startsWith(WORKER) || !!input.besideTask || input.known.has(input.chatId);
}
