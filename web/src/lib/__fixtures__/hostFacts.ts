// The ledger as the host really serialises it.
//
// Each file under `host/` is what one of the host's own tests answered, taken
// verbatim (see `host/README.md` for which test and how to record it again).
// Never hand-edit them: a page fixture written by hand is how the page came
// to be built against fields the host does not send that way. A test that
// needs another moment of the same ledger changes a copy, in the test, and
// says what it changed.
import type { OrchestrationSnapshot, OrchestrationTask } from "../orchestration";
import cardOnGateBlocked from "./host/card_on_gate_blocked.json?raw";
import cardPending from "./host/card_pending.json?raw";
import claudeRefusal from "./host/claude_refusal.json?raw";
import coordinatesRun from "./host/coordinates_run.json?raw";
import gatesOpen from "./host/gates_open.json?raw";
import heldByPlan from "./host/held_by_plan.json?raw";
import heldByReopen from "./host/held_by_reopen.json?raw";
import peerGate from "./host/peer_gate.json?raw";
import reopenNoticeDelivered from "./host/reopen_notice_delivered.json?raw";
import taskStopped from "./host/task_stopped.json?raw";
import usageContext from "./host/usage_context.json?raw";

/** A fresh copy each time: a test may change what it is given. */
const ledger = (raw: string) => (): OrchestrationSnapshot => JSON.parse(raw) as OrchestrationSnapshot;

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
  /** Two running attempts: one with `usage` and `context`, one with neither
   *  key (its chat reported a token count and no window). */
  usageContext: ledger(usageContext),
  /** `orchestration_task_stop`: the task it answers with, and the ledger
   *  after it. */
  taskStopped: (): { answer: OrchestrationTask; snapshot: OrchestrationSnapshot } => JSON.parse(taskStopped),
  /** Two entries of `chat_index_list`: a chat that coordinates a run, and one
   *  that does not (no key at all). */
  coordinatesRun: (): { lead: HostChatEntry; plain: HostChatEntry } => JSON.parse(coordinatesRun),
};
