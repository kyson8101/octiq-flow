// Who a run is waiting on.
//
// "Needs you" is a fact or it is not said. A wait is the person's in exactly
// three cases:
//
// - the run's plan has a revision to approve;
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
// One function reads all of it (`runWaits`), and the strip above the
// composer, the Agents panel's rows and the badges are all drawn from what it
// returns, so they cannot disagree.
import {
  isPeerRequestGate, type Awaits, type NativeDecision, type OrchestrationGate, type OrchestrationRun,
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

export type WaitKind = "plan" | "gate" | "permission" | "safety" | "outage" | "question" | "delivery" | "handover" | "native";

/** One thing a run waits for. `key` is the host's identity for it, the one a
 *  badge and a card carry, so the same decision is never counted twice. */
export type Wait = { key: string; kind: WaitKind; on: WaitsOn; taskId?: string };

export type Waits = { person: Wait[]; coordinator: Wait[]; nobody: Wait[]; unsaid: Wait[] };

export type RunWaits = Waits & {
  /** The same waits, for the task they belong to. A wait of the run itself
   *  (its plan, a gate with no task) is in the lists above only. */
  tasks: ReadonlyMap<string, Waits>;
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
 *  | pending native decision the page has a card for | person (the card, once) |
 *  | pending native decision, `awaits: "person"`  | person      |
 *  | pending native decision, `awaits: "coordinator"` | coordinator |
 *  | pending native decision, `awaits: "nobody"`  | nobody      |
 *  | pending native decision, no `awaits`, no card | unsaid     |
 *
 *  A run that is stopped, closed or archived waits for nothing: it retries
 *  nothing, so what it left is history. */
export function runWaits(snapshot: OrchestrationSnapshot, run: OrchestrationRun, held?: Waiting): RunWaits {
  const all = none();
  const tasks = new Map<string, Waits>();
  if (run.archivedAt != null || run.status === "stopped" || run.status === "closed") return { ...all, tasks };

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
  const plan = planWaits(run, own);
  if (plan) add({ key: plan, kind: "plan", on: "person" });

  for (const gate of snapshot.gates) {
    if (gate.runId !== run.id || gate.status !== "open") continue;
    add({ key: `gate:${gate.id}`, kind: "gate", on: gateWaitsOn(gate, own), taskId: gate.taskId });
  }

  // The cards before the ledger's own record of them: a native decision and
  // its safety card are one thing under one key, and the card is the one the
  // person can answer.
  for (const task of own) {
    for (const card of held?.get(task.id) ?? []) {
      if (CARDS.has(card.kind)) add({ key: card.key, kind: card.kind as WaitKind, on: "person", taskId: task.id });
    }
  }

  const live = new Set(own.flatMap((task) => task.activeAttemptId ? [task.activeAttemptId] : []));
  for (const decision of snapshot.nativeDecisions ?? []) {
    if (decision.runId !== run.id || decision.status !== "pending" || !live.has(decision.attemptId)) continue;
    // An outage's refusals are on one card, under the group's id.
    add({ key: `safety:${decision.groupId || decision.id}`, kind: "native", on: decisionWaitsOn(decision), taskId: decision.taskId });
  }
  return { ...all, tasks };
}
