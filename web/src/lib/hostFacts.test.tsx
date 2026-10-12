// The page against the real host.
//
// The run panel was built against five optional facts before the host sent
// any of them: `awaits` on a gate and on a native decision, an attempt's
// `usage` and `context`, `coordinatesRun` on a chat's entry, and `heldByPlan`
// on a task. Every ledger here is what the host's own tests answered
// (`__fixtures__/host`), read by the page's own functions and drawn by its
// own components. Where a test needs another moment of the same ledger it
// changes a copy and says what it changed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("./bridge", () => ({
  bridge: { invoke: async () => null, on: () => () => {}, onState: () => () => {} },
}));

import { agentRoster } from "./agentsDashboard";
import type { TeamAgent } from "./agentsMode";
import { indexBackfill, type IndexEntry } from "./chatIndex";
import { chatSnapshot } from "./chatWorkflow";
import { hostFacts } from "./__fixtures__/hostFacts";
import { missionState } from "./mission";
import { taskHeldByPlan, workerChatParents, type OrchestrationSnapshot } from "./orchestration";
import { pendingLabel, pendingReading } from "./pendingActions";
import { awaitingApproval } from "./planReview";
import { holdsRunColumn } from "./runColumn";
import { chatStrip, COORDINATOR_WORD, figuresLabel, runProgress, usageTotal } from "./runProgress";
import { decisionSummary, runWaits } from "./runWaits";
import { sameIndex, type Conversation } from "./store";
import { PLAN_LABEL, planHoldsEveryStart } from "./taskHold";
import { OrchestrationPanel, PLAN_HOLDS_ALL, PLAN_HOLDS_SOME } from "../components/OrchestrationPanel";
import { PLAN_GOES_ON } from "../components/PlanReview";

afterEach(() => vi.useRealTimers());

/** Two minutes after the run last moved, so a time is on every row. */
const nowOf = (snapshot: OrchestrationSnapshot) => snapshot.runs[0].updatedAt + 120_000;

const panel = (snapshot: OrchestrationSnapshot) => {
  vi.useFakeTimers();
  vi.setSystemTime(nowOf(snapshot));
  const run = snapshot.runs[0];
  return renderToStaticMarkup(<OrchestrationPanel embedded allowManualRun={false} project={{ id: run.workspaceId, name: "Project" }}
    coordinatorKey={run.coordinatorChatKey} initialSnapshot={snapshot} onOpenChat={() => {}} onClose={() => {}} />);
};
const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const read = (snapshot: OrchestrationSnapshot) => {
  const run = snapshot.runs[0];
  const reading = pendingReading({ orchestration: snapshot, parents: workerChatParents(snapshot) });
  return {
    run,
    waits: runWaits(snapshot, run, reading.held),
    rows: runProgress(snapshot, run, nowOf(snapshot), reading.held).rows,
    strip: chatStrip(chatSnapshot(snapshot, run.coordinatorChatKey), nowOf(snapshot), reading.held)!.strip,
    actions: reading.actions,
  };
};

describe("awaits on an open gate", () => {
  const gates = hostFacts.gatesOpen();
  const [asked, wide] = gates.gates;

  it("is sent as the host documents it: a worker's gate is the coordinator's, the coordinator's own is the person's", () => {
    expect(asked).toMatchObject({ status: "open", awaits: "coordinator", taskId: gates.tasks[0].id });
    expect(wide).toMatchObject({ status: "open", awaits: "person", createdByChatKey: gates.runs[0].coordinatorChatKey });
    // A gate of the run itself names no task: the key is left out.
    expect("taskId" in wide).toBe(false);
    // A gate that has settled says nothing of who it waits on.
    const [cancelled] = hostFacts.taskStopped().snapshot.gates;
    expect(cancelled.status).toBe("cancelled");
    expect("awaits" in cancelled).toBe(false);
    expect(typeof cancelled.closedAt).toBe("number");
  });

  it("counts the coordinator's own gate as the person's, once, and gives them a way to answer it", () => {
    const { waits, strip, actions, rows } = read(gates);
    expect(waits.person).toEqual([{ key: `gate:${wide.id}`, kind: "gate", on: "person", runId: gates.runs[0].id }]);
    expect(waits.coordinator.map((wait) => wait.key)).toEqual([`gate:${asked.id}`]);
    expect(strip).toMatchObject({ state: "needs", needs: 1 });
    expect(strip.side).toEqual([{ text: "1 decision", strong: true }]);
    expect(strip.notes).toEqual(["1 waiting on the coordinator."]);
    // The badge on the coordinator's row, which leads to the run's box.
    expect(actions).toEqual([{ key: `gate:${wide.id}`, kind: "gate", rowId: "master", openChatId: "master", surface: "run", runId: gates.runs[0].id }]);
    expect(pendingLabel(actions)).toBe("Decision needed");
    // The worker's own gate parks its row on the coordinator, as a warning.
    expect(rows).toEqual([expect.objectContaining({ state: "running", why: COORDINATOR_WORD, tone: "warn", decisions: 0 })]);

    const html = panel(gates);
    const box = html.slice(html.indexOf(">Needs you</h3>"), html.indexOf(">Open decisions</h3>"));
    // It is the run's question, it is whole, and the answer has somewhere to
    // go: the main chat, whose agent records it (the host takes the
    // resolution of this gate from the coordinator).
    expect(words(box)).toContain("This mission Ship today?");
    expect(box).toContain('<input placeholder="Write a decision" aria-label="Decision for Ship today?" value=""/>');
    expect(box).toContain(">Send to main chat</button>");
    expect(html).toContain('aria-label="1 decision waiting. Show"');
    const others = html.slice(html.indexOf(">Open decisions</h3>"), html.indexOf('class="orch-tabs-row"'));
    expect(words(others)).toContain("Implement Waiting on the coordinator Which sprite size?");
    expect(html).toContain('data-state="running" data-tone="warn"');
  });

  it("takes a peer request's gate from the person, and answers it on the page", () => {
    const peer = hostFacts.peerGate();
    expect(peer.gates).toEqual([expect.objectContaining({ awaits: "person", taskId: peer.tasks[1].id })]);
    expect(peer.tasks[1].peerRequest).toMatchObject({ requestedBy: { name: "ADA" }, maxMinutes: 30 });
    const { waits, rows, strip } = read(peer);
    expect(waits.person).toHaveLength(1);
    expect(rows.map((row) => [row.task.title, row.state, row.why])).toEqual([
      ["Implement", "running", null], ["Report volume usage", "needs", "Asks a decision"],
    ]);
    expect(strip).toMatchObject({ state: "needs", needs: 1 });
    const html = panel(peer);
    const box = html.slice(html.indexOf(">Needs you</h3>"), html.indexOf('class="orch-tabs-row"'));
    expect(words(box)).toContain("Report volume usage Which volume?");
    expect(box).toContain(">Answer</button>");
    expect(box).not.toContain("Send to main chat");
  });
});

describe("awaits on a pending native decision", () => {
  it("is the person's for a Codex safety card on a running attempt", () => {
    const card = hostFacts.cardPending();
    const [decision] = card.nativeDecisions!;
    expect(decision).toMatchObject({ status: "pending", awaits: "person", continuation: "new_turn_same_attempt", kind: "safety", blockedAction: null, groupId: null });
    const { waits, rows, strip, actions } = read(card);
    expect(waits.person).toEqual([expect.objectContaining({ key: `safety:${decision.id}`, kind: "native", on: "person", card: "safety" })]);
    expect(rows).toEqual([expect.objectContaining({ state: "needs", why: "Awaiting review", tone: "decide", decisions: 1 })]);
    expect(strip).toMatchObject({ state: "needs", needs: 1 });
    // The host's word does not wait for the page's card: badged without it.
    expect(actions).toEqual([expect.objectContaining({ key: `safety:${decision.id}`, kind: "safety", surface: "chat", cardMissing: true })]);
    expect(pendingLabel(actions)).toBe("Review needed");
    expect(decisionSummary(decision)).toEqual({ label: "Native decision", lines: [
      `Native decision ${decision.id}`, "Requires a decision.", "The provider gave no exact action.", decision.recovery,
    ] });
  });

  it("stays the person's while its attempt is blocked on a gate, and says why nothing continues in the host's words", () => {
    const blocked = hostFacts.cardOnGateBlocked();
    const [decision] = blocked.nativeDecisions!;
    expect(decision).toMatchObject({ status: "pending", awaits: "person", continuation: "unavailable" });
    expect(decision.recovery).toContain("blocked on another open decision (a gate on its task)");
    expect(blocked.attempts[0]).toMatchObject({ status: "blocked", execution: { state: "blocked" } });
    expect(blocked.gates).toEqual([expect.objectContaining({ awaits: "coordinator", taskId: decision.taskId })]);

    const { waits, rows, strip } = read(blocked);
    // One decision of the person's, not two: the gate is the coordinator's.
    expect(waits.person).toHaveLength(1);
    expect(waits.coordinator).toHaveLength(1);
    expect(rows).toEqual([expect.objectContaining({ state: "needs", why: "Awaiting review", decisions: 1 })]);
    expect(strip).toMatchObject({ state: "needs", needs: 1 });
    expect(strip.notes).toEqual(["1 waiting on the coordinator."]);

    // "Cannot resume" was the page's own reading of `unavailable`, and was
    // false here: the card is still theirs, and answering the gate too lets
    // the same attempt go on.
    const summary = decisionSummary(decision);
    expect(summary.label).toBe("Native decision");
    expect(summary.lines.at(-1)).toBe(decision.recovery);
    const html = panel(blocked);
    expect(html).not.toContain("cannot resume");
    expect(html).not.toContain("a new attempt is needed");
    expect(html).toMatch(/<span class="orch-task-decision" title="[^"]*so nothing can continue it yet\.[^"]*">Native decision [0-9a-f-]{10}<\/span>/);
    expect(html).toContain('aria-label="1 decision waiting. Show"');
    expect(words(html)).toContain("Open decisions Implement Waiting on the coordinator Other question");
  });

  it("is nobody's for a Claude auto-mode refusal, which is recorded and asks nothing", () => {
    const refused = hostFacts.claudeRefusal();
    const [decision] = refused.nativeDecisions!;
    expect(decision).toMatchObject({ status: "pending", awaits: "nobody", continuation: "unavailable", blockedAction: "eas update --branch production --message 'OTA 1.4.2'" });
    const { waits, rows, strip, actions } = read(refused);
    expect(waits.person).toEqual([]);
    expect(waits.nobody).toHaveLength(1);
    expect(rows).toEqual([expect.objectContaining({ state: "running", why: null, tone: null, decisions: 0 })]);
    expect(strip).toMatchObject({ state: "running", needs: 0 });
    expect(actions).toEqual([]);
    // The worker carries on past it: never "a new attempt is needed".
    expect(decisionSummary(decision).label).toBe("Refusal recorded");
    expect(decisionSummary(decision).lines.at(-1)).toContain("Continue another safe way");
    const html = panel(refused);
    expect(html).not.toContain("Needs you");
    expect(html).not.toContain("a new attempt is needed");
    expect(html).toMatch(/>Refusal recorded [0-9a-f-]{10}<\/span>/);
  });
});

describe("an attempt's usage and context", () => {
  const counted = hostFacts.usageContext();
  const [used, silent] = counted.attempts;

  it("is sent only where the host counted something: no zeros, and no context without a window", () => {
    expect(used.usage).toEqual({ input: 41_000, cachedInput: 39_500, cacheWrite: 0, output: 2_300, reasoning: 1_100 });
    expect(used.context).toEqual({ tokens: 41_000, window: 272_000 });
    // The other worker's chat reported a token count and no window, and no
    // usage at all: neither key is there, rather than a zero or half a pair.
    expect("usage" in silent).toBe(false);
    expect("context" in silent).toBe(false);
    // And no other ledger of these has either key on any attempt.
    for (const other of [hostFacts.gatesOpen(), hostFacts.cardPending(), hostFacts.heldByPlan()]) {
      expect(other.attempts.some((attempt) => "usage" in attempt || "context" in attempt)).toBe(false);
    }
  });

  it("draws a row's figures from them, and leaves the part out where there is none", () => {
    // The total is input plus output: the cached and reasoning parts are
    // inside those two, as `TokenUsage::total` adds them.
    expect(usageTotal(used.usage)).toBe(43_300);
    const { rows } = read(counted);
    expect(rows.map((row) => [row.tokens, row.context, figuresLabel(row)])).toEqual([
      [43_300, 15, "ctx 15% · 43k · 2m"],
      [null, null, "2m"],
    ]);
    const html = panel(counted);
    expect(html).toContain('<span class="run-row-figures">ctx 15% · 43k · 2m</span>');
    expect(html).toContain('<span class="run-row-figures">2m</span>');
    expect(html).not.toMatch(/ctx 0%|\b0k\b/);
  });

  it("totals the run's tokens from the attempts that have any, and draws no tile when none has", () => {
    expect(runProgress(counted, counted.runs[0], nowOf(counted)).tiles.tokens).toBe(43_300);
    expect(panel(counted)).toMatch(/<dt>Tokens<\/dt><dd>43k<\/dd>/);
    const none = hostFacts.gatesOpen();
    expect(runProgress(none, none.runs[0], nowOf(none)).tiles.tokens).toBeNull();
    expect(panel(none)).not.toContain("<dt>Tokens</dt>");
  });
});

describe("coordinatesRun on a chat's entry", () => {
  const { lead, plain } = hostFacts.coordinatesRun();

  it("is true on a chat that coordinates a run, and absent on one that does not", () => {
    expect(lead.coordinatesRun).toBe(true);
    expect("coordinatesRun" in plain).toBe(false);
  });

  it("holds the run column's place before the ledger is read, for that chat only", () => {
    const holds = (entry: typeof lead) => holdsRunColumn({
      ledgerRead: false, ledgerFailed: false, chatId: entry.id, besideTask: null, known: new Set(), coordinates: entry.coordinatesRun === true,
    });
    expect(holds(lead)).toBe(true);
    expect(holds(plain)).toBe(false);
    // Once the ledger is read it is the ledger's to say.
    expect(holdsRunColumn({ ledgerRead: true, ledgerFailed: false, chatId: lead.id, besideTask: null, known: new Set(), coordinates: true })).toBe(false);
  });

  it("changes the list when it changes, and is never saved back", () => {
    const chat = (entry: typeof lead): Conversation => ({ ...entry, messages: [] });
    expect(sameIndex([chat(lead)], [chat({ ...lead, coordinatesRun: undefined })])).toBe(false);
    expect(sameIndex([chat(plain)], [chat(plain)])).toBe(true);
    // A chat this browser offers to the server's index goes without it.
    const offered = indexBackfill([chat(lead)], [plain as unknown as IndexEntry], new Set());
    expect(offered).toHaveLength(1);
    expect("coordinatesRun" in offered[0]).toBe(false);
  });
});

describe("heldByPlan on a task", () => {
  const plan = hostFacts.heldByPlan();
  const [approved, added] = plan.tasks;
  const run = plan.runs[0];

  it("is true or false on every task of a run with a plan, and absent on a run with none", () => {
    expect(run.planApproval).toMatchObject({ status: "pending" });
    expect(approved).toMatchObject({ title: "Inspect only", status: "ready", heldByPlan: false });
    expect(typeof approved.approvedAt).toBe("number");
    expect(added).toMatchObject({ title: "Implement", status: "ready", heldByPlan: true });
    expect("approvedAt" in added).toBe(false);
    // A decided plan says it too, of every task.
    expect(hostFacts.taskStopped().snapshot.tasks.map((task) => task.heldByPlan)).toEqual([false, false]);
    // No plan on the run: nothing to be held by, and no key.
    const bare = hostFacts.usageContext();
    expect(bare.runs[0].planApproval).toBeUndefined();
    expect(bare.tasks.some((task) => "heldByPlan" in task)).toBe(false);
    expect(bare.tasks.map((task) => taskHeldByPlan(task, bare.runs[0], bare.tasks))).toEqual([false, false]);
  });

  it("holds only the task the person has not approved, and the panel draws both as what they are", () => {
    expect(taskHeldByPlan(approved, run, plan.tasks)).toBe(false);
    expect(taskHeldByPlan(added, run, plan.tasks)).toBe(true);
    expect(awaitingApproval(plan.tasks)).toEqual([added.id]);
    expect(planHoldsEveryStart(run, plan.tasks)).toBe(false);
    const { rows, strip, waits } = read(plan);
    expect(waits.person.map((wait) => wait.kind)).toEqual(["plan"]);
    expect(strip).toMatchObject({ state: "needs", planOnly: true });
    expect(rows.map((row) => [row.task.title, row.state, row.why, row.hold?.kind ?? null])).toEqual([
      ["Inspect only", "planned", null, null],
      ["Implement", "planned", PLAN_LABEL, "plan"],
    ]);

    // The plan is not the whole run any more: the approved task's row is on
    // the page, and neither sentence says nothing starts.
    const html = panel(plan);
    expect(html).toContain("Approve plan");
    expect(html).toContain(`<p class="orch-task-none">${PLAN_HOLDS_SOME}</p>`);
    expect(html).not.toContain(PLAN_HOLDS_ALL);
    expect(html).toContain(`<span class="plan-review-hint">${PLAN_GOES_ON}</span>`);
    expect(html).not.toContain("No worker starts until you approve.");
    expect(html.match(/<article class="orch-task /g)).toHaveLength(2);
    expect(html).toContain(`>${PLAN_LABEL}</span>`);
    expect(html).toContain('<dl class="run-tiles"');
    expect(missionState(run, plan.tasks).stage).toBe("approved");
  });

  it("is the whole run while it holds every task, and says so as before", () => {
    // Changed for this test: nothing approved yet, as before the first approval.
    const first = hostFacts.heldByPlan();
    first.tasks[0] = { ...first.tasks[0], approvedAt: undefined, heldByPlan: true };
    expect(planHoldsEveryStart(first.runs[0], first.tasks)).toBe(true);
    const html = panel(first);
    expect(html).toContain(`<p class="orch-task-none">${PLAN_HOLDS_ALL}</p>`);
    expect(html).toContain("No worker starts until you approve.");
    expect(html).not.toContain('<article class="orch-task ');
    expect(html).not.toContain('<dl class="run-tiles"');
    expect(missionState(first.runs[0], first.tasks).stage).toBe("draft");
  });

  it("reads a withdrawn amendment as nothing held: the approved task is ready, with the plan still pending", () => {
    // Changed for this test, as the host's own test goes on to do: B is
    // withdrawn. The plan stays with the person and holds nothing.
    const withdrawn = hostFacts.heldByPlan();
    withdrawn.tasks[1] = { ...withdrawn.tasks[1], status: "cancelled", heldByPlan: false };
    expect(planHoldsEveryStart(withdrawn.runs[0], withdrawn.tasks)).toBe(false);
    expect(missionState(withdrawn.runs[0], withdrawn.tasks)).toMatchObject({ stage: "approved", blocked: false });
    const TEAM: TeamAgent[] = [{ id: "agent_dev", name: "Dev", role: "", agent: "codex", model: "gpt-5.6-terra", access: "manual", createdAt: 1, updatedAt: 1 }];
    const [dev] = agentRoster({
      team: TEAM, leads: [], snapshot: withdrawn, projects: [], providerLabel: () => "Codex", chatTitle: () => undefined,
      chatExists: () => true, leadActivity: () => "idle", waitingOn: () => 0,
    });
    expect(dev.activities).toEqual([expect.objectContaining({ state: "queued", label: "Ready to start" })]);
  });

  it("is said on the Agents page per task, from the same key", () => {
    const TEAM: TeamAgent[] = [{ id: "agent_dev", name: "Dev", role: "", agent: "codex", model: "gpt-5.6-terra", access: "manual", createdAt: 1, updatedAt: 1 }];
    // Changed for this test: the host's second task was handed to nobody.
    const both = hostFacts.heldByPlan();
    both.tasks[1].assignee = both.tasks[0].assignee;
    const [dev] = agentRoster({
      team: TEAM, leads: [], snapshot: both, projects: [], providerLabel: () => "Codex", chatTitle: () => undefined,
      chatExists: () => true, leadActivity: () => "idle", waitingOn: () => 0,
    });
    expect(dev.activities.map((activity) => [activity.title, activity.label]).sort()).toEqual([
      ["Implement", PLAN_LABEL], ["Inspect only", "Ready to start"],
    ]);
  });
});
