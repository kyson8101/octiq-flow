import type { Conversation } from "./store";
import { workerArchiveChatList } from "./workerArchive";
import {
  CHECK_FAILED_LABEL, checkFailed, EMPTY_ORCHESTRATION, failureShown, shownRunStatus,
  type OrchestrationAttempt, type OrchestrationSnapshot, type OrchestrationRun, type OrchestrationTask,
} from "./orchestration";
import { runCounts, STRIP_WORD } from "./runProgress";
import { ledgerWaits, runWaits, type Waiting } from "./runWaits";

export const isActiveRun = (run: OrchestrationRun) => ["planning", "running", "waiting"].includes(run.status);

/** Scope by coordinator identity, never just by project. One chat can own many runs. */
export function chatSnapshot(snapshot: OrchestrationSnapshot, coordinatorKey: string | null): OrchestrationSnapshot {
  if (!coordinatorKey) return EMPTY_ORCHESTRATION;
  const runs = snapshot.runs.filter((run) => run.coordinatorChatKey === coordinatorKey)
    .sort((a, b) => Number(isActiveRun(b)) - Number(isActiveRun(a)) || b.createdAt - a.createdAt);
  const ids = new Set(runs.map((run) => run.id));
  // Everything `lib/runWaits` reads for these runs is kept, so a scoped read
  // and the panel's whole one see the same facts: the native decisions were
  // left out once, and the strip said Running where the panel said Needs you.
  return { runs, reports: snapshot.reports, tasks: snapshot.tasks.filter((task) => ids.has(task.runId)),
    ...(snapshot.nativeDecisions ? { nativeDecisions: snapshot.nativeDecisions.filter((decision) => ids.has(decision.runId)) } : {}),
    attempts: snapshot.attempts.filter((attempt) => ids.has(attempt.runId)),
    gates: snapshot.gates.filter((gate) => ids.has(gate.runId)),
    messages: snapshot.messages.filter((message) => ids.has(message.runId)),
    notifications: snapshot.notifications?.filter((notification) => ids.has(notification.runId)) };
}

/** The run a chat's row speaks for: one that waits on the person before a
 *  newer one that does not, else its latest that is not put away. `snapshot`
 *  is the chat's own (`chatSnapshot`), `held` the cards the page holds. */
export function rowRun(snapshot: OrchestrationSnapshot, held?: Waiting): OrchestrationRun | undefined {
  const waits = ledgerWaits(snapshot, held);
  return snapshot.runs.find((run) => waits.runs.get(run.id)?.person.length)
    ?? snapshot.runs.find((run) => run.archivedAt == null) ?? snapshot.runs[0];
}

/** A line of the chat list about a run or a task, and the colour of what it
 *  leads with: the decision colour for what waits on the person, the danger
 *  colour for a failure. */
export type RunLine = { text: string; tone: "decide" | "danger" | null };

/** One run in a few words: what it waits on or what failed, then tasks done
 *  of the tasks that count. The three counts are the strip's own
 *  (`runProgress.runCounts`), so the line and the strip above the composer
 *  cannot give different numbers: a task whose check failed is not done
 *  here either. "N failed" is said only of a failure that waits on the
 *  person (`orchestration.failureMove`): one the coordinator is fixing is
 *  not on this line at all, in no word and no colour. */
export function runSummaryLine(snapshot: OrchestrationSnapshot, run: OrchestrationRun, held?: Waiting): RunLine {
  const waits = runWaits(snapshot, run, held);
  const { done, total, failed } = runCounts(snapshot, run, held, waits);
  // Nothing to count is not "0/0": a run with no task yet, or a stopped one
  // whose unfinished tasks are history, says its state and no progress.
  const line = (...parts: (string | null)[]) => parts.filter(Boolean).join(" · ");
  const progress = total ? `${done}/${total} done` : null;
  const wrong = failed ? `${failed} failed` : null;
  // A wait on the person is said of exactly what `lib/runWaits` says is
  // theirs: the strip above the composer counts the same list, and this is
  // its word ("Needs you"). It leads, and what failed is still said after
  // it. The strip's word is also the one that leaves room: with "Needs
  // decision" the row cut the done count off a line that said a failure too
  // (162px of a 182px line, in every theme).
  //
  // When every decision is a failure's own, the failure is the line: what
  // the strip says then too ("1 failed"), in the danger colour.
  if (waits.person.length) {
    return waits.person.every((wait) => wait.failure)
      ? { text: line(wrong, progress), tone: "danger" }
      : { text: line(STRIP_WORD.needs, wrong, progress), tone: "decide" };
  }
  // What failed, counted as the strip counts it, on a host that does not
  // say whose move a failure is: a task that failed, one that is blocked
  // with no decision open, one that completed with a failed check. A task
  // parked on an open decision of anybody's is waiting.
  if (failed) return { text: line(wrong, progress), tone: "danger" };
  // The run's status as it is drawn: a run the host calls failed while its
  // coordinator is fixing what failed is running.
  const status = shownRunStatus(run, snapshot.tasks);
  return { text: line(status.charAt(0).toUpperCase() + status.slice(1), progress), tone: null };
}

export function runSummary(snapshot: OrchestrationSnapshot, run: OrchestrationRun, held?: Waiting): string {
  return runSummaryLine(snapshot, run, held).text;
}

/**
 * A main chat's status line in the chat list. The progress is the run on show;
 * a chat that has run more than once has had more tasks than that run holds,
 * so the line also says how many in all. Without it "0/1" sat beside a
 * "2 tasks" counted across every run, and read as a contradiction.
 * `snapshot` is the chat's own (`chatSnapshot`).
 */
export function chatRunLine(snapshot: OrchestrationSnapshot, run: OrchestrationRun, held?: Waiting): RunLine {
  const summary = runSummaryLine(snapshot, run, held);
  const total = snapshot.tasks.length;
  const inRun = snapshot.tasks.filter((task) => task.runId === run.id).length;
  if (snapshot.runs.length < 2 || total === inRun) return summary;
  return { ...summary, text: `${summary.text} · ${total} ${total === 1 ? "task" : "tasks"} in ${snapshot.runs.length} runs` };
}

export function chatRunStatus(snapshot: OrchestrationSnapshot, run: OrchestrationRun, held?: Waiting): string {
  return chatRunLine(snapshot, run, held).text;
}

/** A worker chat's own line in the chat list: its task, and where the
 *  attempt behind this chat is. A chat whose attempt settled a task with a
 *  failed check says that and never "completed": the attempt's own word is
 *  how its worker's process ended. It is the danger colour only where that
 *  failure is red (`orchestration.failureShown`): not while the coordinator
 *  is fixing it, and not once it is history. */
export function workerLine(
  task: Pick<OrchestrationTask, "title" | "status" | "verdict" | "supersededBy" | "activeAttemptId" | "stopped" | "failure" | "retryLimit">,
  attempt: Pick<OrchestrationAttempt, "id" | "status" | "archivedAt">,
): RunLine {
  if (attempt.archivedAt != null) return { text: `${task.title} · archived`, tone: null };
  if (checkFailed(task) && task.activeAttemptId === attempt.id) {
    return { text: `${task.title} · ${CHECK_FAILED_LABEL.toLowerCase()}`, tone: failureShown(task) === "red" ? "danger" : null };
  }
  return { text: `${task.title} · ${attempt.status}`, tone: null };
}

/** What `workflowChatList` reads of a ledger, and nothing else. */
export type WorkflowFacts = Pick<OrchestrationSnapshot, "runs" | "tasks" | "attempts">;

const attemptsByTaskCache = new WeakMap<OrchestrationAttempt[], Map<string, OrchestrationAttempt[]>>();

/** Attempts grouped by task, newest first, built once per attempts array.
 *  Filtering every attempt for every task was O(tasks × attempts) on each
 *  render of the chat list. Order within a task is the old
 *  `filter(...).sort(number desc)`: a stable sort of the same sequence. */
export function attemptsByTask(attempts: OrchestrationAttempt[]): Map<string, OrchestrationAttempt[]> {
  const held = attemptsByTaskCache.get(attempts);
  if (held) return held;
  const index = new Map<string, OrchestrationAttempt[]>();
  for (const attempt of attempts) {
    const list = index.get(attempt.taskId);
    if (list) list.push(attempt); else index.set(attempt.taskId, [attempt]);
  }
  for (const list of index.values()) list.sort((a, b) => b.number - a.number);
  attemptsByTaskCache.set(attempts, index);
  return index;
}

/** Keep old attempts searchable and selectable, but group the ordinary list by task. */
export function workflowChatList(chats: Conversation[], snapshot: WorkflowFacts, selectedId: string | null): Conversation[] {
  const chatIds = new Set(chats.map((chat) => chat.id));
  const runs = new Map(snapshot.runs.map((run) => [run.id, run]));
  const byTask = attemptsByTask(snapshot.attempts);
  const hidden = new Set<string>();
  for (const task of snapshot.tasks) {
    const attempts = byTask.get(task.id) ?? [];
    const current = attempts.find((a) => a.id === task.activeAttemptId) ?? attempts[0];
    const parent = runs.get(task.runId)?.coordinatorChatKey.replace(/^chat:/, "");
    if (!current || !parent || !chatIds.has(parent) || !chatIds.has(current.workerChatKey.replace(/^chat:/, ""))) continue;
    for (const attempt of attempts) if (attempt.id !== current.id) hidden.add(attempt.workerChatKey.replace(/^chat:/, ""));
  }
  return workerArchiveChatList(chats, snapshot).filter((chat) => chat.id === selectedId || !hidden.has(chat.id));
}

const sameList = <T,>(a: readonly T[], b: readonly T[], same: (x: T, y: T) => boolean): boolean =>
  a === b || (a.length === b.length && a.every((item, i) => item === b[i] || same(item, b[i])));

/** The ledger as `workflowChatList` and `workerArchiveChatList` read it:
 *  membership and archive facts. Returns `prev` itself when `next` differs
 *  from it only in what those never read (a worker's `execution`, a task's
 *  status or result, a run's revision), so a memo keyed on the returned
 *  object is not invalidated by a stream of execution patches. Keep the
 *  field lists below equal to what the two functions read. */
export function stableWorkflowFacts(prev: WorkflowFacts | null, next: WorkflowFacts): WorkflowFacts {
  if (!prev) return next;
  if (prev === next) return prev;
  const same = sameList(prev.runs, next.runs, (a, b) => a.id === b.id && a.coordinatorChatKey === b.coordinatorChatKey)
    && sameList(prev.tasks, next.tasks, (a, b) => a.id === b.id && a.runId === b.runId && a.activeAttemptId === b.activeAttemptId)
    && sameList(prev.attempts, next.attempts, (a, b) =>
      a.id === b.id && a.taskId === b.taskId && a.number === b.number
      && a.workerChatKey === b.workerChatKey && a.archivedAt === b.archivedAt);
  return same ? prev : next;
}
