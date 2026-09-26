// What is waiting on the person, per chat-list row and per task.
//
// Only a record the host keeps for the person counts, each under the identity
// the host gave it:
//
// - a permission card (`permission_pending`), keyed by its request id;
// - a safety card, an auto-mode refusal the person may allow once
//   (`safety_block_pending`), keyed by its id — the ledger's `nativeDecisions`
//   are the same cards seen from a run, so they are never counted twice;
// - an unanswered question (`question_pending`), one per card: a batch asked
//   in one call is one card, and stays until its last question is answered;
// - an open decision gate, keyed by gate id;
// - a plan waiting for approval, keyed by run AND revision, so a plan the lead
//   changes after approval comes back as a new action rather than the old one.
//
// Nothing is read from prose: not a question mark in a message, not a worker
// waiting on provider capacity, not unread or blocked status. All of these
// sources are tab-wide already — the request lists are refilled from the host
// on every connection, and the ledger holds every run — so a row knows before
// its chat was ever opened, and costs no request of its own.
import { mainChatId, type OrchestrationSnapshot } from "./orchestration";
import { planTasks } from "./planReview";

export type PendingActionKind = "permission" | "safety" | "question" | "gate" | "plan";

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

type Request = { id?: string; batch?: string | null };
type Requests = Readonly<Record<string, readonly Request[] | undefined>>;

export type PendingActionInput = {
  orchestration: OrchestrationSnapshot;
  parents: ReadonlyMap<string, string>;
  asks?: Requests;
  safetyBlocks?: Requests;
  questions?: Requests;
};

const LIVE_RUNS = new Set(["planning", "running", "waiting"]);
const ORDER: Record<PendingActionKind, number> = { permission: 0, safety: 1, question: 2, gate: 3, plan: 4 };

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

  const requests = (kind: "permission" | "safety" | "question", lists: Requests | undefined) => {
    for (const [conversationId, list] of Object.entries(lists ?? {})) {
      for (const item of list ?? []) {
        if (!item?.id) continue;
        const row = rowOf(conversationId);
        const task = taskOf.get(conversationId);
        // The main chat draws its workers' permission and safety cards, but
        // never their questions (a worker asks through a gate), so a worker's
        // question has no card a badge could lead to.
        if (kind === "question" && row !== conversationId) continue;
        // One card holds a whole batch, so the batch is the action.
        const identity = kind === "question" ? item.batch || item.id : item.id;
        add({
          key: `${kind}:${identity}`, kind, rowId: row,
          // Worker cards are drawn in the main chat, where they are answered.
          openChatId: task ? row : conversationId, surface: "chat",
          runId: task?.runId, taskId: task?.taskId,
        });
      }
    }
  };
  requests("permission", input.asks);
  requests("safety", input.safetyBlocks);
  requests("question", input.questions);

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
  safety: "Approval needed",
  question: "Answer needed",
  gate: "Decision needed",
  plan: "Plan approval",
};

const NOUN: Record<PendingActionKind, [string, string]> = {
  permission: ["permission request", "permission requests"],
  safety: ["blocked action to review", "blocked actions to review"],
  question: ["question to answer", "questions to answer"],
  gate: ["decision", "decisions"],
  plan: ["plan to approve", "plans to approve"],
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
