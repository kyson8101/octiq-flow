// A chat's plan, as the Plan panel reads it.
//
// The host's answer (`lib/chatPlan`, `docs/chat-plan.md`) has three owners
// and the panel shows each as what it is: the agent's list, the person's
// Start, and the host's count of the tasks an item became. Everything here
// is pure: what the header says, what an item's row says, what the Start
// control is, and how answers and events are folded into what the page
// holds. The panel draws these and decides nothing.
//
// Nothing is estimated. A figure the host did not send is absent and its
// part is not drawn; a zero is left out the same way.
import type {
  ChatPlan, ChatPlanItem, ChatPlanProgress, ChatPlanStartAnswer, ChatPlanStatus, ChatPlanTaskState,
} from "./chatPlan";
import type { ChatKind } from "./chatComplete";
import type { OrchestrationSnapshot } from "./orchestration";
import { progressRow, type Waiting } from "./runProgress";

// ---- Who has a plan panel ---------------------------------------------------

/** A plan is kept by a chat's own agent. A worker's task is its plan, a
 *  front desk only routes, and a seat is one voice in a room: the host
 *  refuses all three a change and a Start, so none of them is offered the
 *  panel. */
export function planOffered(kind: ChatKind): boolean {
  return kind === "main";
}

// ---- Counting ----------------------------------------------------------------

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Whether the chat has a plan at all. Revision 0 is the host's "no plan". */
export function hasPlan(plan: ChatPlan | null | undefined): plan is ChatPlan {
  return !!plan && plan.revision > 0 && plan.items.length > 0;
}

/** Still on the plan: an item leaves by being dropped, and stays listed. */
const kept = (item: Pick<ChatPlanItem, "status">) => item.status !== "dropped";

/** Questions still open, on items that are still on the plan. A dropped
 *  item's questions are nobody's any more. */
export function openQuestions(plan: ChatPlan | null | undefined): number {
  if (!plan) return 0;
  return plan.items.filter(kept).reduce((sum, item) => sum + item.questions.length, 0);
}

/** `2 questions still open`, or nothing when there are none. */
export function questionsLine(open: number): string | null {
  return open > 0 ? `${count(open, "question")} still open` : null;
}

// ---- Times --------------------------------------------------------------------

export type Clock = { locale?: string; timeZone?: string };

/** A stamp as a clock time, with the day when it is not today's. Never
 *  "3m ago": nothing ticks in the panel, and a relative time goes stale
 *  where it stands. */
export function stampLabel(at: number, now: number, clock: Clock = {}): string {
  const zone = clock.timeZone ? { timeZone: clock.timeZone } : {};
  const day = (ms: number) => new Date(ms).toLocaleDateString("en-CA", zone);
  const time = new Date(at).toLocaleTimeString(clock.locale, { hour: "numeric", minute: "2-digit", ...zone });
  if (day(at) === day(now)) return time;
  return `${new Date(at).toLocaleDateString(clock.locale, { day: "numeric", month: "short", ...zone })}, ${time}`;
}

/** The whole date and time, for a tooltip and a `<time>`'s title. */
export function stampTitle(at: number, clock: Clock = {}): string {
  return new Date(at).toLocaleString(clock.locale, clock.timeZone ? { timeZone: clock.timeZone } : undefined);
}

// ---- The header ----------------------------------------------------------------

export type PlanHeader = {
  /** `6 items`, with `· 1 dropped` when any were. */
  items: string;
  started: boolean;
  /** `Not started`, or `Started 18:46`. */
  state: string;
  startedAt: number | null;
  /** `Updated 18:46 by OCTIQ HEAD`. */
  updated: string | null;
  updatedAt: number | null;
};

export function planHeader(plan: ChatPlan, now: number, clock: Clock = {}): PlanHeader {
  const on = plan.items.filter(kept).length;
  const dropped = plan.items.length - on;
  const by = plan.updatedBy && plan.updatedBy !== "agent" ? plan.updatedBy : "the agent";
  return {
    items: [count(on, "item"), dropped > 0 ? `${dropped} dropped` : null].filter(Boolean).join(" · "),
    started: !!plan.started,
    state: plan.started ? `Started ${stampLabel(plan.started.at, now, clock)}` : "Not started",
    startedAt: plan.started?.at ?? null,
    updated: plan.updatedAt ? `Updated ${stampLabel(plan.updatedAt, now, clock)} by ${by}` : null,
    updatedAt: plan.updatedAt ?? null,
  };
}

// ---- An item -------------------------------------------------------------------

/** The agent's word for where an item stands. */
export const STATUS_WORD: Record<ChatPlanStatus, string> = {
  discussing: "Discussing",
  decided: "Decided",
  in_progress: "In progress",
  done: "Done",
  dropped: "Dropped",
};

/** How one linked task stands, in the host's count. */
export const TASK_WORD: Record<ChatPlanTaskState, string> = {
  done: "Done",
  running: "Running",
  failed: "Failed",
  waiting: "Waiting",
  closed: "Closed",
};

/** What an item's mark is drawn as. `live` is the accent, and only for an
 *  item with a linked task whose worker has a turn in flight; `done` is the
 *  ok colour, for an item the agent calls done that the host's count does
 *  not contradict; everything else is grey. */
export type PlanMark = "live" | "done" | "dropped" | "quiet";

/** Decisions shown before the rest go behind a disclosure. */
export const DECISIONS_SHOWN = 3;

export type PlanTaskView = {
  id: string;
  runId: string;
  title: string;
  state: ChatPlanTaskState;
  word: string;
  /** Its worker has a turn in flight right now, by the ledger this page holds. */
  live: boolean;
};

export type PlanProgressView = {
  done: number;
  total: number;
  /** `1/2`, or `null` when no linked task counts as work. */
  label: string | null;
  percent: number | null;
  /** What is not done, zero counts left out: `1 running`, `1 failed`. */
  parts: string[];
  /** Counted nowhere else: `1 closed`, `1 not in the ledger`. */
  apart: string[];
  /** The whole of it in words, for a screen reader and the tooltip. */
  spoken: string;
};

export type PlanItemView = {
  id: string;
  title: string;
  status: ChatPlanStatus;
  word: string;
  mark: PlanMark;
  /** The first decisions, and the ones behind `N more decisions`. */
  decisions: string[];
  moreDecisions: string[];
  questions: string[];
  note: string | null;
  progress: PlanProgressView | null;
  tasks: PlanTaskView[];
};

export function progressView(progress: ChatPlanProgress | undefined): PlanProgressView | null {
  if (!progress) return null;
  const parts = [
    progress.running > 0 ? `${progress.running} running` : null,
    progress.failed > 0 ? `${progress.failed} failed` : null,
    progress.waiting > 0 ? `${progress.waiting} waiting` : null,
  ].filter((part): part is string => !!part);
  const apart = [
    progress.closed > 0 ? `${progress.closed} closed` : null,
    progress.unknown > 0 ? `${progress.unknown} not in the ledger` : null,
  ].filter((part): part is string => !!part);
  const counted = progress.total > 0;
  if (!counted && apart.length === 0) return null;
  return {
    done: progress.done,
    total: progress.total,
    label: counted ? `${progress.done}/${progress.total}` : null,
    percent: counted ? Math.round((progress.done / progress.total) * 100) : null,
    parts,
    apart,
    spoken: [
      counted ? `${progress.done} of ${count(progress.total, "task")} done` : null,
      ...parts,
      ...apart,
    ].filter(Boolean).join(", "),
  };
}

/** The linked tasks whose worker has a turn in flight, asked of the run
 *  panel's own reader (`runProgress.progressRow`'s `flight`): running on
 *  this very attempt and executing. The host's `running` also counts an
 *  attempt being prepared, which is not a turn. With no ledger on the page
 *  nothing is in flight: the accent is never a guess. */
export function tasksInFlight(
  plan: ChatPlan | null | undefined,
  snapshot: OrchestrationSnapshot | null | undefined,
  now: number,
  held?: Waiting,
): ReadonlySet<string> {
  const flying = new Set<string>();
  if (!plan || !snapshot) return flying;
  const linked = new Set(plan.items.filter(kept).flatMap((item) => item.tasks));
  if (linked.size === 0) return flying;
  for (const task of snapshot.tasks) {
    if (!linked.has(task.id)) continue;
    const run = snapshot.runs.find((item) => item.id === task.runId);
    if (run && progressRow(snapshot, run, task, now, held).flight) flying.add(task.id);
  }
  return flying;
}

/** Whether the host's count leaves the agent's "done" standing. `done` is
 *  the agent's word and the count is the host's: where they disagree (the
 *  fixture has an item called done whose review failed) both are shown, and
 *  the agent's word does not colour the item as done. An item with no
 *  linked task that counts has nothing to disagree with. */
export function countAgrees(progress: ChatPlanProgress | undefined): boolean {
  return !progress || progress.total === 0 || progress.done === progress.total;
}

function itemView(item: ChatPlanItem, flying: ReadonlySet<string>): PlanItemView {
  const tasks = (item.linked ?? []).map((task) => ({
    ...task,
    word: TASK_WORD[task.state],
    live: flying.has(task.id),
  }));
  const mark: PlanMark = item.status === "dropped" ? "dropped"
    : tasks.some((task) => task.live) ? "live"
      : item.status === "done" && countAgrees(item.progress) ? "done" : "quiet";
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    word: STATUS_WORD[item.status],
    mark,
    decisions: item.decisions.slice(0, DECISIONS_SHOWN),
    moreDecisions: item.decisions.slice(DECISIONS_SHOWN),
    // A dropped item's questions are kept on its row, and asked of nobody.
    questions: item.questions,
    note: item.note?.trim() ? item.note : null,
    progress: item.status === "dropped" ? null : progressView(item.progress),
    tasks: item.status === "dropped" ? [] : tasks,
  };
}

/** The items in the host's order, dropped ones last and in their order. */
export function planItems(plan: ChatPlan, flying: ReadonlySet<string> = new Set()): PlanItemView[] {
  const views = plan.items.map((item) => itemView(item, flying));
  return [...views.filter((item) => item.status !== "dropped"), ...views.filter((item) => item.status === "dropped")];
}

/** `2 more decisions`. */
export function moreDecisionsLabel(more: number): string {
  return `${more} more ${more === 1 ? "decision" : "decisions"}`;
}

/** `2 tasks`, the label of the disclosure that lists an item's tasks. */
export function tasksLabel(tasks: number): string {
  return count(tasks, "task");
}

// ---- Start ---------------------------------------------------------------------

/** The one control at the foot of the panel.
 *
 *  - `start`: the host says Start can be pressed (`awaitsStart`). The
 *    person's Start. Never worked out from the items here.
 *  - `tell`: started, and the turn that tells the agent could not be handed
 *    over (`started.told` is false). Both halves are said apart, never
 *    "Started" alone. The control sends the same command again: the host
 *    tries the turn under a new id and records nothing twice.
 *  - `started`: started and the agent has its turn. Nothing to press.
 *  - `nothing`: a plan that was not started and that the host would not
 *    start (every item dropped). Said in words; no dead button.
 *  - `none`: no plan. */
export type PlanStart =
  | { kind: "none" }
  | { kind: "nothing"; state: string }
  | { kind: "start"; revision: number; label: "Start"; questions: string | null; off: string | null }
  | { kind: "tell"; revision: number; label: "Tell the agent"; state: string; note: string; off: string | null }
  | { kind: "started"; state: string };

export const NOT_TOLD = "the agent has not been told yet";
export const NOTHING_TO_START = "Nothing to start";
export const NOT_CONNECTED = "Not connected.";

export function planStart(
  plan: ChatPlan | null | undefined,
  now: number,
  live: { connected: boolean } = { connected: true },
  clock: Clock = {},
): PlanStart {
  if (!plan) return { kind: "none" };
  const off = live.connected ? null : NOT_CONNECTED;
  if (plan.started) {
    const state = `Started ${stampLabel(plan.started.at, now, clock)}`;
    if (plan.started.told) return { kind: "started", state };
    return { kind: "tell", revision: plan.revision, label: "Tell the agent", state, note: NOT_TOLD, off };
  }
  // The host's own word for "Start can be pressed": not started, and at
  // least one item is not dropped.
  if (!plan.awaitsStart) return plan.items.length > 0 ? { kind: "nothing", state: NOTHING_TO_START } : { kind: "none" };
  return { kind: "start", revision: plan.revision, label: "Start", questions: questionsLine(openQuestions(plan)), off };
}

/** What a Start's answer leaves to say under the control. `null` when the
 *  agent has its turn. */
export function startNote(answer: ChatPlanStartAnswer): string | null {
  return answer.delivered ? null : answer.notDelivered;
}

// ---- What the page holds ---------------------------------------------------------

/** One chat's plan as this page last heard it. `rev` goes up with every
 *  word from the host about the chat, so a read that was in the air when an
 *  event arrived cannot put the older answer back. */
export type PlanHeld = { plan: ChatPlan | null; error: string | null; rev: number };
export type Plans = Readonly<Record<string, PlanHeld>>;

export const NO_PLANS: Plans = {};
const UNREAD: PlanHeld = { plan: null, error: null, rev: 0 };

export type PlanAction =
  /** `chat_plan_get` answered. `rev` is the chat's `rev` when it was asked. */
  | { type: "read"; chatId: string; plan: ChatPlan; rev: number }
  | { type: "unread"; chatId: string; error: string; rev: number }
  /** The `chat-plan` event. */
  | { type: "said"; chatId: string; plan: ChatPlan }
  /** The plan in `chat_plan_start`'s answer. */
  | { type: "answered"; chatId: string; plan: ChatPlan };

/** Whether `next` says less than `held`: an older revision, or the same
 *  list with less of the Start on it. A Start's answer can arrive after the
 *  events that followed it. */
function behind(next: ChatPlan, held: ChatPlan | null): boolean {
  if (!held) return false;
  if (next.revision !== held.revision) return next.revision < held.revision;
  if (!!next.started !== !!held.started) return !next.started;
  return !!held.started?.told && !next.started?.told;
}

export function reducePlans(plans: Plans, action: PlanAction): Plans {
  const held = plans[action.chatId] ?? UNREAD;
  switch (action.type) {
    case "read":
      // Something was said since this was asked: what was said stands.
      if (action.rev !== held.rev) return plans;
      return { ...plans, [action.chatId]: { plan: action.plan, error: null, rev: held.rev } };
    case "unread":
      if (action.rev !== held.rev) return plans;
      // A failed read keeps the last plan the page heard, and says so.
      return { ...plans, [action.chatId]: { ...held, error: action.error } };
    case "said":
      return { ...plans, [action.chatId]: { plan: action.plan, error: null, rev: held.rev + 1 } };
    case "answered":
      if (behind(action.plan, held.plan)) return plans;
      return { ...plans, [action.chatId]: { plan: action.plan, error: null, rev: held.rev + 1 } };
  }
}

/** What of the ledger an item's count is made from, as one string: the
 *  page reads the plan again when this changes and at no other tick
 *  (`docs/chat-plan.md`: the count moves with the ledger and no event says
 *  so). Empty for a plan that links no task, which is never read again for
 *  the ledger's sake. */
export function ledgerSignature(plan: ChatPlan | null | undefined, snapshot: OrchestrationSnapshot | null | undefined): string {
  if (!plan || !snapshot) return "";
  const linked = new Set(plan.items.flatMap((item) => item.tasks));
  if (linked.size === 0) return "";
  const runs = new Set<string>();
  const tasks = snapshot.tasks.filter((task) => linked.has(task.id)).map((task) => {
    runs.add(task.runId);
    const attempts = snapshot.attempts.filter((attempt) => attempt.taskId === task.id)
      .map((attempt) => `${attempt.id}=${attempt.status}`).join(",");
    return [task.id, task.status, task.activeAttemptId ?? "", task.supersededBy ?? "", attempts].join(":");
  });
  const states = snapshot.runs.filter((run) => runs.has(run.id))
    .map((run) => [run.id, run.status, run.archivedAt ?? "", run.closedAt ?? ""].join(":"));
  return [...tasks, ...states].join("|");
}
