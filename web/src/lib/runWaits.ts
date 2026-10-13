// Who a run is waiting on.
//
// "Needs you" is a fact or it is not said. A wait is the person's in exactly
// four cases:
//
// - the run's plan has a revision to approve;
// - a task's failure is theirs to decide, as the host says
//   (`orchestration.failureMove`): its retries are used, its coordinator put
//   it to them or is gone. It is one decision: the gate the coordinator
//   opened about it when there is one, else the failure itself;
// - the page itself holds a card for the worker (a permission, safety or
//   question card, an answer that could not be delivered, a handover): the
//   buttons that answer it are on the person's screen;
// - the host says so: an open gate or a pending native decision whose
//   `awaits` is "person".
//
// Everything else is somebody else's, and is said in its own words. `awaits`
// "coordinator" is the run's own agent dealing with it. "nobody" is a refusal
// no one can approve, which the worker was told about and goes on past. A
// host that does not send `awaits` leaves an open gate or a pending native
// decision "unsaid": it is on the ledger, it is shown, and it is never
// counted as the person's.
//
// One function reads all of it (`runWaits`), and every surface that says or
// counts a wait is drawn from what it returns, so they cannot disagree: the
// strip above the composer, the Agents panel's rows, its decision boxes and
// its "N to decide", the Tasks button, the chat list's line and its badge
// (`lib/pendingActions`), and the Agents page.
//
// This module is also the ONLY reader of the ledger's `gates` and
// `nativeDecisions`. Anything else that needs one asks for it here
// (`openGates`, `taskDecisions`, `pendingDecisions`), so a second reading of
// who is waited on cannot be written beside this one without a test failing
// (`runWaits.surfaces.test.tsx`).
import {
  failureMove, isPeerRequestGate, type Awaits, type NativeDecision, type OrchestrationGate, type OrchestrationRun,
  type OrchestrationSnapshot, type OrchestrationTask,
} from "./orchestration";
import { planTasks } from "./planReview";

export type WaitsOn = Awaits | "unsaid";

/** What the tooltip says of a wait the host put no name to. */
export const UNSAID_NOTE = "The host does not say who this waits on.";

const SAID: ReadonlySet<string> = new Set<Awaits>(["person", "coordinator", "nobody"]);

const said = (value: unknown): Awaits | null => (typeof value === "string" && SAID.has(value) ? value as Awaits : null);

/** Who an open gate waits on. A gate on a peer request is the person's on
 *  any host: the host takes its answer from the person's page and from no
 *  agent (`isPeerRequestGate`), which is a rule and not a guess. */
export function gateWaitsOn(
  gate: Pick<OrchestrationGate, "taskId" | "awaits">,
  tasks: readonly Pick<OrchestrationTask, "id" | "peerRequest">[],
): WaitsOn {
  return said(gate.awaits) ?? (isPeerRequestGate(gate, tasks) ? "person" : "unsaid");
}

/** Who a pending native decision waits on. */
export function decisionWaitsOn(decision: Pick<NativeDecision, "awaits">): WaitsOn {
  return said(decision.awaits) ?? "unsaid";
}

const LIVE_RUNS = new Set(["planning", "running", "waiting"]);

/** The key of the plan revision a run has waiting for approval, or `null`.
 *  An empty plan cannot be approved yet: the lead is still writing it. */
export function planWaits(run: OrchestrationRun, tasks: readonly OrchestrationTask[]): string | null {
  if (run.planApproval?.status !== "pending" || !LIVE_RUNS.has(run.status) || run.archivedAt != null) return null;
  if (planTasks(tasks.filter((task) => task.runId === run.id)).length === 0) return null;
  return `plan:${run.id}:${run.planApproval.revision ?? 0}`;
}

/** A card the page holds for the person, under the host's identity for it
 *  (`lib/pendingActions`). */
export type Held = { key: string; kind: string };

/** The cards the page holds, per task. */
export type Waiting = ReadonlyMap<string, readonly Held[]>;

export type WaitKind = "plan" | "gate" | "failure" | "permission" | "safety" | "outage" | "question" | "delivery" | "handover" | "native";

/** One thing a run waits for. `key` is the host's identity for it, the one a
 *  badge and a card carry, so the same decision is never counted twice.
 *  `card` is the kind of card a native decision is answered on. */
export type Wait = {
  key: string; kind: WaitKind; on: WaitsOn; runId: string; taskId?: string; card?: "safety" | "outage";
  /** The decision of a task's failure: the failure itself, or the gate its
   *  coordinator opened about it. A task in failure has exactly one. */
  failure?: true;
};

export type Waits = { person: Wait[]; coordinator: Wait[]; nobody: Wait[]; unsaid: Wait[] };

export type RunWaits = Waits & {
  /** The same waits, for the task they belong to. A wait of the run itself
   *  (its plan, a gate with no task) is in the lists above only. */
  tasks: ReadonlyMap<string, Waits>;
  /** The tasks an open gate is parked on, whoever it waits on and whatever
   *  became of the run: such a task is held by its decision, not stuck. */
  gated: ReadonlySet<string>;
  /** The run is stopped, closed or archived: what the ledger alone records
   *  for it is history and is in none of the lists. */
  ended: boolean;
};

const none = (): Waits => ({ person: [], coordinator: [], nobody: [], unsaid: [] });

export const NO_WAITS: Waits = none();

/** The kinds of card the page holds. A gate and a plan are read off the
 *  ledger here, whatever a list of cards says of them. */
const CARDS: ReadonlySet<string> = new Set(["permission", "safety", "outage", "question", "delivery", "handover"]);

/** Everything one run waits for, and on whom. The table:
 *
 *  | what is waiting                              | on          |
 *  |----------------------------------------------|-------------|
 *  | plan revision pending (run live, plan drawn) | person      |
 *  | a card the page holds for a worker           | person      |
 *  | open gate, `awaits: "person"`                | person      |
 *  | open gate on a peer request, no `awaits`     | person      |
 *  | open gate, `awaits: "coordinator"`           | coordinator |
 *  | open gate, `awaits: "nobody"`                | nobody      |
 *  | open gate, no `awaits`                       | unsaid      |
 *  | open gate about a failed task (`aboutTaskId`) | as above, for that task's row |
 *  | a failure the host says is the person's, no such gate | person (the failure, once) |
 *  | pending native decision the page has a card for | person (the card, once) |
 *  | pending native decision, `awaits: "person"`  | person      |
 *  | pending native decision, `awaits: "coordinator"` | coordinator |
 *  | pending native decision, `awaits: "nobody"`  | nobody      |
 *  | pending native decision, no `awaits`, no card | unsaid     |
 *
 *  What the ledger alone records (a plan, a gate, a native decision) is
 *  history once the run is stopped, closed or archived: it retries nothing.
 *  A card the page still holds is not: its buttons are on the person's
 *  screen, so it is theirs whatever became of the run. */
export function runWaits(snapshot: OrchestrationSnapshot, run: OrchestrationRun, held?: Waiting): RunWaits {
  const all = none();
  const tasks = new Map<string, Waits>();
  const seen = new Set<string>();
  const add = (wait: Wait) => {
    if (seen.has(wait.key)) return;
    seen.add(wait.key);
    all[wait.on].push(wait);
    if (!wait.taskId) return;
    let mine = tasks.get(wait.taskId);
    if (!mine) tasks.set(wait.taskId, mine = none());
    mine[wait.on].push(wait);
  };

  const own = snapshot.tasks.filter((task) => task.runId === run.id);
  const open = openGates(snapshot, run.id);
  const gated = new Set(open.flatMap((gate) => gate.taskId ? [gate.taskId] : []));
  // The cards before the ledger's own record of them: a native decision and
  // its safety card are one thing under one key, and the card is the one the
  // person can answer.
  const cards = () => {
    for (const task of own) {
      for (const card of held?.get(task.id) ?? []) {
        if (CARDS.has(card.kind)) add({ key: card.key, kind: card.kind as WaitKind, on: "person", runId: run.id, taskId: task.id });
      }
    }
  };
  if (run.archivedAt != null || run.status === "stopped" || run.status === "closed") {
    cards();
    return { ...all, tasks, gated, ended: true };
  }

  const plan = planWaits(run, own);
  if (plan) add({ key: plan, kind: "plan", on: "person", runId: run.id });
  // A gate the coordinator opened about a failed task is no task's own
  // (nothing of the task waits on it, so it is not in `gated`), and it is
  // that task's decision: said on its row, and counted once, as the gate.
  const asked = new Set<string>();
  for (const gate of open) {
    const about = !gate.taskId && gate.aboutTaskId && own.some((task) => task.id === gate.aboutTaskId) ? gate.aboutTaskId : undefined;
    const on = gateWaitsOn(gate, own);
    if (about && on === "person") asked.add(about);
    add({ key: `gate:${gate.id}`, kind: "gate", on, runId: run.id, taskId: gate.taskId ?? about, ...(about ? { failure: true as const } : {}) });
  }
  // A failure the host says waits on the person is a decision of theirs.
  // With no gate that asks it, the failure is the decision itself.
  for (const task of own) {
    if (failureMove(task) === "person" && !asked.has(task.id)) {
      add({ key: `failure:${task.id}`, kind: "failure", on: "person", runId: run.id, taskId: task.id, failure: true });
    }
  }
  cards();

  const live = new Set(own.flatMap((task) => task.activeAttemptId ? [task.activeAttemptId] : []));
  for (const decision of snapshot.nativeDecisions ?? []) {
    if (decision.runId !== run.id || decision.status !== "pending" || !live.has(decision.attemptId)) continue;
    // An outage's refusals are on one card, under the group's id.
    add({
      key: `safety:${decision.groupId || decision.id}`, kind: "native", on: decisionWaitsOn(decision),
      runId: run.id, taskId: decision.taskId, card: decision.kind === "outage" ? "outage" : "safety",
    });
  }
  return { ...all, tasks, gated, ended: false };
}

/** Every run of a snapshot, read once: the whole ledger, or one chat's own
 *  (`chatWorkflow.chatSnapshot`). `person` is what waits on the person
 *  across them, once each, and is the number every surface says. */
export type LedgerWaits = { runs: ReadonlyMap<string, RunWaits>; person: Wait[] };

export function ledgerWaits(snapshot: OrchestrationSnapshot, held?: Waiting): LedgerWaits {
  const runs = new Map<string, RunWaits>();
  const person: Wait[] = [];
  const seen = new Set<string>();
  for (const run of snapshot.runs) {
    const waits = runWaits(snapshot, run, held);
    runs.set(run.id, waits);
    for (const wait of waits.person) {
      if (seen.has(wait.key)) continue;
      seen.add(wait.key);
      person.push(wait);
    }
  }
  return { runs, person };
}

/* ---- The ledger's own records, for whoever draws them ------------------ */

/** The open gates of a run, as the ledger has them. Whose each is, and
 *  whether it is counted, is `runWaits`' to say. */
export function openGates(snapshot: Pick<OrchestrationSnapshot, "gates">, runId: string): OrchestrationGate[] {
  return snapshot.gates.filter((gate) => gate.runId === runId && gate.status === "open");
}

/** Whether an open gate holds this task. */
export function taskGated(snapshot: Pick<OrchestrationSnapshot, "gates">, taskId: string): boolean {
  return snapshot.gates.some((gate) => gate.taskId === taskId && gate.status === "open");
}

/** Every native decision recorded for a task, settled ones included: its
 *  history, not a wait. */
export function taskDecisions(snapshot: Pick<OrchestrationSnapshot, "nativeDecisions">, taskId: string): NativeDecision[] {
  return (snapshot.nativeDecisions ?? []).filter((decision) => decision.taskId === taskId);
}

/** What a row says of the native decision its attempt is parked on: a short
 *  label, and the lines of its tooltip.
 *
 *  Who must decide and whether the attempt can go on are two facts, and the
 *  host says both: `awaits`, and `continuation` with `recovery` for why. The
 *  page used to work the second out for itself ("cannot continue; a new
 *  attempt is needed"), which was false for the two cases the host really
 *  sends as `unavailable`: a card the person still has to answer on an
 *  attempt that is also blocked on a gate, and a refusal the worker carries
 *  on past. So the reason is the host's own sentence, and "cannot resume" is
 *  never said of a decision that is the person's. */
export function decisionSummary(decision: NativeDecision): { label: string; lines: string[] } {
  const on = decisionWaitsOn(decision);
  const stuck = decision.continuation === "unavailable";
  const label = on === "person" ? "Native decision"
    : on === "nobody" ? "Refusal recorded"
      : stuck ? "Decision recorded · cannot resume" : "Native decision";
  const recovery = decision.recovery?.trim();
  return {
    label,
    lines: [
      `Native decision ${decision.id}`,
      decision.reason,
      decision.blockedAction ? `Action: ${decision.blockedAction}` : "The provider gave no exact action.",
      recovery || (decision.continuation === "new_turn_same_attempt" ? "Answering resumes this same attempt."
        : stuck ? "The host says this attempt cannot continue from here." : "Whether it can resume is not known."),
    ],
  };
}

/** The native decisions an attempt is parked on. */
export function pendingDecisions(snapshot: Pick<OrchestrationSnapshot, "nativeDecisions">, attemptId: string): NativeDecision[] {
  return (snapshot.nativeDecisions ?? []).filter((decision) => decision.attemptId === attemptId && decision.status === "pending");
}
