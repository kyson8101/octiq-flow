// A chat that waits on the person does not look like it is running.
//
// The agent is already parked when it asks: the tool it called blocks until
// the card is answered. The page still held a turn in flight for it: a clock
// counting, "thinking…", the working mark on its row. So every surface that
// draws a turn in flight asks here first, and a chat that waits is drawn
// waiting: in `--decide`, still, with its clock stopped.
//
// This reads nothing of its own. Its input is the page's ONE reading of who
// is waited on (`lib/pendingActions`, which is `lib/runWaits` for the
// ledger's part): the same list the badges count. A new surface asks
// `waitingChats`; it does not go back to the cards or the ledger.
//
// There are three answers, not two. That list starts empty on a page that
// has just loaded, and "not read yet" is not "nothing waits": a chat whose
// checkpoint brought it back parked (`turnClock.restoredTurn`) is `unknown`
// until every source of the list has answered (`pendingActions.wholeOf`).
// It is then drawn as neither: no "thinking", no working mark, no "Needs
// you", and its clock stays where the checkpoint left it. A chat with no
// restored wait is never unknown: a turn that starts after the reload is
// drawn working at once.
import type { PendingAction, Whole } from "./pendingActions";

/** What the chat is parked on: a card it must be answered on, or one that
 *  approves something. */
export type ChatWait = "answer" | "approval";

/** A chat's answer when it is not "works": what it waits for, or that the
 *  page cannot say yet whether it waits. */
export type ChatHold = ChatWait | "unknown";

export const WAIT_WORDS: Record<ChatHold, string> = {
  answer: "Waiting for your answer",
  approval: "Waiting for your approval",
  unknown: "Checking what waits on you",
};

/** Whether the answer is that the chat waits on the person. `unknown` is
 *  not: nothing is asked of them that the page can name. */
export const asksPerson = (hold: ChatHold | null | undefined): hold is ChatWait => hold === "answer" || hold === "approval";

/** The chat a pending action parks, and how, or nothing.
 *
 *  Parked: the chat's own permission card or access request, its own
 *  question, its own safety card when that is the full card, and a plan
 *  waiting for approval in the chat that coordinates its run.
 *
 *  Not parked, though each is badged:
 *  - a worker's card drawn in its coordinator's chat parks the worker, whose
 *    chat the card names, and never the coordinator;
 *  - a gate waits in the run panel on a worker's task;
 *  - an auto-mode refusal the agent carried on past (`folded`) stopped
 *    nothing, and a safety-check outage did not judge the call: the agent
 *    goes on either way;
 *  - an answer that could not be delivered, and a handover to confirm, are
 *    not something a running tool call is blocked on. */
function parks(action: PendingAction, folded: ReadonlySet<string>): { chat: string; wait: ChatWait } | null {
  if (action.kind === "plan") return { chat: action.openChatId, wait: "approval" };
  if (!action.chatId || action.cardMissing) return null;
  if (action.kind === "permission") return { chat: action.chatId, wait: "approval" };
  if (action.kind === "question") return { chat: action.chatId, wait: "answer" };
  if (action.kind === "safety" && !folded.has(action.key)) return { chat: action.chatId, wait: "answer" };
  return null;
}

/** How much the list was read from, and the chats whose turn stands on a
 *  wait a checkpoint brought back (`turnClock.parkRestored`). */
export type Unsettled = { whole: Whole; restored: Iterable<string> };

/** Every chat that is not to be drawn working, with why: what it waits for,
 *  or `unknown`. `actions` come most urgent first (`pendingActions`), so a
 *  chat with a permission card and a question says the approval.
 *
 *  A card is a card however little has been read, so a chat a card parks
 *  waits. `unknown` is only a restored chat no card names while a source is
 *  still to answer: once all have (`read`), or no more are coming
 *  (`gaveUp`), a chat no card names does not wait. */
export function waitingChats(
  actions: readonly PendingAction[],
  folded: ReadonlySet<string> = NONE,
  unsettled: Unsettled = SETTLED,
): ReadonlyMap<string, ChatHold> {
  const waits = new Map<string, ChatHold>();
  for (const action of actions) {
    const parked = parks(action, folded);
    if (parked && !waits.has(parked.chat)) waits.set(parked.chat, parked.wait);
  }
  if (unsettled.whole === "unread") {
    for (const chat of unsettled.restored) if (!waits.has(chat)) waits.set(chat, "unknown");
  }
  return waits;
}

const SETTLED: Unsettled = { whole: "read", restored: [] };

/** What the clock is told of one chat (`turnClock.withWait`): it waits, it
 *  does not, or the page does not know. */
export function seenWait(waits: ReadonlyMap<string, ChatHold>, chat: string): boolean | "unknown" {
  const hold = waits.get(chat);
  return hold === "unknown" ? hold : hold !== undefined;
}

const NONE: ReadonlySet<string> = new Set();

/** The keys of the safety cards that are a folded line and not a card.
 *  Which those are is `safetyToast.splitSafety`'s rule and nobody else's (an
 *  auto-mode refusal in a chat whose turn is still running), so it is handed
 *  in as `split`. `turnRunning` is the turn itself, never this module's
 *  answer: a refusal the agent carried on past must not stop the display
 *  that says it carried on. */
export function foldedSafetyKeys<T extends { id: string }>(
  blocks: Readonly<Record<string, readonly T[] | undefined>>,
  turnRunning: (chatId: string) => boolean,
  split: (blocks: readonly T[], turnRunning: boolean) => { folded: readonly T[] },
): string[] {
  const keys: string[] = [];
  for (const [chatId, list] of Object.entries(blocks)) {
    if (!list?.length) continue;
    for (const block of split(list, turnRunning(chatId)).folded) keys.push(`safety:${block.id}`);
  }
  return keys.sort();
}

/** The chats to draw as working: a turn in flight that waits on nobody, and
 *  that the page knows to. */
export function workingChats(busy: ReadonlySet<string>, waits: ReadonlyMap<string, ChatHold>): Set<string> {
  const working = new Set<string>();
  for (const id of busy) if (!waits.has(id)) working.add(id);
  return working;
}
