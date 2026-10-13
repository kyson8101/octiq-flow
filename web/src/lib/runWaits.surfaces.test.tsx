// One fact, every surface.
//
// "The person is waited on" is decided in `lib/runWaits` and nowhere else.
// This file is the proof: one table of ledger shapes, on a host that says
// who a wait is on (`awaits`) and on one that does not, with the page's card
// list delivered, not arrived yet, or failed, and for each shape EVERY
// surface that says or counts a wait is asked the same two things:
//
//   - how many decisions wait on the person, where the surface draws a count;
//   - whether anything does, where it only says so.
//
// The surfaces, each read the way the page reads it (drawn to markup where
// the surface is a component):
//
//   strip          the line above the composer        chatStrip + RunProgressStrip
//   rows           the Agents panel's task rows        runProgress (+ the boxes above them)
//   boxes          the panel's plan card and "Needs you" gate box   OrchestrationPanel
//   toDecide       the panel's "N to decide"           OrchestrationPanel (runAttention)
//   tasksButton    the top bar's Tasks button          taskColumnCounts + TasksButton
//   sidebarLine    the chat list's "Needs you" line    Sidebar (chatRunStatus)
//   sidebarBadge   the chat list's badge               Sidebar (pendingActions)
//   pendingActions the list every badge is drawn from  pendingReading
//   agentsPage     the Agents page's roster            agentRoster
//
// A second test scans the source: only `lib/runWaits.ts` may read the
// ledger's gates, its native decisions, or a record's `awaits`.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("./bridge", () => ({
  bridge: { invoke: async () => null, on: () => () => {}, onState: () => () => {} },
}));

import { agentRoster } from "./agentsDashboard";
import type { TeamAgent } from "./agentsMode";
import { chatRunStatus, chatSnapshot, rowRun } from "./chatWorkflow";
import { hostFacts } from "./__fixtures__/hostFacts";
import {
  EMPTY_ORCHESTRATION, workerChatParents,
  type NativeDecision, type OrchestrationAttempt, type OrchestrationGate, type OrchestrationRun,
  type OrchestrationSnapshot, type OrchestrationTask,
} from "./orchestration";
import { pendingByRow, pendingByTask, pendingReading, type PendingActionInput } from "./pendingActions";
import { runAttention, taskColumnCounts } from "./runPanel";
import { chatStrip, groupHeading, runProgress } from "./runProgress";
import { ledgerWaits, runWaits } from "./runWaits";
import type { Conversation } from "./store";
import { TasksButton } from "../components/ChatWorkflowBar";
import { OrchestrationPanel } from "../components/OrchestrationPanel";
import { PendingActionsContext, type PendingActionsView } from "../components/PendingActionBadge";
import { RunProgressStrip } from "../components/RunProgressStrip";
import { Sidebar } from "../components/Sidebar";

const NOW = 10_000_000;
const MAIN = "chat:main";

/* ---- A ledger, piece by piece ------------------------------------------ */

const run = (over: Partial<OrchestrationRun> = {}): OrchestrationRun => ({
  id: "run_1", objective: "Ship the roster", coordinatorChatKey: MAIN, workspaceId: "p1", rootPath: "/repo",
  status: "running", maxConcurrent: 4, createdAt: 100, updatedAt: 100, ...over,
});
/** A task with a registered owner, so the Agents page has a row for it. */
const task = (id: string, over: Partial<OrchestrationTask> = {}): OrchestrationTask => ({
  id, runId: "run_1", title: `Task ${id}`, spec: "", dependsOn: [], status: "running", activeAttemptId: `at_${id}`,
  assignee: { id: "fe", name: "OCTIQ FE" }, createdAt: 1, updatedAt: 1, ...over,
});
const attempt = (taskId: string, over: Partial<OrchestrationAttempt> = {}): OrchestrationAttempt => ({
  id: `at_${taskId}`, runId: "run_1", taskId, number: 1, workerChatKey: `chat:orch-${taskId}`, agent: "codex", access: "auto",
  status: "running", cwd: "/repo", branch: "b", isWorktree: true, filesModified: [], createdAt: 1, updatedAt: 1,
  execution: { state: "executing", retryCount: 0 }, ...over,
});
const gate = (id: string, over: Partial<OrchestrationGate> = {}): OrchestrationGate => ({
  id, runId: "run_1", createdByChatKey: "chat:orch-a", targetChatKey: MAIN, question: "Which schema?", options: [],
  status: "open", createdAt: 1, updatedAt: 1, ...over,
});
/** A pending native decision on the task's current attempt. */
const native = (id: string, taskId: string, over: Partial<NativeDecision> = {}): NativeDecision => ({
  id, runId: "run_1", taskId, attemptId: `at_${taskId}`, chatKey: `chat:orch-${taskId}`, reason: "Refused", blockedAction: "git push",
  status: "pending", continuation: "unverified", recovery: "", observedAt: 1, ...over,
});
const ledger = (over: Partial<OrchestrationSnapshot> = {}): OrchestrationSnapshot => ({
  ...EMPTY_ORCHESTRATION, runs: [run()], tasks: [task("a"), task("b", { status: "pending", activeAttemptId: undefined })],
  attempts: [attempt("a")], ...over,
});
/** One worker parked on a tool call, as the host reports a refusal. */
const parked = (over: Partial<OrchestrationSnapshot> = {}): OrchestrationSnapshot =>
  ledger({ attempts: [attempt("a", { execution: { state: "waiting_tool", retryCount: 0 } })], ...over });

type Cards = Pick<PendingActionInput, "asks" | "safetyBlocks" | "questions" | "accessRequests" | "handovers">;

/** The page's safety card for a native decision, as `safety_block_pending`
 *  lists it: a Codex block the person can continue. */
const codexCard = (id: string, taskId = "a"): Cards => ({ safetyBlocks: { [`orch-${taskId}`]: [{ id, provider: "codex", kind: "judged" }] } });
/** A worker's Claude refusal nobody can approve: the page folds it away. */
const quietCard = (id: string, taskId = "a"): Cards => ({ safetyBlocks: { [`orch-${taskId}`]: [{ id, provider: "claude", kind: "judged" }] } });

/** One of the host's own ledgers, set in this table's chat and project. Two
 *  ids are renamed (the run's coordinator becomes `MAIN`, its project `p1`)
 *  and every task is handed to the table's worker, because the Agents page
 *  lists a task under the agent it was handed to and the host's tests hand
 *  most of theirs to nobody. Nothing a wait is read from is touched. */
function real(snapshot: OrchestrationSnapshot): OrchestrationSnapshot {
  const coordinator = JSON.stringify(snapshot.runs[0].coordinatorChatKey);
  const renamed = JSON.parse(JSON.stringify(snapshot).replaceAll(coordinator, JSON.stringify(MAIN))) as OrchestrationSnapshot;
  return {
    ...renamed,
    runs: renamed.runs.map((item) => ({ ...item, workspaceId: "p1" })),
    tasks: renamed.tasks.map((item) => ({ ...item, assignee: { id: "fe", name: "OCTIQ FE" } })),
  };
}

/* ---- The table --------------------------------------------------------- */

type Shape = {
  name: string;
  /** Whether this host says who a wait is on. */
  host: "old" | "new";
  ledger: OrchestrationSnapshot;
  cards?: Cards;
  /** Decisions waiting on the person. Written by hand, never computed. */
  person: number;
};

/** The three states of the page's card list for one decision. `failed` is
 *  what the page holds after its request failed: the journal is cancelled
 *  and the list is as empty as before it was asked for. */
const cardList = (name: string, host: Shape["host"], shape: OrchestrationSnapshot, card: Cards, person: { delivered: number; without: number }): Shape[] => [
  { name: `${name}, card list delivered`, host, ledger: shape, cards: card, person: person.delivered },
  { name: `${name}, card list not arrived`, host, ledger: shape, person: person.without },
  { name: `${name}, card list failed`, host, ledger: shape, cards: { safetyBlocks: {} }, person: person.without },
];

const SEVERAL = ledger({
  tasks: [
    ...["a", "b", "c", "d"].map((id) => task(id)),
    ...Array.from({ length: 13 }, (_, index) => task(`done${index}`, { status: "completed", activeAttemptId: undefined })),
    ...Array.from({ length: 5 }, (_, index) => task(`plan${index}`, { status: "pending", activeAttemptId: undefined })),
  ],
  attempts: ["a", "b", "c", "d"].map((id) => attempt(id)),
});
const OLD_RUN = (() => {
  const old = run({ id: "run_old", createdAt: 50 });
  return {
    run: old,
    tasks: [task("old", { runId: "run_old", status: "blocked" })],
    attempts: [attempt("old", { runId: "run_old", status: "blocked", execution: { state: "blocked", retryCount: 0 } })],
  };
})();

const SHAPES: Shape[] = [
  // The reviewer's truth table, on a host that does not say who is waited on.
  { name: "all planned", host: "old", person: 0, ledger: ledger({ tasks: [task("a", { status: "pending", activeAttemptId: undefined })], attempts: [] }) },
  { name: "one executing", host: "old", person: 0, ledger: ledger() },
  { name: "several executing", host: "old", person: 0, ledger: SEVERAL },
  { name: "ordinary gate, no awaits", host: "old", person: 0, ledger: ledger({ gates: [gate("g", { taskId: "a" })] }) },
  { name: "plan revision pending", host: "old", person: 1, ledger: ledger({ runs: [run({ planApproval: { status: "pending", revision: 2, requestedAt: 1 } })] }) },
  { name: "stalled", host: "old", person: 0, ledger: ledger({ attempts: [attempt("a", { execution: { state: "stalled", retryCount: 0 } })] }) },
  { name: "failed beside running", host: "old", person: 0, ledger: ledger({ tasks: [task("a"), task("f", { status: "failed" })], attempts: [attempt("a"), attempt("f", { status: "failed", execution: { state: "failed", retryCount: 0 } })] }) },
  { name: "completed review, verdict fail", host: "old", person: 0, ledger: ledger({ tasks: [task("a", { status: "completed", kind: "review", verdict: "fail" })], attempts: [attempt("a", { status: "completed", execution: { state: "completed", retryCount: 0 } })] }) },
  { name: "review reopened, ready", host: "old", person: 0, ledger: ledger({ tasks: [task("a", { status: "ready", kind: "review", activeAttemptId: undefined })], attempts: [attempt("a", { status: "completed", execution: { state: "completed", retryCount: 0 } })] }) },
  { name: "reopened and running on a new attempt", host: "old", person: 0, ledger: ledger({ tasks: [task("a", { kind: "review", activeAttemptId: "at_a2" })], attempts: [attempt("a", { status: "completed", execution: { state: "completed", retryCount: 0 } }), attempt("a", { id: "at_a2", number: 2 })] }) },
  { name: "superseded failure", host: "old", person: 0, ledger: ledger({ tasks: [task("a"), task("f", { status: "failed", supersededBy: "a" })], attempts: [attempt("a"), attempt("f", { status: "failed" })] }) },
  { name: "everything done", host: "old", person: 0, ledger: ledger({ runs: [run({ status: "completed" })], tasks: [task("a", { status: "completed" })], attempts: [attempt("a", { status: "completed", execution: { state: "completed", retryCount: 0 } })] }) },
  // History: a stopped run's gate and refusal are records, whatever they say.
  { name: "stopped run, with a gate and a refusal left open", host: "new", person: 0, ledger: parked({ runs: [run({ status: "stopped" })], gates: [gate("g", { taskId: "a", awaits: "person" })], nativeDecisions: [native("nd", "a", { awaits: "person" })] }) },
  ...cardList("pending native decision, no awaits", "old", parked({ nativeDecisions: [native("nd", "a")] }), codexCard("nd"), { delivered: 1, without: 0 }),
  { name: "new run running, older run with the person's gate", host: "new", person: 1, ledger: ledger({
    runs: [run(), OLD_RUN.run], tasks: [task("a"), ...OLD_RUN.tasks], attempts: [attempt("a"), ...OLD_RUN.attempts],
    gates: [gate("g", { runId: "run_old", taskId: "old", awaits: "person" })],
  }) },
  { name: "quiet refusal, card on the page", host: "old", person: 0, ledger: parked({ attempts: [attempt("a", { agent: "claude" })], nativeDecisions: [native("nd", "a")] }), cards: quietCard("nd") },
  { name: "two permission cards of one worker", host: "old", person: 2, ledger: parked(), cards: { asks: { "orch-a": [{ id: "p1" }, { id: "p2" }] } } },
  { name: "peer-request gate, no awaits", host: "old", person: 1, ledger: ledger({
    tasks: [task("a", { status: "blocked", peerRequest: { requestedBy: { id: "p", name: "P" }, requesterChatKey: "chat:p", output: "o", maxMinutes: 5, requestedAt: 1 } as OrchestrationTask["peerRequest"] })],
    gates: [gate("g", { taskId: "a" })],
  }) },

  // The same decisions on a host that says who each waits on.
  ...cardList("native decision awaits the person", "new", parked({ nativeDecisions: [native("nd", "a", { awaits: "person" })] }), codexCard("nd"), { delivered: 1, without: 1 }),
  ...cardList("native decision awaits the coordinator", "new", parked({ nativeDecisions: [native("nd", "a", { awaits: "coordinator" })] }), quietCard("nd"), { delivered: 0, without: 0 }),
  ...cardList("native decision awaits nobody", "new", parked({ attempts: [attempt("a", { agent: "claude" })], nativeDecisions: [native("nd", "a", { awaits: "nobody" })] }), quietCard("nd"), { delivered: 0, without: 0 }),
  ...cardList("outage card over two refusals, awaits the person", "new",
    parked({ nativeDecisions: [native("nd1", "a", { kind: "outage", groupId: "out", awaits: "person" }), native("nd2", "a", { kind: "outage", groupId: "out", awaits: "person" })] }),
    { safetyBlocks: { "orch-a": [{ id: "out", provider: "claude", kind: "outage" }] } }, { delivered: 1, without: 1 }),
  { name: "gate awaits the person", host: "new", person: 1, ledger: ledger({ tasks: [task("a", { status: "blocked" })], gates: [gate("g", { taskId: "a", awaits: "person" })] }) },
  { name: "gate awaits the coordinator", host: "new", person: 0, ledger: ledger({ tasks: [task("a", { status: "blocked" })], gates: [gate("g", { taskId: "a", awaits: "coordinator" })] }) },
  { name: "gate awaits nobody", host: "new", person: 0, ledger: ledger({ tasks: [task("a", { status: "blocked" })], gates: [gate("g", { taskId: "a", awaits: "nobody" })] }) },
  { name: "a plan, a gate and a refusal at once", host: "new", person: 3, ledger: parked({
    runs: [run({ planApproval: { status: "pending", revision: 3, requestedAt: 1 } })],
    gates: [gate("g", { taskId: "a", awaits: "person" })], nativeDecisions: [native("nd", "a", { awaits: "person" })],
  }) },
  { name: "two live runs, each asking", host: "new", person: 2, ledger: parked({
    runs: [run(), OLD_RUN.run], tasks: [task("a"), ...OLD_RUN.tasks], attempts: [attempt("a", { execution: { state: "waiting_tool", retryCount: 0 } }), ...OLD_RUN.attempts],
    gates: [gate("g", { runId: "run_old", taskId: "old", awaits: "person" })], nativeDecisions: [native("nd", "a", { awaits: "person" })],
  }) },

  // Corners the table above does not reach.
  { name: "a decision of the run itself, before it has a task", host: "new", person: 1, ledger: ledger({ tasks: [], attempts: [], gates: [gate("g", { awaits: "person" })] }) },
  { name: "a card still on the page for a worker of a stopped run", host: "old", person: 1, ledger: parked({ runs: [run({ status: "stopped" })] }), cards: { asks: { "orch-a": [{ id: "p1" }] } } },
  { name: "the person's gate on a task that has finished", host: "new", person: 1, ledger: ledger({ tasks: [task("a", { status: "completed" })], attempts: [attempt("a", { status: "completed", execution: { state: "completed", retryCount: 0 } })], gates: [gate("g", { taskId: "a", awaits: "person" })] }) },
  { name: "a refusal recorded on an attempt that was replaced", host: "new", person: 0, ledger: ledger({ tasks: [task("a", { activeAttemptId: "at_a2" })], attempts: [attempt("a", { status: "failed" }), attempt("a", { id: "at_a2", number: 2 })], nativeDecisions: [native("nd", "a", { awaits: "person" })] }) },
  { name: "an archived run with a gate left open", host: "new", person: 0, ledger: ledger({ runs: [run({ status: "completed", archivedAt: 9 })], tasks: [task("a", { status: "completed" })], gates: [gate("g", { taskId: "a", awaits: "person" })] }) },
  // The reviewer's extension (F2): the panel put this run behind Archived
  // and said 0 to decide while the strip and the badge said 1.
  { name: "an archived run whose worker still has a card on the page", host: "old", person: 1, ledger: ledger({ runs: [run({ status: "completed", archivedAt: 9 })], tasks: [task("a", { status: "completed" })], attempts: [attempt("a", { status: "completed", execution: { state: "completed", retryCount: 0 } })] }), cards: { asks: { "orch-a": [{ id: "p1" }] } } },

  // The ledger as the host really serialises it (`__fixtures__/host`): the
  // shapes above are written by hand, and these are not.
  { name: "the host's own ledger: a worker's gate and one the coordinator opened itself", host: "new", person: 1, ledger: real(hostFacts.gatesOpen()) },
  { name: "the host's own ledger: a gate on a peer request", host: "new", person: 1, ledger: real(hostFacts.peerGate()) },
  { name: "the host's own ledger: a Codex safety card, no card on the page yet", host: "new", person: 1, ledger: real(hostFacts.cardPending()) },
  { name: "the host's own ledger: that card with its attempt blocked on a gate", host: "new", person: 1, ledger: real(hostFacts.cardOnGateBlocked()) },
  { name: "the host's own ledger: a Claude auto-mode refusal", host: "new", person: 0, ledger: real(hostFacts.claudeRefusal()) },
  { name: "the host's own ledger: a pending plan beside an approved task", host: "new", person: 1, ledger: real(hostFacts.heldByPlan()) },
  { name: "the host's own ledger: a reopened task held for its notice", host: "new", person: 0, ledger: real(hostFacts.heldByReopen()) },
  { name: "the host's own ledger: a task the person stopped", host: "new", person: 0, ledger: real(hostFacts.taskStopped().snapshot) },
  { name: "the host's own ledger: two workers, one with usage and context", host: "new", person: 0, ledger: real(hostFacts.usageContext()) },
];

/* ---- The surfaces ------------------------------------------------------ */

const TEAM: TeamAgent[] = [
  { id: "fe", name: "OCTIQ FE", role: "", agent: "claude", model: "opus", access: "auto", createdAt: 1, updatedAt: 1 },
  { id: "head", name: "OCTIQ HEAD", role: "", agent: "claude", model: "opus", access: "auto", createdAt: 1, updatedAt: 1 },
];

const count = (text: string | undefined) => text ? Number(text) : 0;

type Read = { count: number | null; asked: boolean };

/** Every surface's answer for one ledger and one state of the card lists. */
function surfaces(orchestration: OrchestrationSnapshot, cards: Cards = {}): Record<string, Read> {
  const { actions, held } = pendingReading({ orchestration, parents: workerChatParents(orchestration), ...cards });
  const rows = pendingByRow(actions);
  const tasks = pendingByTask(actions);
  const view: PendingActionsView = { forRow: (id) => rows.get(id) ?? [], forTask: (id) => tasks.get(id) ?? [], held, reveal: () => {} };
  // The chat's own ledger, as the strip, the Tasks button and the sidebar
  // row read it.
  const scoped = chatSnapshot(orchestration, MAIN);

  // The strip, as drawn.
  const picked = chatStrip(scoped, NOW, held);
  const stripHtml = picked ? renderToStaticMarkup(<RunProgressStrip strip={picked.strip} onOpen={() => {}} onHide={() => {}} />) : "";
  const stripAsked = stripHtml.includes('data-state="needs"');
  const stripCount = !stripAsked ? 0
    : stripHtml.includes(">Plan to approve<") ? 1
      : count(/<b class="run-strip-reason">(\d+) decisions?<\/b>/.exec(stripHtml)?.[1]);

  // The panel, as drawn for the chat: one "N to decide" per run.
  const panelHtml = renderToStaticMarkup(
    <PendingActionsContext.Provider value={view}>
      <OrchestrationPanel embedded allowManualRun={false} project={{ id: "p1", name: "octiq-flow" }} coordinatorKey={MAIN}
        initialSnapshot={orchestration} onOpenChat={() => {}} onClose={() => {}} />
    </PendingActionsContext.Provider>);
  const toDecide = [...panelHtml.matchAll(/class="orch-attention" data-tone="decision" aria-label="(\d+) decisions? waiting/g)]
    .reduce((sum, match) => sum + Number(match[1]), 0);

  // The panel's rows, and the boxes above them for what is no row.
  let rowDecisions = 0;
  let boxes = 0;
  let headings = 0;
  for (const item of scoped.runs) {
    const waits = runWaits(scoped, item, held);
    const progress = runProgress(scoped, item, NOW, held);
    rowDecisions += progress.rows.reduce((sum, row) => sum + row.decisions, 0);
    boxes += waits.person.filter((wait) => !wait.taskId).length;
    const needs = progress.groups.find((group) => group.key === "needs");
    headings += needs ? count(/· (\d+) decisions?$/.exec(groupHeading(needs).label)?.[1]) : 0;
    // The same list, by the panel's own count.
    expect(runAttention(item, scoped.tasks, scoped.attempts, waits).decisions, "runAttention").toBe(waits.person.length);
  }

  // The Tasks button, as drawn while the column is shut.
  const counts = taskColumnCounts(scoped, held);
  const tasksHtml = renderToStaticMarkup(<TasksButton tasks={counts.tasks} decisions={counts.decisions} open={false} onToggle={() => {}} />);
  const tasksCount = count(/<span class="tasks-toggle-owed" aria-hidden="true">(\d+)<\/span>/.exec(tasksHtml)?.[1]);

  // The chat list, as drawn while the person is in ANOTHER chat.
  const chat = (id: string): Conversation => ({ id, projectId: "p1", title: `Chat ${id}`, messages: [], createdAt: 1, updatedAt: 1 });
  const sidebarHtml = renderToStaticMarkup(
    <PendingActionsContext.Provider value={view}>
      <Sidebar projects={[{ id: "p1", name: "octiq-flow" }]} shelved={[]} orchestration={orchestration}
        conversations={[chat("main"), chat("elsewhere")]} chatParents={workerChatParents(orchestration)}
        currentConversation="elsewhere" running={new Set()} busy={new Set()}
        onPickConversation={() => {}} onNewChat={() => {}} onDelete={() => {}} onPin={() => {}}
        onToggleDone={() => {}} onRename={() => {}} />
    </PendingActionsContext.Provider>);
  const at = sidebarHtml.indexOf(">Chat main<");
  const main = sidebarHtml.slice(sidebarHtml.lastIndexOf('<li data-row="', at), sidebarHtml.indexOf('<li data-row="', at) < 0 ? undefined : sidebarHtml.indexOf('<li data-row="', at));
  const badge = /class="pending-action-badge[^"]*" data-kind="([a-z]+)"/.exec(main)?.[1];
  const badgeCount = !badge ? 0 : badge === "several" ? count(/>Action needed · (\d+)</.exec(main)?.[1]) : 1;
  // The line is drawn from the same call the row makes.
  const line = scoped.runs.length ? chatRunStatus(scoped, rowRun(scoped, held)!, held) : "";
  expect(main.includes(`>${line}<`) || !line, "the sidebar draws the line it was given").toBe(true);

  // The Agents page's roster.
  const roster = agentRoster({
    team: TEAM, snapshot: orchestration, projects: [{ id: "p1", name: "octiq-flow" }],
    leads: [{ chatKey: MAIN, leadId: "head", leadName: "OCTIQ HEAD", projectId: "p1", createdAt: 1 }],
    providerLabel: () => "Claude opus", chatTitle: () => undefined, chatExists: () => true, leadActivity: () => "idle",
    // What App hands it: the cards of the chat itself.
    waitingOn: (chatKey) => actions.filter((action) => action.chatId === chatKey.replace(/^chat:/, "")).length,
    held,
  });

  return {
    strip: { count: stripCount, asked: stripAsked },
    stripValue: { count: picked?.strip.needs ?? 0, asked: picked?.strip.state === "needs" },
    rows: { count: rowDecisions + boxes, asked: rowDecisions + boxes > 0 },
    rowHeadings: { count: headings + boxes, asked: headings + boxes > 0 },
    toDecide: { count: toDecide, asked: toDecide > 0 },
    tasksButton: { count: tasksCount, asked: tasksHtml.includes("waiting for you") },
    sidebarLine: { count: null, asked: line.startsWith("Needs you") },
    sidebarBadge: { count: badgeCount, asked: main.includes("has-pending") },
    pendingActions: { count: actions.length, asked: actions.length > 0 },
    ledgerWaits: { count: ledgerWaits(orchestration, held).person.length, asked: ledgerWaits(orchestration, held).person.length > 0 },
    agentsPage: { count: null, asked: roster.some((row) => row.state === "needs_you" || !!row.counts.needs_you) },
  };
}

const SURFACES = ["strip", "stripValue", "rows", "rowHeadings", "toDecide", "tasksButton", "sidebarLine", "sidebarBadge", "pendingActions", "ledgerWaits", "agentsPage"];

describe("every surface says the same of who is waited on", () => {
  it("covers both hosts and every state of the card list", () => {
    expect(SHAPES.filter((shape) => shape.host === "old").length).toBeGreaterThan(10);
    expect(SHAPES.filter((shape) => shape.host === "new").length).toBeGreaterThan(10);
    for (const state of ["delivered", "not arrived", "failed"]) {
      expect(SHAPES.filter((shape) => shape.name.endsWith(`card list ${state}`)).length, state).toBeGreaterThanOrEqual(5);
    }
    expect(new Set(SHAPES.map((shape) => shape.name)).size).toBe(SHAPES.length);
  });

  it.each(SHAPES)("$host host: $name → $person", ({ ledger: shape, cards, person }) => {
    const read = surfaces(shape, cards);
    expect(Object.keys(read)).toEqual(SURFACES);
    for (const [name, answer] of Object.entries(read)) {
      if (answer.count !== null) expect(answer.count, `${name} count`).toBe(person);
      expect(answer.asked, `${name} says the person is waited on`).toBe(person > 0);
    }
  });

  // The reviewer's pair: the host says a refusal waits on the person, and the
  // page's card for it has not arrived, or its request failed. Away from
  // that chat the row must still say so, and lead to where the card will be.
  it("badges the main chat for a decision the host says is the person's while the page has no card for it", () => {
    const shape = parked({ nativeDecisions: [native("nd", "a", { awaits: "person" })] });
    const without = pendingReading({ orchestration: shape, parents: workerChatParents(shape) });
    expect(without.actions).toEqual([{
      key: "safety:nd", kind: "safety", rowId: "main", openChatId: "main", surface: "chat", runId: "run_1", taskId: "a", cardMissing: true,
    }]);
    // Its card arrives: the same key, once, and no longer missing.
    const delivered = pendingReading({ orchestration: shape, parents: workerChatParents(shape), ...codexCard("nd") });
    expect(delivered.actions.map((action) => [action.key, action.cardMissing ?? false])).toEqual([["safety:nd", false]]);
    // An outage is its own kind of card, under the group's id.
    const outage = parked({ nativeDecisions: [native("nd", "a", { kind: "outage", groupId: "out", awaits: "person" })] });
    expect(pendingReading({ orchestration: outage, parents: workerChatParents(outage) }).actions)
      .toMatchObject([{ key: "safety:out", kind: "outage", cardMissing: true }]);
  });

  // F2: an archived run that still holds a card. Its decision is in the
  // panel's own list, with the way to it beside Restore, never replaced by it.
  it("keeps an archived run's decision reachable in the panel", () => {
    const shape = SHAPES.find((item) => item.name === "an archived run whose worker still has a card on the page")!;
    const { actions, held } = pendingReading({ orchestration: shape.ledger, parents: workerChatParents(shape.ledger), ...shape.cards });
    const tasks = pendingByTask(actions);
    const view: PendingActionsView = { forRow: () => [], forTask: (id) => tasks.get(id) ?? [], held, reveal: () => {} };
    const draw = (value: PendingActionsView) => renderToStaticMarkup(
      <PendingActionsContext.Provider value={value}>
        <OrchestrationPanel embedded allowManualRun={false} project={{ id: "p1", name: "octiq-flow" }} coordinatorKey={MAIN}
          initialSnapshot={shape.ledger} onOpenChat={() => {}} onClose={() => {}} />
      </PendingActionsContext.Provider>);
    const html = draw(view);
    // Listed with the missions on screen, not behind Archived.
    expect(html).toContain('aria-label="Missions"');
    expect(html).not.toContain(">Archived</span>");
    const head = html.slice(html.indexOf('class="orch-run-accordion-head"'), html.indexOf('class="orch-run-accordion-body"'));
    expect(head).toContain('class="orch-attention" data-tone="decision" aria-label="1 decision waiting. Show"');
    expect(head).toContain('class="orch-run-restore"');
    expect(head.indexOf("orch-attention")).toBeLessThan(head.indexOf("orch-run-restore"));
    // Once the card is answered the run goes back behind Archived.
    const answered = draw({ ...view, forTask: () => [], held: new Map() });
    expect(answered).toContain(">Archived</span>");
    expect(answered).not.toContain("orch-attention");
  });

  it("gives the whole ledger and one chat's own scope the same answer", () => {
    for (const { name, ledger: shape, cards, person } of SHAPES) {
      const { held } = pendingReading({ orchestration: shape, parents: workerChatParents(shape), ...cards });
      expect(ledgerWaits(chatSnapshot(shape, MAIN), held).person.length, name).toBe(person);
      expect(ledgerWaits(shape, held).person.length, name).toBe(person);
    }
  });
});

/* ---- Nobody else reads the ledger's waits ------------------------------ */

const SOURCES = import.meta.glob<string>("../**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true });

/** The code of a file, without its comments: a comment may name a gate. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

/** How often each file may name the ledger's gates, its native decisions, or
 *  a record's `awaits`, outside `lib/runWaits.ts`. Each is here for a reason
 *  that is not a reading of who is waited on, and the count is exact: one
 *  more use in any of them fails this test, and so does a use anywhere else. */
const ALLOWED: Record<string, { uses: number; why: string }> = {
  "./runWaits.ts": { uses: -1, why: "the one reader" },
  "./orchestration.ts": { uses: 6, why: "the ledger's type (gates, nativeDecisions, awaits on a gate, on a decision and on a task's failure) and the empty ledger" },
  "./chatWorkflow.ts": { uses: 5, why: "chatSnapshot copies both lists into a chat's own ledger, unread, so runWaits sees the same facts in it" },
};

describe("the ledger's waits have one reader", () => {
  // A source scan is the only practical proof here: nothing at run time can
  // tell that a second function read a list, only that the text does.
  const READS = /\bgates\b|\bnativeDecisions\b|\.awaits\b|\bawaits\??:/g;

  it("names gates, native decisions and awaits nowhere outside lib/runWaits", () => {
    const found: Record<string, number> = {};
    for (const [path, text] of Object.entries(SOURCES)) {
      if (/\.test\.tsx?$/.test(path) || path.includes("/__fixtures__/")) continue;
      const uses = code(text).match(READS)?.length ?? 0;
      if (uses) found[path] = uses;
    }
    expect(Object.keys(SOURCES).length).toBeGreaterThan(300);
    expect(found["./runWaits.ts"]).toBeGreaterThan(0);
    const expected = Object.fromEntries(Object.entries(ALLOWED).map(([path, rule]) => [path, rule.uses < 0 ? found[path] : rule.uses]));
    expect(found).toEqual(expected);
  });

  it("catches a reader written the usual ways", () => {
    for (const line of [
      "const open = snapshot.gates.filter((gate) => gate.status === 'open');",
      "for (const decision of orchestration.nativeDecisions ?? []) {}",
      "function count({ gates }: Props) {}",
      "if (gate.awaits === 'person') return true;",
      "type Mine = { awaits?: string };",
    ]) expect(code(line).match(READS), line).not.toBeNull();
    // A comment, and a word that only contains one, are not readers.
    expect(code("// the gates of a run\nconst gated = openGates(snapshot, id); /* nativeDecisions */").match(READS)).toBeNull();
  });
});
