// What is waiting on the person, per chat-list row and per task.
//
// Only a record the host keeps for the person counts, each under the identity
// the host gave it:
//
// - a permission card (`permission_pending`), keyed by its request id;
// - a safety card, an action a provider's own review refused
//   (`safety_block_pending`), keyed by its id — the ledger's `nativeDecisions`
//   are the same cards seen from a run, so they are never counted twice. It
//   waits for the person to choose how the agent goes on, but a Claude refusal
//   can never be allowed, so the badge says "review", not "approve". An
//   outage card (`kind: "outage"`: Claude's check gave no verdict at all) has
//   nothing to review, so it is its own calmer kind, under the same key the
//   card carries;
// - an unanswered question (`question_pending`), one per call: a batch asked
//   in one call is one block in the transcript (`components/InlineQuestions`),
//   and stays until its last question is answered. It is read here as a held
//   card like the others, wherever it is drawn.
//   The host keeps an answered call listed until its answers reach the agent:
//   `saved` is that wait, and asks nothing of the person. `failed` (delivery
//   failed or could not be confirmed) is never re-sent on its own — only the
//   block's Retry or Cancel closes it — so it is an action, but a different
//   one: its answers are in, and it is never called unanswered;
// - whatever a run waits on the person for, as `lib/runWaits` reads the
//   ledger: an open decision gate the host says is theirs (keyed by gate id),
//   a plan waiting for approval (keyed by run AND revision, so a plan the
//   lead changes after approval comes back as a new action rather than the
//   old one), and a native decision the host says waits on them, under the
//   key its safety card carries. That last one is listed even when the page
//   has no card for it yet (the card list not read, or its request failed):
//   the host said the person is waited on, and a missing list is no reason to
//   say nothing.
//
// The ledger is read in ONE place. This module reads the page's own card
// lists (`heldCards`), hands them to `runWaits`, and lists what it says is
// the person's; it never looks at a gate or a native decision itself. So a
// badge, the strip, the panel and the chat list's line cannot disagree.
//
// Nothing is read from prose: not a question mark in a message, not a worker
// waiting on provider capacity, not unread or blocked status. All of these
// sources are tab-wide already — the request lists are refilled from the host
// on every connection, and the ledger holds every run — so a row knows before
// its chat was ever opened, and costs no request of its own.
//
// "Not read yet" is not "nothing waits". Each of those sources starts empty
// on a page that has just loaded and is filled by one request, so the
// reading also says how much of it there is to go on (`wholeOf`, `whole`):
// every source has answered, not every one yet, or as many as are going to.
// `lib/chatWait` turns that into its third answer for a chat, and it is the
// only thing here that is not a card or the ledger's word.
import { waitsOnPerson } from "./handover";
import { mainChatId, type OrchestrationSnapshot } from "./orchestration";
import { ledgerWaits, type LedgerWaits, type Waiting } from "./runWaits";
import type { Question } from "./question";

export type PendingActionKind = "permission" | "safety" | "outage" | "question" | "delivery" | "gate" | "failure" | "plan" | "handover";

export type PendingAction = {
  /** The host's own identity for it, prefixed by kind: stable across reloads
   *  and reconnects, and the same on every surface that shows it. */
  key: string;
  kind: PendingActionKind;
  /** The listed row it belongs to: the top-most main chat. Workers are not
   *  rows, so theirs roll up to the chat that runs them. */
  rowId: string;
  /** The chat whose screen shows the card that answers it. */
  openChatId: string;
  /** Where on that screen: the conversation, or its run panel. */
  surface: "chat" | "run";
  runId?: string;
  taskId?: string;
  /** The conversation whose own card this is. Absent for what the ledger
   *  alone records. */
  chatId?: string;
  /** The host says it waits on the person and the page holds no card for it
   *  yet: the list it comes in was not read, or its request failed. */
  cardMissing?: true;
};

/** What can say that a chat waits on the person, each filled by one request
 *  to the host: the four card lists `useChatRequests` asks for on every
 *  connection, and the ledger (`orchestrationFeed`), which holds a plan
 *  awaiting approval. Handovers are not here: none parks a chat. */
export const WAIT_SOURCES = ["permission_pending", "access_request_pending", "question_pending", "safety_block_pending", "orchestration_snapshot"] as const;
export type WaitSource = (typeof WAIT_SOURCES)[number];

/** Where one source's request stands for this connection: asked and not
 *  answered yet, answered, or failed for good (a card list is asked once
 *  more after a failure, `listRead.readTwice`, and this is the second). */
export type SourceRead = "asked" | "answered" | "failed";
export type SourcesRead = Readonly<Record<WaitSource, SourceRead>>;

/** How long a source that says nothing is waited for before the page stops
 *  holding a restored clock for it. A request on an open socket has no
 *  timeout of its own, and a socket that closes fails it at once and asks
 *  again on the next, so this is a host that took the request and never
 *  answered. Long, because the cost of waiting is a stopped clock and the
 *  cost of not waiting is a wait counted as work. */
export const SILENT_MS = 5 * 60_000;

/** How much of what can say a chat waits has been read.
 *
 *  - `read`: every source has answered. "Nothing waits" is a fact.
 *  - `unread`: one is still asked. Nothing is known of a chat no card names.
 *  - `gaveUp`: there is nothing more to come for this connection: every
 *    source has answered or failed for good, or one has said nothing for
 *    `SILENT_MS` (`late`). The page goes on with what it has, on a guess.
 *
 *  A caller that says nothing of its sources has read them. */
export type Whole = "read" | "unread" | "gaveUp";
export function wholeOf(sources: SourcesRead | undefined, late = false): Whole {
  if (!sources) return "read";
  const states = WAIT_SOURCES.map((source) => sources[source]);
  if (states.every((state) => state === "answered")) return "read";
  return late || states.every((state) => state !== "asked") ? "gaveUp" : "unread";
}

/** The sources still to be heard from, for a tooltip or a log. */
export const unreadSources = (sources: SourcesRead): WaitSource[] => WAIT_SOURCES.filter((source) => sources[source] !== "answered");

type Request = {
  id?: string; batch?: string | null; status?: Question["status"]; kind?: string; provider?: string;
  rules?: readonly string[]; allow?: { project?: string; user?: string } | null;
};
type Requests = Readonly<Record<string, readonly Request[] | undefined>>;

/** A worker's Claude auto-mode refusal that offers the person nothing to do:
 *  nobody can approve it, no exact rule can be written for it, and the worker
 *  was told and goes on another way. It is no action, and the main chat folds
 *  it into one line (feedback 76cde28e). A card that can write an "Always
 *  allow" rule stays a card, because that is how an authorized command the
 *  classifier refused gets through (feedback d59f830a). A Codex card can
 *  continue the work, and an outage card can be retried. */
export function isQuietWorkerRefusal(card: Pick<Request, "provider" | "kind" | "rules" | "allow">): boolean {
  const canAllow = !!card.rules?.length && !!(card.allow?.project || card.allow?.user);
  return card.provider === "claude" && card.kind !== "outage" && !canAllow;
}

/** What one question block still needs, per `batch || id`: `question` while any
 *  of its questions is unanswered (a status-less one comes from a server older
 *  than the durable store, which only ever lists unanswered questions), else
 *  `delivery` when its delivery failed, else nothing — saved and on its way.
 *  Shared with the card itself, so the keys it carries are the badge's. */
export function questionActions(questions: readonly Request[]): Map<string, "question" | "delivery"> {
  const needs = new Map<string, "question" | "delivery">();
  for (const item of questions) {
    if (!item?.id) continue;
    const identity = item.batch || item.id;
    if (item.status === undefined || item.status === "pending") needs.set(identity, "question");
    else if (item.status === "failed" && !needs.has(identity)) needs.set(identity, "delivery");
  }
  return needs;
}

export type PendingActionInput = {
  orchestration: OrchestrationSnapshot;
  parents: ReadonlyMap<string, string>;
  asks?: Requests;
  safetyBlocks?: Requests;
  questions?: Requests;
  /** An agent's ask for a higher access level (`access_request_pending`). It
   *  waits on the person's click like a permission card, and is badged as
   *  one, under its own key. */
  accessRequests?: Requests;
  /** Handovers an agent asked for: waiting on the person's confirm, or on
   *  their Try again / Give up after a start that failed. */
  handovers?: readonly { id: string; sourceChatKey: string; status: string; error?: string; kind?: string }[];
  /** Where the request behind each source above stands, and whether the one
   *  that says nothing has been waited for long enough (`wholeOf`). */
  sources?: SourcesRead;
  late?: boolean;
};

const ORDER: Record<PendingActionKind, number> = { permission: 0, safety: 1, outage: 2, question: 3, delivery: 4, gate: 5, failure: 6, plan: 7, handover: 8 };

const chatId = (chatKey: string | undefined) => chatKey?.startsWith("chat:") ? chatKey.slice(5) || null : null;

/** One reading of everything that waits on the person. `held` is the page's
 *  own cards per task, which is what every surface hands `lib/runWaits`;
 *  `waits` is that module's reading of the whole ledger with them. */
export type PendingReading = {
  actions: PendingAction[]; held: Waiting; waits: LedgerWaits;
  /** How much of what could say a chat waits this was read from. */
  whole: Whole;
};

const taskOfChat = (orchestration: OrchestrationSnapshot) => {
  // A worker's own task, from the newest attempt its chat ran.
  const taskOf = new Map<string, { runId: string; taskId: string; number: number }>();
  for (const attempt of orchestration.attempts) {
    const id = chatId(attempt.workerChatKey);
    const before = id ? taskOf.get(id) : undefined;
    if (id && (!before || attempt.number > before.number)) {
      taskOf.set(id, { runId: attempt.runId, taskId: attempt.taskId, number: attempt.number });
    }
  }
  return taskOf;
};

/** The cards the page itself holds for the person, once each: its request
 *  lists and nothing of the ledger's own records. */
export function heldCards(input: PendingActionInput): PendingAction[] {
  const { orchestration, parents } = input;
  const found = new Map<string, PendingAction>();
  const add = (action: PendingAction) => { if (!found.has(action.key)) found.set(action.key, action); };
  const rowOf = (id: string) => mainChatId(id, parents) ?? id;
  const taskOf = taskOfChat(orchestration);

  // `prefix` is the card's own key kind: an outage card is a safety card.
  const request = (kind: PendingActionKind, identity: string, conversationId: string, prefix: string = kind) => {
    const row = rowOf(conversationId);
    const task = taskOf.get(conversationId);
    add({
      key: `${prefix}:${identity}`, kind, rowId: row,
      // Worker cards are drawn in the main chat, where they are answered.
      openChatId: task ? row : conversationId, surface: "chat",
      runId: task?.runId, taskId: task?.taskId, chatId: conversationId,
    });
  };
  const requests = (kind: "permission" | "safety", lists: Requests | undefined) => {
    for (const [conversationId, list] of Object.entries(lists ?? {})) {
      const worker = rowOf(conversationId) !== conversationId;
      for (const item of list ?? []) {
        if (!item?.id) continue;
        if (kind === "safety" && worker && isQuietWorkerRefusal(item)) continue;
        request(kind === "safety" && item.kind === "outage" ? "outage" : kind, item.id, conversationId, kind);
      }
    }
  };
  requests("permission", input.asks);
  requests("safety", input.safetyBlocks);
  for (const [conversationId, list] of Object.entries(input.accessRequests ?? {})) {
    for (const item of list ?? []) if (item?.id) request("permission", item.id, conversationId, "access");
  }
  for (const [conversationId, list] of Object.entries(input.questions ?? {})) {
    // The main chat draws its workers' permission and safety cards, but
    // never their questions (a worker asks through a gate), so a worker's
    // question has no card a badge could lead to.
    if (rowOf(conversationId) !== conversationId) continue;
    // One card holds a whole batch, so the batch is the action.
    for (const [identity, kind] of questionActions(list ?? [])) request(kind, identity, conversationId);
  }
  for (const handover of input.handovers ?? []) {
    const source = chatId(handover.sourceChatKey);
    // A route waits in a front-desk chat, which no list shows: walking away
    // from it leaves nothing to badge.
    if (!source || !waitsOnPerson(handover) || handover.kind === "route") continue;
    add({ key: `handover:${handover.id}`, kind: "handover", rowId: rowOf(source), openChatId: source, surface: "chat", chatId: source });
  }
  return [...found.values()];
}

/** Everything waiting on the person: the page's cards, and what
 *  `lib/runWaits` says the ledger holds for them, under one key each. */
export function pendingReading(input: PendingActionInput): PendingReading {
  const { orchestration, parents } = input;
  const cards = heldCards(input);
  const held = pendingByTask(cards);
  const waits = ledgerWaits(orchestration, held);
  const found = new Map(cards.map((card) => [card.key, card]));
  const rowOf = (id: string) => mainChatId(id, parents) ?? id;
  const runs = new Map(orchestration.runs.map((run) => [run.id, run]));
  for (const wait of waits.person) {
    // A card is already listed, where its conversation is.
    if (found.has(wait.key)) continue;
    const coordinator = chatId(runs.get(wait.runId)?.coordinatorChatKey);
    if (!coordinator) continue;
    const row = rowOf(coordinator);
    if (wait.kind === "plan") {
      found.set(wait.key, { key: wait.key, kind: "plan", rowId: row, openChatId: coordinator, surface: "chat", runId: wait.runId });
    } else if (wait.kind === "gate") {
      found.set(wait.key, { key: wait.key, kind: "gate", rowId: row, openChatId: coordinator, surface: "run", runId: wait.runId, taskId: wait.taskId });
    } else if (wait.kind === "failure") {
      // A failure the host says is the person's to decide, with no gate that
      // asks it: the failure is the decision, and its row is where it is.
      found.set(wait.key, { key: wait.key, kind: "failure", rowId: row, openChatId: coordinator, surface: "run", runId: wait.runId, taskId: wait.taskId });
    } else if (wait.kind === "native") {
      // Its card is drawn in the main chat when the page has it. Until then
      // the badge still says so, and leads to where the card will be.
      found.set(wait.key, {
        key: wait.key, kind: wait.card ?? "safety", rowId: row, openChatId: row, surface: "chat",
        runId: wait.runId, taskId: wait.taskId, cardMissing: true,
      });
    }
  }
  const actions = [...found.values()].sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
  return { actions, held, waits, whole: wholeOf(input.sources, input.late) };
}

/** Every action waiting on the person, once each, most urgent first. */
export function pendingActions(input: PendingActionInput): PendingAction[] {
  return pendingReading(input).actions;
}

/** Grouped by row, for a list that asks once per row. */
export function pendingByRow(actions: readonly PendingAction[]): ReadonlyMap<string, PendingAction[]> {
  const rows = new Map<string, PendingAction[]>();
  for (const action of actions) {
    const list = rows.get(action.rowId);
    if (list) list.push(action);
    else rows.set(action.rowId, [action]);
  }
  return rows;
}

export function pendingByTask(actions: readonly PendingAction[]): ReadonlyMap<string, PendingAction[]> {
  const tasks = new Map<string, PendingAction[]>();
  for (const action of actions) {
    if (!action.taskId) continue;
    const list = tasks.get(action.taskId);
    if (list) list.push(action);
    else tasks.set(action.taskId, [action]);
  }
  return tasks;
}

const LABEL: Record<PendingActionKind, string> = {
  permission: "Permission needed",
  safety: "Review needed",
  outage: "Safety check was down",
  question: "Answer needed",
  delivery: "Delivery failed",
  gate: "Decision needed",
  failure: "Failed · your decision",
  plan: "Plan approval",
  handover: "Handover to confirm",
};

const NOUN: Record<PendingActionKind, [string, string]> = {
  permission: ["permission request", "permission requests"],
  safety: ["blocked action to review", "blocked actions to review"],
  outage: ["safety check outage", "safety check outages"],
  question: ["question to answer", "questions to answer"],
  delivery: ["failed answer delivery", "failed answer deliveries"],
  gate: ["decision", "decisions"],
  failure: ["failed task to decide", "failed tasks to decide"],
  plan: ["plan to approve", "plans to approve"],
  handover: ["handover to confirm", "handovers to confirm"],
};

/** What colour a badge is. Colour is state, and these are three states:
 *  `decide` waits on the person's decision (a permission, a question, a
 *  gate, a plan, a handover); `warn` is a problem they are told of (an
 *  action the safety check refused, the check being down, an answer that
 *  could not be delivered), which is what amber means everywhere else; and
 *  `danger` is a failure that is theirs to decide, the one failure the run
 *  panel draws red. It used to be amber for all nine. */
export type PendingTone = "decide" | "warn" | "danger";

const TONE: Record<PendingActionKind, PendingTone> = {
  permission: "decide", question: "decide", gate: "decide", plan: "decide", handover: "decide",
  safety: "warn", outage: "warn", delivery: "warn",
  failure: "danger",
};

/** The colour of a badge over these actions. Several of one state are that
 *  state. Mixed, something among them waits on a decision or is a failure
 *  to decide, and the badge says "Action needed": the decision colour, as
 *  the strip says "Needs you" for a failure beside a card. */
export function pendingTone(actions: readonly PendingAction[]): PendingTone {
  const tones = new Set(actions.map((action) => TONE[action.kind]));
  if (tones.size === 1) return [...tones][0];
  return "decide";
}

/** The badge's words: what it is when there is one, how many when several. */
export function pendingLabel(actions: readonly PendingAction[]): string {
  if (actions.length === 0) return "";
  return actions.length === 1 ? LABEL[actions[0].kind] : `Action needed · ${actions.length}`;
}

/** Every kind spelled out, for the tooltip and a screen reader. */
export function pendingDescription(actions: readonly PendingAction[]): string {
  const counts = new Map<PendingActionKind, number>();
  for (const action of actions) counts.set(action.kind, (counts.get(action.kind) ?? 0) + 1);
  return [...counts].map(([kind, count]) => `${count} ${NOUN[kind][count === 1 ? 0 : 1]}`).join(", ");
}

/** The selector a revealed card is found by. Several keys can share one
 *  element: a question block carries its own and its delivery's. */
export function pendingSelector(key: string): string {
  return `[data-pending-keys~="${key.replace(/["\\]/g, "\\$&")}"]`;
}
