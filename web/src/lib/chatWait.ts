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
// checkpoint brought it back parked (`turnClock.restoredTurn`) is held
// until every source of the list has been READ (`pendingActions.wholeOf`).
// It is then drawn as neither: no "thinking", no working mark, no "Needs
// you", and its clock stays where the checkpoint left it. A chat with no
// restored wait is never held: a turn that starts after the reload is
// drawn working at once.
//
// Held has two words, because the person can do something about one of
// them. `unknown`: a list is still out, and the page is checking.
// `unchecked`: no more is coming (a list failed twice, or said nothing for
// five minutes), so the page could not check, says so, and offers to ask
// again. Neither ends by itself on a guess: a list that failed says nothing
// of what waits, and only a read lets the chat go.
import type { PendingAction, Whole } from "./pendingActions";

/** What the chat is parked on: a card it must be answered on, or one that
 *  approves something. */
export type ChatWait = "answer" | "approval";

/** A chat's answer when it is not "works": what it waits for, or that the
 *  page cannot say whether it waits, because it is still checking
 *  (`unknown`) or because it could not (`unchecked`). */
export type ChatHold = ChatWait | "unknown" | "unchecked";

export const WAIT_WORDS: Record<ChatHold, string> = {
  answer: "Waiting for your answer",
  approval: "Waiting for your approval",
  unknown: "Checking what waits on you",
  unchecked: "Could not check what waits on you",
};

/** What the control beside `unchecked` says: it asks the lists again. */
export const RECHECK_LABEL = "Check again";

/** Whether the answer is that the chat waits on the person. The two held
 *  answers are not: nothing is asked of them that the page can name. */
export const asksPerson = (hold: ChatHold | null | undefined): hold is ChatWait => hold === "answer" || hold === "approval";

/** Whether the page cannot say if the chat waits: held, by either word. */
export const notKnown = (hold: ChatHold | null | undefined): hold is "unknown" | "unchecked" => hold === "unknown" || hold === "unchecked";

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
 *  waits. Held is only a restored chat no card names while the list is not
 *  wholly read: `unknown` while a source is still to answer, `unchecked`
 *  once no more are coming without asking again. Only when every source
 *  has been read (`read`) does a chat no card names not wait. */
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
  if (unsettled.whole !== "read") {
    const held = unsettled.whole === "unread" ? "unknown" : "unchecked";
    for (const chat of unsettled.restored) if (!waits.has(chat)) waits.set(chat, held);
  }
  return waits;
}

const SETTLED: Unsettled = { whole: "read", restored: [] };

/** What the clock is told of one chat (`turnClock.withWait`): it waits, it
 *  does not, or the page does not know. */
export function seenWait(waits: ReadonlyMap<string, ChatHold>, chat: string): boolean | "unknown" {
  const hold = waits.get(chat);
  return notKnown(hold) ? "unknown" : hold !== undefined;
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
