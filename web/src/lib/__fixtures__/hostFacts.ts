// The ledger as the host really serialises it.
//
// Each file under `host/` is what one of the host's own tests answered, taken
// verbatim (see `host/README.md` for which test and how to record it again).
// Never hand-edit them: a page fixture written by hand is how the page came
// to be built against fields the host does not send that way. A test that
// needs another moment of the same ledger changes a copy, in the test, and
// says what it changed.
import type { ChatPlan } from "../chatPlan";
import type { OrchestrationSnapshot, OrchestrationTask } from "../orchestration";
import type { Question, QuestionAnswered } from "../question";
import cardOnGateBlocked from "./host/card_on_gate_blocked.json?raw";
import cardPending from "./host/card_pending.json?raw";
import chatPlanDecided from "./host/chat_plan_decided.json?raw";
import chatPlanDiscussing from "./host/chat_plan_discussing.json?raw";
import chatPlanNone from "./host/chat_plan_none.json?raw";
import chatPlanStarted from "./host/chat_plan_started.json?raw";
import claudeRefusal from "./host/claude_refusal.json?raw";
import coordinatesRun from "./host/coordinates_run.json?raw";
import failureAwaitsCoordinator from "./host/failure_awaits_coordinator.json?raw";
import failureAwaitsPerson from "./host/failure_awaits_person.json?raw";
import failureCheckCoordinatorGone from "./host/failure_check_coordinator_gone.json?raw";
import failureCheckRetriesUsed from "./host/failure_check_retries_used.json?raw";
import failureCoordinatorGone from "./host/failure_coordinator_gone.json?raw";
import failureEscalated from "./host/failure_escalated.json?raw";
import failureInCompletedRun from "./host/failure_in_completed_run.json?raw";
import failureInStoppedRun from "./host/failure_in_stopped_run.json?raw";
import failureReplaced from "./host/failure_replaced.json?raw";
import failureTimeLimit from "./host/failure_time_limit.json?raw";
import gatesOpen from "./host/gates_open.json?raw";
import heldByPlan from "./host/held_by_plan.json?raw";
import heldByReopen from "./host/held_by_reopen.json?raw";
import peerGate from "./host/peer_gate.json?raw";
import planAfterBlocked from "./host/plan_after_blocked.json?raw";
import planAfterCheckFailed from "./host/plan_after_check_failed.json?raw";
import planAfterFailed from "./host/plan_after_failed.json?raw";
import planAfterStopped from "./host/plan_after_stopped.json?raw";
import questionAnsweredMedia from "./host/question_answered_media.json?raw";
import questionAnsweredNative from "./host/question_answered_native.json?raw";
import questionAnsweredTool from "./host/question_answered_tool.json?raw";
import questionMediaPending from "./host/question_media_pending.json?raw";
import reopenNoticeDelivered from "./host/reopen_notice_delivered.json?raw";
import retryExecuting from "./host/retry_executing.json?raw";
import taskStopped from "./host/task_stopped.json?raw";
import usageContext from "./host/usage_context.json?raw";

/** A fresh copy each time: a test may change what it is given. */
const ledger = (raw: string) => (): OrchestrationSnapshot => JSON.parse(raw) as OrchestrationSnapshot;

/** An answer to `chat_plan_get`, a fresh copy each time. */
const plan = (raw: string) => (): ChatPlan => JSON.parse(raw) as ChatPlan;

/** One `octiq_question_answered` line of a chat's record, a fresh copy
 *  each time. */
const answered = (raw: string) => (): QuestionAnswered => JSON.parse(raw) as QuestionAnswered;

/** A chat's entry in `chat_index_list`, with the one key these tests read. */
export type HostChatEntry = { id: string; projectId: string; title: string; createdAt: number; updatedAt: number; coordinatesRun?: boolean };

export const hostFacts = {
  /** A reopened task whose notice the transcript could not take: ready, and
   *  `heldByReopen: true`. `lifecycle`: workspaces::tests. */
  heldByReopen: ledger(heldByReopen),
  /** The same task once its notice is confirmed: the key is gone. */
  reopenNoticeDelivered: ledger(reopenNoticeDelivered),
  /** Approved A beside a pending plan that holds B: `heldByPlan` false and
   *  true, on every task of a run with a plan. */
  heldByPlan: ledger(heldByPlan),
  /** A was approved, started and failed; then B was added, so the plan is
   *  back with the person. A: `failed`, `heldByPlan: false` (the host starts
   *  a retry of it); B: `ready`, `heldByPlan: true`. */
  planAfterFailed: ledger(planAfterFailed),
  /** The same with A blocked by its worker's report. */
  planAfterBlocked: ledger(planAfterBlocked),
  /** The same with A a review that completed with `verdict: "fail"`. */
  planAfterCheckFailed: ledger(planAfterCheckFailed),
  /** The same with A's worker stopped by the person: `failed`, `stopped`,
   *  its attempt `cancelled`. */
  planAfterStopped: ledger(planAfterStopped),
  /** A worker's gate (`awaits: "coordinator"`) and one the coordinator
   *  opened itself, which names no task (`awaits: "person"`). */
  gatesOpen: ledger(gatesOpen),
  /** A gate on a peer request: `awaits: "person"`. */
  peerGate: ledger(peerGate),
  /** A Codex safety card on a running attempt: `awaits: "person"`,
   *  `continuation: "new_turn_same_attempt"`. */
  cardPending: ledger(cardPending),
  /** The same card after its worker opened a gate: still the person's, and
   *  `continuation: "unavailable"` with the host's reason in `recovery`. */
  cardOnGateBlocked: ledger(cardOnGateBlocked),
  /** A Claude auto-mode refusal: pending, `awaits: "nobody"`. */
  claudeRefusal: ledger(claudeRefusal),
  /** A task that failed once: `failed`, `retriesUsed: 0`, `failure.awaits:
   *  "coordinator"`. Nothing is asked of the person. `retry_tests`. */
  failureAwaitsCoordinator: ledger(failureAwaitsCoordinator),
  /** The same task with the coordinator's retry at work: `running`,
   *  `retrying: true`, `retriesUsed: 1`, no `failure`, and its second
   *  attempt carries `retry`. */
  retryExecuting: ledger(retryExecuting),
  /** The same task with both retries used: `failed`, `retriesUsed: 2`,
   *  `failure.awaits: "person"`, `because: "retries_used"`. */
  failureAwaitsPerson: ledger(failureAwaitsPerson),
  /** A failed task the coordinator put to the person with a retry left:
   *  `failure.awaits: "person"`, `because: "escalated"`, `gateId`; the gate
   *  has `aboutTaskId` and no `taskId`. */
  failureEscalated: ledger(failureEscalated),
  /** A failed task another task replaced: `failure.awaits: "nobody"`,
   *  `because: "replaced"`; the replacement carries `retriesUsed: 2`. */
  failureReplaced: ledger(failureReplaced),
  /** A review that completed with `verdict: "fail"` in a run the host calls
   *  `completed`: `failure.kind: "check_failed"`, `awaits: "coordinator"`.
   *  Such a run has not ended. */
  failureInCompletedRun: ledger(failureInCompletedRun),
  /** A failed task in a run that was stopped: `failure.awaits: "nobody"`,
   *  `because: "run_ended"`. */
  failureInStoppedRun: ledger(failureInStoppedRun),
  /** A review that failed its check three times: `completed`, `verdict:
   *  "fail"`, `retriesUsed: 2`, `failure.kind: "check_failed"`, `awaits:
   *  "person"`, `because: "retries_used"`, in a run the host calls
   *  `completed`. The host takes the person's own reopen of it from the
   *  page (`orchestration_task_reopen`), and no start. */
  failureCheckRetriesUsed: ledger(failureCheckRetriesUsed),
  /** A failed task whose coordinator chat the chat list does not have:
   *  `failed`, `retriesUsed: 0`, `failure.awaits: "person"`, `because:
   *  "coordinator_gone"`. The host takes the person's Start. */
  failureCoordinatorGone: ledger(failureCoordinatorGone),
  /** The same for a review that failed its check once: `completed`,
   *  `verdict: "fail"`, `retriesUsed: 0`, `failure.kind: "check_failed"`,
   *  `because: "coordinator_gone"`. The host takes the person's own reopen,
   *  which owes no notice there. */
  failureCheckCoordinatorGone: ledger(failureCheckCoordinatorGone),
  /** A peer request that failed with its working time used: `failed`,
   *  `peerRequest`, `failure.awaits: "person"`, `because: "time_limit"`.
   *  Only the person's Start gives it more. */
  failureTimeLimit: ledger(failureTimeLimit),
  /** Two running attempts: one with `usage` and `context`, one with neither
   *  key (its chat reported a token count and no window). */
  usageContext: ledger(usageContext),
  /** `orchestration_task_stop`: the task it answers with, and the ledger
   *  after it. */
  taskStopped: (): { answer: OrchestrationTask; snapshot: OrchestrationSnapshot } => JSON.parse(taskStopped),
  /** Two entries of `chat_index_list`: a chat that coordinates a run, and one
   *  that does not (no key at all). */
  coordinatesRun: (): { lead: HostChatEntry; plain: HostChatEntry } => JSON.parse(coordinatesRun),
  /** `chat_plan_get` for a chat with no plan: `revision: 0`, no items, no
   *  `updatedAt`, `updatedBy` or `started`, `awaitsStart: false`. */
  chatPlanNone: plan(chatPlanNone),
  /** Two items being discussed, each with open questions, one with a note:
   *  `awaitsStart: true`. No item has `progress` or `linked`. */
  chatPlanDiscussing: plan(chatPlanDiscussing),
  /** The same plan with every question answered and both items `decided`:
   *  revision 2, still `awaitsStart: true`, no `started`. */
  chatPlanDecided: plan(chatPlanDecided),
  /** A started plan (`started.revision: 1`, `told: true`) at revision 2.
   *  i1 the agent calls `done` while one of its two tasks failed its check;
   *  i2 one running and one waiting; i3 one failed; i4 a replaced task
   *  (`closed`, outside `total`) and its replacement; i5 still discussing,
   *  i6 dropped, i7 added after Start (`addedIn: 2`): none of the three has
   *  `progress` or `linked`. */
  chatPlanStarted: plan(chatPlanStarted),
  /** The line the host wrote into a chat's record when the answers to two
   *  questions Codex asked by itself were handed to it: `via: "native"`, one
   *  question with two options (one described) and one free-text question
   *  (`options: []`), neither with `recommended`. */
  questionAnsweredNative: answered(questionAnsweredNative),
  /** The same line for an `ask_user` call answered while it waited: `via:
   *  "tool"`, a question with `recommended: 1` and one with `multiple:
   *  true`, whose answer is the picked labels joined as the page sent them. */
  questionAnsweredTool: answered(questionAnsweredTool),
  /** A question the host lists (`question_pending`) that shows an image
   *  with a caption and a video, and offers `Keep` with a picture and
   *  `Change` without one; `recommended: 0`. */
  questionMediaPending: (): Question => JSON.parse(questionMediaPending) as Question,
  /** The line for that question answered `Keep` through `ask_user`:
   *  `media` on the question and `image` on the option. */
  questionAnsweredMedia: answered(questionAnsweredMedia),
};
