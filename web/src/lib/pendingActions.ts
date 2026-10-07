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
// - an unanswered question (`question_pending`), one per card: a batch asked
//   in one call is one card, and stays until its last question is answered.
//   The host keeps an answered call listed until its answers reach the agent:
//   `saved` is that wait, and asks nothing of the person. `failed` (delivery
//   failed or could not be confirmed) is never re-sent on its own — only the
//   card's Retry or Cancel closes it — so it is an action, but a different
//   one: its answers are in, and it is never called unanswered;
// - an open decision gate, keyed by gate id;
// - a plan waiting for approval, keyed by run AND revision, so a plan the lead
//   changes after approval comes back as a new action rather than the old one.
//
// Nothing is read from prose: not a question mark in a message, not a worker
// waiting on provider capacity, not unread or blocked status. All of these
// sources are tab-wide already — the request lists are refilled from the host
// on every connection, and the ledger holds every run — so a row knows before
// its chat was ever opened, and costs no request of its own.
import { waitsOnPerson } from "./handover";
import { mainChatId, type OrchestrationSnapshot } from "./orchestration";
import { planTasks } from "./planReview";
import type { Question } from "../components/UserQuestion";

export type PendingActionKind = "permission" | "safety" | "outage" | "question" | "delivery" | "gate" | "plan" | "handover";

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
};

type Request = { id?: string; batch?: string | null; status?: Question["status"]; kind?: string; provider?: string };
type Requests = Readonly<Record<string, readonly Request[] | undefined>>;

/** A worker's Claude auto-mode refusal: nobody can approve it, the worker was
 *  told and goes on another way. It asks nothing of the person, so it is no
 *  action and the main chat folds it into one line (feedback 76cde28e). A
 *  Codex card can continue the work, and an outage card can be retried. */
export function isQuietWorkerRefusal(card: { provider?: string; kind?: string }): boolean {
  return card.provider === "claude" && card.kind !== "outage";
}

/** What one question card still needs, per `batch || id`: `question` while any
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
  /** Handovers an agent asked for: waiting on the person's confirm, or on
   *  their Try again / Give up after a start that failed. */
  handovers?: readonly { id: string; sourceChatKey: string; status: string; error?: string; kind?: string }[];
};

const LIVE_RUNS = new Set(["planning", "running", "waiting"]);
const ORDER: Record<PendingActionKind, number> = { permission: 0, safety: 1, outage: 2, question: 3, delivery: 4, gate: 5, plan: 6, handover: 7 };

const chatId = (chatKey: string | undefined) => chatKey?.startsWith("chat:") ? chatKey.slice(5) || null : null;

/** Every action waiting on the person, once each, most urgent first. */
export function pendingActions(input: PendingActionInput): PendingAction[] {
  const { orchestration, parents } = input;
  const found = new Map<string, PendingAction>();
  const add = (action: PendingAction) => { if (!found.has(action.key)) found.set(action.key, action); };
  const rowOf = (id: string) => mainChatId(id, parents) ?? id;
  // A worker's own task, from the newest attempt its chat ran.
  const taskOf = new Map<string, { runId: string; taskId: string; number: number }>();
  for (const attempt of orchestration.attempts) {
    const id = chatId(attempt.workerChatKey);
    const before = id ? taskOf.get(id) : undefined;
    if (id && (!before || attempt.number > before.number)) {
      taskOf.set(id, { runId: attempt.runId, taskId: attempt.taskId, number: attempt.number });
    }
  }

  // `prefix` is the card's own key kind: an outage card is a safety card.
  const request = (kind: PendingActionKind, identity: string, conversationId: string, prefix: string = kind) => {
    const row = rowOf(conversationId);
    const task = taskOf.get(conversationId);
    add({
      key: `${prefix}:${identity}`, kind, rowId: row,
      // Worker cards are drawn in the main chat, where they are answered.
      openChatId: task ? row : conversationId, surface: "chat",
      runId: task?.runId, taskId: task?.taskId,
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
  for (const [conversationId, list] of Object.entries(input.questions ?? {})) {
    // The main chat draws its workers' permission and safety cards, but
    // never their questions (a worker asks through a gate), so a worker's
    // question has no card a badge could lead to.
    if (rowOf(conversationId) !== conversationId) continue;
    // One card holds a whole batch, so the batch is the action.
    for (const [identity, kind] of questionActions(list ?? [])) request(kind, identity, conversationId);
  }

  const runs = new Map(orchestration.runs.map((run) => [run.id, run]));
  for (const gate of orchestration.gates) {
    const run = runs.get(gate.runId);
    const coordinator = chatId(run?.coordinatorChatKey);
    if (gate.status !== "open" || !run || !coordinator || run.archivedAt != null) continue;
    add({
      key: `gate:${gate.id}`, kind: "gate", rowId: rowOf(coordinator), openChatId: coordinator,
      surface: "run", runId: run.id, taskId: gate.taskId,
    });
  }
  for (const run of orchestration.runs) {
    const coordinator = chatId(run.coordinatorChatKey);
    if (!coordinator || run.planApproval?.status !== "pending" || !LIVE_RUNS.has(run.status) || run.archivedAt != null) continue;
    // An empty plan cannot be approved yet: the lead is still writing it.
    if (planTasks(orchestration.tasks.filter((task) => task.runId === run.id)).length === 0) continue;
    add({
      key: `plan:${run.id}:${run.planApproval.revision ?? 0}`, kind: "plan", rowId: rowOf(coordinator),
      openChatId: coordinator, surface: "chat", runId: run.id,
    });
  }
  for (const handover of input.handovers ?? []) {
    const source = chatId(handover.sourceChatKey);
    // A route waits in a front-desk chat, which no list shows: walking away
    // from it leaves nothing to badge.
    if (!source || !waitsOnPerson(handover) || handover.kind === "route") continue;
    add({ key: `handover:${handover.id}`, kind: "handover", rowId: rowOf(source), openChatId: source, surface: "chat" });
  }
  return [...found.values()].sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
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
  plan: ["plan to approve", "plans to approve"],
  handover: ["handover to confirm", "handovers to confirm"],
};

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
 *  element: a question card holds every batch of its chat. */
export function pendingSelector(key: string): string {
  return `[data-pending-keys~="${key.replace(/["\\]/g, "\\$&")}"]`;
}
