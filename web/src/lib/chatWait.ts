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
import type { PendingAction } from "./pendingActions";

/** What the chat is parked on: a card it must be answered on, or one that
 *  approves something. */
export type ChatWait = "answer" | "approval";

export const WAIT_WORDS: Record<ChatWait, string> = {
  answer: "Waiting for your answer",
  approval: "Waiting for your approval",
};

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

/** Every chat that waits on the person, with what it waits for. `actions`
 *  come most urgent first (`pendingActions`), so a chat with a permission
 *  card and a question says the approval. */
export function waitingChats(
  actions: readonly PendingAction[],
  folded: ReadonlySet<string> = NONE,
): ReadonlyMap<string, ChatWait> {
  const waits = new Map<string, ChatWait>();
  for (const action of actions) {
    const parked = parks(action, folded);
    if (parked && !waits.has(parked.chat)) waits.set(parked.chat, parked.wait);
  }
  return waits;
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

/** The chats to draw as working: a turn in flight that waits on nobody. */
export function workingChats(busy: ReadonlySet<string>, waits: ReadonlyMap<string, ChatWait>): Set<string> {
  const working = new Set<string>();
  for (const id of busy) if (!waits.has(id)) working.add(id);
  return working;
}
