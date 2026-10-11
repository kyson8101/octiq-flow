import { describe, expect, it } from "vitest";
import {
  chatStrip, contextPercent, dismissStrip, figuresLabel, GROUP_FOLDED, GROUP_ORDER, minutesLabel, parseDismissed, runProgress, shownRows,
  stepsLabel, stripHidden, stripRun, tasksLabel, tokensLabel, usageTotal, type ProgressRow, type Waiting,
} from "./runProgress";
import { chatSnapshot } from "./chatWorkflow";
import { UNSAID_NOTE } from "./runWaits";
import type {
  Awaits, NativeDecision, OrchestrationAttempt, OrchestrationGate, OrchestrationRun, OrchestrationSnapshot, OrchestrationTask,
} from "./orchestration";
import type { TaskReport } from "./chatTask";

const MINUTE = 60_000;
const START = 1_000_000_000;
const NOW = START + 126 * MINUTE;

const run = (over: Partial<OrchestrationRun> = {}): OrchestrationRun => ({
  id: "run_1", objective: "Ship it", coordinatorChatKey: "chat:main", workspaceId: "w", rootPath: "/repo",
  status: "running", maxConcurrent: 4, createdAt: START, updatedAt: START, ...over,
});

let made = 0;
function task(title: string, status: OrchestrationTask["status"], over: Partial<OrchestrationTask> = {}): OrchestrationTask {
  made += 1;
  const id = over.id ?? `task_${made}`;
  return { id, runId: "run_1", title, spec: "The worker's brief", dependsOn: [], status, createdAt: START, updatedAt: START, ...over };
}

function attempt(of: OrchestrationTask, status: OrchestrationAttempt["status"], over: Partial<OrchestrationAttempt> = {}): OrchestrationAttempt {
  return {
    id: `attempt_${of.id}`, runId: "run_1", taskId: of.id, number: 1, workerChatKey: `chat:orch-${of.id}`, agent: "claude",
    model: "opus", effort: "high", access: "auto", status, cwd: "/Users/me/repo", branch: "feature/x", isWorktree: true,
    filesModified: [], createdAt: START, updatedAt: START + 10 * MINUTE, ...over,
  };
}

/** A task with the attempt it is on, wired together. */
function going(title: string, status: OrchestrationTask["status"], attemptStatus: OrchestrationAttempt["status"], over: {
  task?: Partial<OrchestrationTask>; attempt?: Partial<OrchestrationAttempt>;
} = {}) {
  const made = task(title, status, over.task);
  const tried = attempt(made, attemptStatus, over.attempt);
  return { task: { ...made, activeAttemptId: tried.id }, attempt: tried };
}

const report = (done: number, total: number, at = START + MINUTE): TaskReport => ({
  objective: "x", reportedAt: at, reportedBy: "claude",
  steps: Array.from({ length: total }, (_, index) => ({
    // A worker's own words: they must never reach a row.
    title: `Reading /Users/me/secret/path and commit ${"a".repeat(40)}`,
    state: index < done ? "done" : index === done ? "active" : "pending",
  })),
} as TaskReport);

function ledger(parts: { task: OrchestrationTask; attempt?: OrchestrationAttempt }[], over: Partial<OrchestrationSnapshot> = {}, theRun = run()): { snapshot: OrchestrationSnapshot; run: OrchestrationRun } {
  return {
    run: theRun,
    snapshot: {
      runs: [theRun], tasks: parts.map((part) => part.task),
      attempts: parts.flatMap((part) => part.attempt ? [part.attempt] : []),
      gates: [], messages: [], ...over,
    },
  };
}

/** An open gate the host says is the person's, unless told otherwise.
 *  `null` is a host that does not say who a gate waits on. */
const gate = (taskId: string | undefined, status: OrchestrationGate["status"] = "open", awaits: Awaits | null = "person"): OrchestrationGate => ({
  id: `gate_${taskId ?? "run"}`, runId: "run_1", taskId, createdByChatKey: "chat:w", targetChatKey: "chat:main",
  question: "Which way?", options: [], status, createdAt: START, updatedAt: START, ...(awaits ? { awaits } : {}),
});

const native = (part: { task: OrchestrationTask; attempt: OrchestrationAttempt }, over: Partial<NativeDecision> = {}): NativeDecision => ({
  id: `nd_${part.task.id}`, runId: part.task.runId, taskId: part.task.id, attemptId: part.attempt.id, chatKey: part.attempt.workerChatKey,
  reason: "Refused by the provider's review", blockedAction: "rm -rf build", status: "pending", continuation: "unavailable",
  recovery: "", observedAt: START, ...over,
});

/** The cards the page holds for one task, as `pendingByTask` hands them over. */
const cards = (taskId: string, ...held: [kind: string, id: string][]): Waiting =>
  new Map([[taskId, held.map(([kind, id]) => ({ kind, key: `${kind === "outage" ? "safety" : kind}:${id}` }))]]);

describe("elapsed time", () => {
  it("is minutes, then hours and minutes", () => {
    expect(minutesLabel(9 * MINUTE)).toBe("9m");
    expect(minutesLabel(38 * MINUTE + 59_000)).toBe("38m");
    expect(minutesLabel(60 * MINUTE)).toBe("1h 00m");
    expect(minutesLabel(126 * MINUTE)).toBe("2h 06m");
    expect(minutesLabel(161 * MINUTE)).toBe("2h 41m");
    expect(minutesLabel(26 * 60 * MINUTE + 5 * MINUTE)).toBe("26h 05m");
  });

  it("never says seconds, whatever it is given", () => {
    expect(minutesLabel(0)).toBe("<1m");
    expect(minutesLabel(59_999)).toBe("<1m");
    expect(minutesLabel(-5_000)).toBe("<1m");
    for (let ms = 0; ms < 3 * 60 * MINUTE; ms += 7_919) expect(minutesLabel(ms)).not.toMatch(/\ds\b|sec/);
  });

  it("changes once a minute at most", () => {
    const labels = new Set<string>();
    for (let ms = 12 * MINUTE; ms < 13 * MINUTE; ms += 1_000) labels.add(minutesLabel(ms));
    expect([...labels]).toEqual(["12m"]);
  });
});

describe("tokens and context", () => {
  it("reads a total at a glance", () => {
    expect(tokensLabel(310_000)).toBe("310k");
    expect(tokensLabel(520_499)).toBe("520k");
    expect(tokensLabel(1_100_000)).toBe("1.1M");
    expect(tokensLabel(9_400_000)).toBe("9.4M");
    expect(tokensLabel(12_600_000)).toBe("13M");
    expect(tokensLabel(840)).toBe("840");
  });

  it("adds what was read and what was written, and nothing else", () => {
    // Cached and reasoning tokens are already inside the two totals.
    expect(usageTotal({ input: 500_000, cachedInput: 480_000, cacheWrite: 10_000, output: 20_000, reasoning: 5_000 })).toBe(520_000);
    expect(usageTotal(undefined)).toBeNull();
    expect(usageTotal(null)).toBeNull();
    expect(usageTotal({ input: 0, output: 0 })).toBeNull();
  });

  it("gives a context share only from both numbers", () => {
    expect(contextPercent({ tokens: 82_000, window: 200_000 })).toBe(41);
    expect(contextPercent({ tokens: 250_000, window: 200_000 })).toBe(100);
    expect(contextPercent({ tokens: 82_000, window: 0 })).toBeNull();
    expect(contextPercent({ tokens: 0, window: 200_000 })).toBeNull();
    expect(contextPercent(undefined)).toBeNull();
  });

  it("writes the figures as the mock does, and leaves out what it was not given", () => {
    const row = (context: number | null, tokens: number | null, elapsedMs: number | null) => ({ context, tokens, elapsedMs });
    expect(figuresLabel(row(41, 520_000, 38 * MINUTE))).toBe("ctx 41% · 520k · 38m");
    expect(figuresLabel(row(null, 1_900_000, 72 * MINUTE))).toBe("1.9M · 1h 12m");
    expect(figuresLabel(row(null, null, 38 * MINUTE))).toBe("38m");
    expect(figuresLabel(row(null, null, null))).toBeNull();
    // A zero is not a figure.
    expect(figuresLabel(row(0, 0, 0))).toBeNull();
  });

  it("counts steps and tasks in the mock's words", () => {
    expect(stepsLabel({ done: 3, total: 9 })).toBe("3/9 steps");
    expect(stepsLabel({ done: 0, total: 1 })).toBe("0/1 step");
    expect(tasksLabel({ done: 13, total: 22 })).toBe("13 / 22");
  });
});

describe("the groups", () => {
  const asking = going("D · Re-review", "blocked", "blocked");
  const working = going("C · Server", "running", "running", { attempt: { execution: { state: "executing", retryCount: 0 } } });
  const finished = going("E · Cards", "completed", "completed", { attempt: { finishedAt: START + 40 * MINUTE } });
  const queued = task("H · Compact cards", "pending", { dependsOn: [working.task.id, finished.task.id] });
  const all = ledger([{ task: queued }, finished, working, asking], { gates: [gate(asking.task.id)] });

  it("come in the order Needs you, Running, Finished, Planned, whatever the ledger's order", () => {
    const { groups } = runProgress(all.snapshot, all.run, NOW);
    expect(groups.map((group) => group.label)).toEqual(["Needs you", "Running", "Finished", "Planned"]);
    expect(groups.map((group) => group.rows.map((row) => row.task.title))).toEqual([
      ["D · Re-review"], ["C · Server"], ["E · Cards"], ["H · Compact cards"],
    ]);
  });

  it("fold Finished and nothing else", () => {
    expect(GROUP_FOLDED).toEqual({ needs: false, running: false, finished: true, planned: false });
  });

  it("leave out a group with nothing in it", () => {
    const only = ledger([working]);
    expect(runProgress(only.snapshot, only.run, NOW).groups.map((group) => group.key)).toEqual(["running"]);
    const none = ledger([]);
    expect(runProgress(none.snapshot, none.run, NOW).groups).toEqual([]);
  });

  it("say what a planned task still waits for, by title, and only what is not finished", () => {
    const planned = runProgress(all.snapshot, all.run, NOW).groups.at(-1)!.rows[0];
    expect(planned.after).toEqual(["C · Server"]);
  });

  it("put the latest finish first, and a task that can start before one that waits", () => {
    const early = going("early", "completed", "completed", { attempt: { finishedAt: START + 5 * MINUTE } });
    const late = going("late", "completed", "completed", { attempt: { finishedAt: START + 50 * MINUTE } });
    const dropped = task("dropped", "cancelled");
    const waits = task("waits", "pending");
    const ready = task("ready", "ready");
    const mixed = ledger([early, { task: dropped }, late, { task: waits }, { task: ready }]);
    const groups = runProgress(mixed.snapshot, mixed.run, NOW).groups;
    expect(groups.find((group) => group.key === "finished")!.rows.map((row) => row.task.title)).toEqual(["late", "early", "dropped"]);
    expect(groups.find((group) => group.key === "planned")!.rows.map((row) => row.task.title)).toEqual(["ready", "waits"]);
  });

  it("show three of a long quiet group and count the rest, and every row of one that asks", () => {
    const done = Array.from({ length: 13 }, (_, index) => going(`done ${index}`, "completed", "completed"));
    const asks = Array.from({ length: 5 }, (_, index) => going(`asks ${index}`, "blocked", "blocked"));
    const many = ledger([...done, ...asks], { gates: asks.map((item) => gate(item.task.id)) });
    const groups = runProgress(many.snapshot, many.run, NOW).groups;
    const finishedGroup = groups.find((group) => group.key === "finished")!;
    expect(shownRows(finishedGroup, false)).toMatchObject({ more: 10 });
    expect(shownRows(finishedGroup, false).rows).toHaveLength(3);
    expect(shownRows(finishedGroup, true)).toMatchObject({ more: 0 });
    expect(shownRows(finishedGroup, true).rows).toHaveLength(13);
    expect(shownRows(groups.find((group) => group.key === "needs")!, false)).toMatchObject({ more: 0 });
    // Four rows are drawn whole: a "1 more" line would cost the line it saves.
    const four = ledger(done.slice(0, 4));
    expect(shownRows(runProgress(four.snapshot, four.run, NOW).groups[0], false)).toMatchObject({ more: 0 });
  });
});

describe("the Running group", () => {
  const executing = (title: string) => going(title, "running", "running", { attempt: { execution: { state: "executing", retryCount: 0 } } });

  it("puts a worker in trouble ahead of the ones that are simply going", () => {
    const fine = executing("fine");
    const stalled = going("stalled", "running", "running", { attempt: { execution: { state: "stalled", retryCount: 0 } } });
    const made = ledger([fine, stalled]);
    expect(runProgress(made.snapshot, made.run, NOW).groups[0].rows.map((row) => row.task.title)).toEqual(["stalled", "fine"]);
  });

  it("lists what failed first, in the danger colour, then a worker in trouble, then the rest", () => {
    const fine = executing("fine");
    const stalled = going("stalled", "running", "running", { attempt: { execution: { state: "stalled", retryCount: 0 } } });
    const broke = going("broke", "failed", "failed");
    const stuck = going("stuck", "blocked", "blocked");
    const check = going("check", "completed", "completed", { task: { kind: "review", verdict: "fail" } });
    const made = ledger([fine, stalled, broke, stuck, check]);
    const { groups } = runProgress(made.snapshot, made.run, NOW);
    // One group: nothing here waits on the person.
    expect(groups.map((group) => group.key)).toEqual(["running"]);
    expect(groups[0].rows.map((row) => [row.task.title, row.tone, row.why])).toEqual([
      ["broke", "danger", "Failed"], ["stuck", "danger", "Blocked"], ["check", "danger", "Check failed"],
      ["stalled", "warn", "Stalled"], ["fine", null, null],
    ]);
  });

  it("marks a turn in flight on the row whose worker is executing, and on no other", () => {
    const parts = [
      executing("executing"),
      going("tool", "running", "running", { attempt: { execution: { state: "waiting_tool", retryCount: 0 } } }),
      going("stalled", "running", "running", { attempt: { execution: { state: "stalled", retryCount: 0 } } }),
      going("preparing", "running", "preparing"),
      going("broke", "failed", "failed"),
      going("done", "completed", "completed"),
      { task: task("later", "pending") },
    ];
    const made = ledger(parts);
    const flying = runProgress(made.snapshot, made.run, NOW).rows.filter((row) => row.flight).map((row) => row.task.title);
    expect(flying).toEqual(["executing", "tool"]);
  });
});

/* The reviewer's shapes (review of e3e5e0f): who a wait is on is a fact the
   host sent or a card the page holds, and never a guess. */
describe("who a row waits on", () => {
  const worker = () => going("W · Build", "running", "running", { attempt: { execution: { state: "executing", retryCount: 0 } } });
  const read = (part: ReturnType<typeof worker>, over: Partial<OrchestrationSnapshot> = {}, waiting?: Waiting) => {
    const made = ledger([part], over);
    const progress = runProgress(made.snapshot, made.run, NOW, waiting);
    return { row: progress.rows[0], strip: progress.strip!, groups: progress.groups.map((group) => group.key) };
  };

  it("a refusal nobody can approve stays Running with the worker's own word: no decision, never Awaiting approval", () => {
    const part = worker();
    const { row, strip, groups } = read(part, { nativeDecisions: [native(part, { awaits: "nobody" })] });
    expect(row).toMatchObject({ state: "running", group: "running", why: null, tone: null, decisions: 0, hint: null, flight: true });
    expect(groups).toEqual(["running"]);
    expect(strip).toMatchObject({ state: "running", needs: 0, side: [{ text: "1 working", strong: false }], notes: [] });
    expect(JSON.stringify([row.why, strip.side])).not.toMatch(/approval|decision/i);
    // The same on a worker whose turn ended on it and reported blocked: the
    // refusal is no open decision, so the block is the task's own.
    const gaveUp = going("W", "blocked", "blocked");
    expect(read(gaveUp, { nativeDecisions: [native(gaveUp, { awaits: "nobody" })] }).row)
      .toMatchObject({ state: "failed", group: "running", why: "Blocked", tone: "danger" });
  });

  it("the same refusal from a host that does not say who it waits on is not the person's, and the tooltip says why", () => {
    const part = worker();
    const { row, strip, groups } = read(part, { nativeDecisions: [native(part)] });
    expect(row).toMatchObject({ state: "running", group: "running", why: null, decisions: 0, hint: UNSAID_NOTE });
    expect(groups).toEqual(["running"]);
    expect(strip).toMatchObject({ state: "running", needs: 0, side: [{ text: "1 working" }] });
    expect(strip.notes).toEqual(["1 open decision: the host does not say who it waits on."]);
  });

  it("a card the page holds for that same decision is the person's, once", () => {
    const part = worker();
    const decision = native(part);
    // The safety card and the ledger's record of it are one thing.
    const { row, strip } = read(part, { nativeDecisions: [decision] }, cards(part.task.id, ["safety", decision.id]));
    expect(row).toMatchObject({ state: "needs", group: "needs", why: "Awaiting review", tone: "decide", decisions: 1, hint: null });
    expect(strip).toMatchObject({ state: "needs", needs: 1, side: [{ text: "1 decision", strong: true }], notes: [] });
    // An outage's refusals sit on one card, under the group's id.
    const outage = read(part, { nativeDecisions: [native(part, { id: "r1", groupId: "g1" }), native(part, { id: "r2", groupId: "g1" })] },
      cards(part.task.id, ["outage", "g1"]));
    expect(outage.row).toMatchObject({ state: "needs", why: "Safety check was down", decisions: 1 });
    expect(outage.strip.needs).toBe(1);
  });

  it("a gate the coordinator has stays under Running, as a warning, with the host's word", () => {
    const part = going("W", "blocked", "blocked");
    const { row, strip, groups } = read(part, { gates: [gate(part.task.id, "open", "coordinator")] });
    expect(row).toMatchObject({ state: "running", group: "running", why: "Waiting on the coordinator", tone: "warn", decisions: 0, flight: false });
    expect(groups).toEqual(["running"]);
    expect(strip).toMatchObject({ state: "running", needs: 0, failed: 0, side: [], live: false });
    expect(strip.notes).toEqual(["1 waiting on the coordinator."]);
    // A native decision the coordinator was told to read is the same.
    const running = worker();
    expect(read(running, { nativeDecisions: [native(running, { awaits: "coordinator" })] }).row)
      .toMatchObject({ state: "running", why: "Waiting on the coordinator", tone: "warn" });
  });

  it("a gate from a host that does not say is shown as open, counted as nobody's, and explained", () => {
    const part = going("W", "blocked", "blocked");
    const { row, strip, groups } = read(part, { gates: [gate(part.task.id, "open", null)] });
    expect(row).toMatchObject({ state: "running", group: "running", why: "Asks a decision", tone: null, decisions: 0, hint: UNSAID_NOTE });
    expect(groups).toEqual(["running"]);
    expect(strip).toMatchObject({ state: "running", needs: 0, failed: 0 });
    expect(strip.notes).toEqual(["1 open decision: the host does not say who it waits on."]);
    // Of the run itself, and two of them.
    const runLevel = ledger([worker()], { gates: [gate(undefined, "open", null), { ...gate(undefined, "open", null), id: "gate_2" }] });
    expect(runProgress(runLevel.snapshot, runLevel.run, NOW).strip).toMatchObject({
      state: "running", needs: 0, notes: ["2 open decisions: the host does not say who they wait on."],
    });
  });

  it("a gate on a peer request is the person's on any host: only their page can answer it", () => {
    const part = going("W", "blocked", "blocked", { task: { peerRequest: {
      requestedBy: { id: "a", name: "Asker" }, requesterChatKey: "chat:x", output: "o", maxMinutes: 30, requestedAt: START,
    } } });
    expect(read(part, { gates: [gate(part.task.id, "open", null)] }).row).toMatchObject({ state: "needs", why: "Asks a decision", decisions: 1 });
  });

  it("counts decisions per card and not per row: two cards of one worker are two", () => {
    const part = going("W", "running", "running", { attempt: { execution: { state: "waiting_tool", retryCount: 0 } } });
    const { row, strip } = read(part, {}, cards(part.task.id, ["permission", "p1"], ["permission", "p2"]));
    expect(row).toMatchObject({ state: "needs", decisions: 2 });
    expect(strip).toMatchObject({ state: "needs", needs: 2, side: [{ text: "2 decisions", strong: true }] });
    // A gate and a card of the same task are two; the same card twice is one.
    const mixed = read(part, { gates: [gate(part.task.id)] }, cards(part.task.id, ["permission", "p1"], ["permission", "p1"]));
    expect(mixed.row.decisions).toBe(2);
    expect(mixed.strip.side[0]).toEqual({ text: "2 decisions", strong: true });
    // The plan and a card: two decisions, and no longer "Plan to approve".
    const planned = ledger([part], {}, run({ status: "running", planApproval: { status: "pending", requestedAt: START } }));
    expect(runProgress(planned.snapshot, planned.run, NOW, cards(part.task.id, ["permission", "p1"])).strip!.side[0].text).toBe("2 decisions");
  });

  it("says Failed only while a failed row exists and nothing waits on the person", () => {
    const broke = going("broke", "failed", "failed");
    const asks = going("asks", "blocked", "blocked");
    const alone = ledger([broke, worker()]);
    expect(runProgress(alone.snapshot, alone.run, NOW).strip).toMatchObject({
      state: "failed", word: "Failed", side: [{ text: "1 failed", strong: true }, { text: "1 working", strong: false }],
    });
    const both = ledger([broke, asks], { gates: [gate(asks.task.id)] });
    expect(runProgress(both.snapshot, both.run, NOW).strip).toMatchObject({ state: "needs", side: [{ text: "1 decision" }, { text: "1 failed" }] });
    // A gate that is not the person's does not hide the failure.
    const theirs = ledger([broke, asks], { gates: [gate(asks.task.id, "open", "coordinator")] });
    expect(runProgress(theirs.snapshot, theirs.run, NOW).strip).toMatchObject({ state: "failed", needs: 0 });
    // Replaced, the failure is history and the strip is not Failed.
    const replaced = ledger([{ ...broke, task: { ...broke.task, supersededBy: "task_new" } }, worker()]);
    expect(runProgress(replaced.snapshot, replaced.run, NOW).strip).toMatchObject({ state: "running", failed: 0 });
  });

  it("reads the same from the chat's scoped snapshot as from the whole ledger", () => {
    const part = worker();
    for (const awaits of ["person", "coordinator", "nobody", undefined] as const) {
      const whole = ledger([part], { nativeDecisions: [native(part, awaits ? { awaits } : {})] });
      const scoped = chatSnapshot(whole.snapshot, whole.run.coordinatorChatKey);
      expect(scoped.nativeDecisions).toHaveLength(1);
      const full = runProgress(whole.snapshot, whole.run, NOW);
      const mine = runProgress(scoped, scoped.runs[0], NOW);
      expect(mine.strip).toEqual(full.strip);
      expect(mine.rows.map((row) => [row.state, row.why, row.decisions, row.hint])).toEqual(full.rows.map((row) => [row.state, row.why, row.decisions, row.hint]));
    }
    // Another chat's decisions do not come along.
    const whole = ledger([part], { nativeDecisions: [native(part, { awaits: "person" }), native(part, { id: "other", runId: "run_other" })] });
    expect(chatSnapshot(whole.snapshot, "chat:main").nativeDecisions!.map((item) => item.id)).toEqual([`nd_${part.task.id}`]);
    // A host that sends none keeps the field absent, not empty.
    expect("nativeDecisions" in chatSnapshot(ledger([part]).snapshot, "chat:main")).toBe(false);
  });
});

describe("one row", () => {
  const rowOf = (part: { task: OrchestrationTask; attempt?: OrchestrationAttempt }, over: Partial<OrchestrationSnapshot> = {}, theRun = run()): ProgressRow => {
    const made = ledger([part], over, theRun);
    return runProgress(made.snapshot, made.run, NOW).rows[0];
  };

  it("is Needs you for an open decision, in the host's words", () => {
    const part = going("D", "blocked", "blocked");
    expect(rowOf(part, { gates: [gate(part.task.id)] })).toMatchObject({ state: "needs", group: "needs", why: "Asks a decision", tone: "decide" });
    // A decision already answered asks nothing: the block is the worker's.
    expect(rowOf(part, { gates: [gate(part.task.id, "resolved")] })).toMatchObject({ state: "failed", why: "Blocked", tone: "danger" });
  });

  it("is Needs you for a card the page holds for the person, and for a native decision the host says is theirs", () => {
    const part = going("D", "running", "running", { attempt: { execution: { state: "waiting_tool", retryCount: 0 } } });
    const made = ledger([part]);
    expect(runProgress(made.snapshot, made.run, NOW, cards(part.task.id, ["permission", "p1"])).rows[0])
      .toMatchObject({ state: "needs", why: "Awaiting approval", decisions: 1 });
    expect(runProgress(made.snapshot, made.run, NOW, cards(part.task.id, ["question", "q1"])).rows[0].why).toBe("Asks a question");
    expect(rowOf(part, { nativeDecisions: [native(part, { awaits: "person" })] })).toMatchObject({ state: "needs", why: "Awaiting review", tone: "decide" });
    expect(rowOf(part, { nativeDecisions: [native(part, { awaits: "person", status: "resolved" })] }).state).toBe("running");
  });

  it("is failed, under Running, for a failure, a block with no decision open, and a check that said fail", () => {
    // The person's decision: these are not "Needs you", and there is no
    // fifth group for them.
    expect(rowOf(going("x", "failed", "failed"))).toMatchObject({ state: "failed", group: "running", why: "Failed", tone: "danger", decisions: 0 });
    expect(rowOf(going("x", "blocked", "blocked"))).toMatchObject({ state: "failed", group: "running", why: "Blocked", tone: "danger" });
    expect(rowOf(going("x", "completed", "completed", { task: { kind: "review", verdict: "fail" } })))
      .toMatchObject({ state: "failed", group: "running", why: "Check failed", tone: "danger", verdict: "fail" });
    expect(GROUP_ORDER).toEqual(["needs", "running", "finished", "planned"]);
  });

  it("is history once it was replaced or cancelled, and owes nothing", () => {
    expect(rowOf(going("x", "failed", "failed", { task: { supersededBy: "task_other" } }))).toMatchObject({ state: "closed", group: "finished", why: "Replaced" });
    expect(rowOf(going("x", "completed", "completed", { task: { verdict: "fail", supersededBy: "task_other" } })).state).toBe("done");
    expect(rowOf({ task: task("x", "cancelled") })).toMatchObject({ state: "closed", why: "Cancelled" });
    expect(rowOf(going("x", "blocked", "blocked"), {}, run({ status: "stopped" }))).toMatchObject({ state: "closed", why: "Stopped" });
  });

  it("keeps a worker in trouble under Running, with the host's label as a warning", () => {
    const stalled = going("x", "running", "running", { attempt: { execution: { state: "stalled", retryCount: 0 } } });
    expect(rowOf(stalled)).toMatchObject({ state: "running", group: "running", why: "Stalled", tone: "warn" });
    const retrying = going("x", "running", "running", { attempt: { execution: { state: "retrying", retryCount: 1 } } });
    expect(rowOf(retrying)).toMatchObject({ state: "running", why: "Retrying", tone: "warn" });
    const preparing = going("x", "running", "preparing");
    expect(rowOf(preparing)).toMatchObject({ state: "running", why: "Preparing workspace", tone: null });
    const plain = going("x", "running", "running", { attempt: { execution: { state: "executing", retryCount: 0 } } });
    expect(rowOf(plain)).toMatchObject({ state: "running", why: null, tone: null });
  });

  it("carries the checklist as counts and a bar, and a pass as a verdict", () => {
    const part = going("C", "running", "running");
    const row = rowOf(part, { reports: { [part.attempt.workerChatKey]: report(3, 9) } });
    expect(row.steps).toEqual({ done: 3, total: 9 });
    expect(row.percent).toBe(33);
    const done = going("E", "completed", "completed", { task: { kind: "review", verdict: "pass" } });
    expect(rowOf(done)).toMatchObject({ state: "done", verdict: "pass", percent: 100, steps: null });
    // Nothing reported: no count, and no bar for work still going.
    expect(rowOf(going("G", "running", "running"))).toMatchObject({ steps: null, percent: null });
    expect(rowOf({ task: task("H", "pending") })).toMatchObject({ state: "planned", steps: null, percent: null, elapsedMs: null });
  });

  it("holds none of the worker's own words: not its step, its summary, a path or a commit", () => {
    const sha = "a".repeat(40);
    const part = going("C · Server", "running", "running", {
      task: { result: `Done in /Users/me/repo at ${sha}` },
      attempt: { summary: `Wrote /Users/me/repo/src at ${sha}`, execution: { state: "executing", retryCount: 0, lastProgress: "Started Bash /Users/me", currentOperation: "Bash" } },
    });
    const row = rowOf(part, { reports: { [part.attempt.workerChatKey]: report(3, 9) } });
    const { task: _task, attempt: _attempt, ...drawn } = row;
    const text = JSON.stringify(drawn);
    expect(text).not.toContain("/Users/");
    expect(text).not.toContain(sha);
    expect(text).not.toContain("Reading");
    expect(text).not.toContain("brief");
    expect(text).not.toContain("Bash");
  });

  it("names the model and effort of the attempt, else of the worker the task was planned for", () => {
    expect(rowOf(going("x", "running", "running"))).toMatchObject({ model: "opus", effort: "high" });
    expect(rowOf({ task: task("x", "pending", { worker: { agent: "codex", access: "auto", model: "gpt-6.1-sol", effort: "high" } }) }))
      .toMatchObject({ model: "gpt-6.1-sol", effort: "high" });
    expect(rowOf({ task: task("x", "pending") })).toMatchObject({ model: null, effort: null });
  });

  it("takes its minutes from the attempts, and its tokens and context only from the host", () => {
    const live = going("C", "running", "running");
    // Nothing sent: nothing drawn.
    expect(rowOf(live)).toMatchObject({ elapsedMs: 126 * MINUTE, tokens: null, context: null });
    expect(figuresLabel(rowOf(live))).toBe("2h 06m");
    const sent = going("C", "running", "running", { attempt: {
      usage: { input: 500_000, cachedInput: 400_000, output: 20_000 }, context: { tokens: 82_000, window: 200_000 },
    } });
    expect(figuresLabel(rowOf(sent))).toBe("ctx 41% · 520k · 2h 06m");
    // A finished worker holds no context any more: tokens and time only.
    const settled = going("E", "completed", "completed", { attempt: {
      finishedAt: START + 72 * MINUTE, usage: { input: 1_800_000, output: 100_000 }, context: { tokens: 82_000, window: 200_000 },
    } });
    expect(figuresLabel(rowOf(settled))).toBe("1.9M · 1h 12m");
  });

  it("adds a retry's tokens to the attempt before it", () => {
    const made = task("x", "running", { id: "task_retry" });
    const first = attempt(made, "failed", { id: "a1", number: 1, usage: { input: 100_000, output: 5_000 } });
    const second = attempt(made, "running", { id: "a2", number: 2, workerChatKey: "chat:orch-2", usage: { input: 200_000, output: 5_000 } });
    const both = ledger([{ task: { ...made, activeAttemptId: "a2" } }], { attempts: [first, second] });
    expect(runProgress(both.snapshot, both.run, NOW).rows[0].tokens).toBe(310_000);
  });
});

describe("the strip", () => {
  const working = (title: string) => going(title, "running", "running", { attempt: { execution: { state: "executing", retryCount: 0 } } });
  const finished = (title: string) => going(title, "completed", "completed", { attempt: { finishedAt: START + 30 * MINUTE } });
  const planned = (title: string) => ({ task: task(title, "pending") });

  /** `done` finished, `busy` working, the rest planned, `total` in all. */
  const mix = (done: number, busy: number, total: number) => [
    ...Array.from({ length: done }, (_, i) => finished(`done ${i}`)),
    ...Array.from({ length: busy }, (_, i) => working(`busy ${i}`)),
    ...Array.from({ length: total - done - busy }, (_, i) => planned(`later ${i}`)),
  ];

  it("says Running, how far, and how many are working", () => {
    const made = ledger(mix(13, 4, 22));
    expect(runProgress(made.snapshot, made.run, NOW).strip).toMatchObject({
      state: "running", word: "Running", label: "Tasks 13/22", percent: 59, done: 13, total: 22, live: true,
      side: [{ text: "4 working", strong: false }],
    });
  });

  it("says Needs you first, in what waits, then who is still working", () => {
    const asking = going("D", "blocked", "blocked");
    const made = ledger([...mix(13, 3, 21), asking], { gates: [gate(asking.task.id)] });
    expect(runProgress(made.snapshot, made.run, NOW).strip).toMatchObject({
      state: "needs", word: "Needs you", label: "Tasks 13/22", percent: 59, live: false,
      side: [{ text: "1 decision", strong: true }, { text: "3 working", strong: false }],
    });
  });

  it("counts a decision that names no task, and a plan waiting for approval", () => {
    const runGate = ledger(mix(1, 1, 3), { gates: [gate(undefined)] });
    expect(runProgress(runGate.snapshot, runGate.run, NOW).strip).toMatchObject({ state: "needs", side: [{ text: "1 decision" }, { text: "1 working" }] });
    const plan = ledger(mix(0, 0, 3), {}, run({ status: "planning", planApproval: { status: "pending", requestedAt: START } }));
    expect(runProgress(plan.snapshot, plan.run, NOW).strip).toMatchObject({ state: "needs", side: [{ text: "Plan to approve", strong: true }] });
    // Approved: nothing waits.
    const approved = ledger(mix(0, 0, 3), {}, run({ status: "running", planApproval: { status: "approved", requestedAt: START } }));
    expect(runProgress(approved.snapshot, approved.run, NOW).strip).toMatchObject({ state: "running", side: [] });
  });

  it("says Failed for a failed task or a check that said fail, and keeps the count honest", () => {
    const broke = going("x", "failed", "failed");
    const made = ledger([...mix(10, 2, 21), broke]);
    expect(runProgress(made.snapshot, made.run, NOW).strip).toMatchObject({
      state: "failed", word: "Failed", label: "Tasks 10/22", percent: 45,
      side: [{ text: "1 failed", strong: true }, { text: "2 working", strong: false }],
    });
    // A failed check is completed in the ledger, and is not counted done.
    const check = going("review", "completed", "completed", { task: { kind: "review", verdict: "fail" } });
    const reviewed = ledger([...mix(2, 0, 2), check]);
    expect(runProgress(reviewed.snapshot, reviewed.run, NOW).strip).toMatchObject({ state: "failed", label: "Tasks 2/3", side: [{ text: "1 failed" }] });
  });

  it("puts a decision ahead of a failure, and names both", () => {
    const asking = going("D", "blocked", "blocked");
    const broke = going("x", "failed", "failed");
    const made = ledger([...mix(1, 2, 3), asking, broke], { gates: [gate(asking.task.id)] });
    expect(runProgress(made.snapshot, made.run, NOW).strip).toMatchObject({
      state: "needs", side: [{ text: "1 decision" }, { text: "1 failed" }],
    });
  });

  it("says Done with the whole count and how long it took", () => {
    const last = going("last", "completed", "completed", { attempt: { finishedAt: START + 161 * MINUTE } });
    const made = ledger([...mix(21, 0, 21), last], {}, run({ status: "completed" }));
    expect(runProgress(made.snapshot, made.run, NOW + 999 * MINUTE).strip).toMatchObject({
      state: "done", word: "Done", label: "Done · 22/22", percent: 100, live: false,
      side: [{ text: "2h 41m", strong: false }],
    });
  });

  it("reaches Done past a task that was cancelled or replaced", () => {
    const replaced = going("old", "failed", "failed", { task: { supersededBy: "task_new" } });
    const made = ledger([...mix(3, 0, 3), replaced, { task: task("dropped", "cancelled") }], {}, run({ status: "completed" }));
    const progress = runProgress(made.snapshot, made.run, NOW);
    expect(progress.strip).toMatchObject({ state: "done", label: "Done · 3/3" });
    expect(progress.tiles.tasks).toEqual({ done: 3, total: 3 });
  });

  it("leaves out every count that is zero", () => {
    // Nobody working: no "0 working".
    const idle = ledger(mix(1, 0, 3));
    expect(runProgress(idle.snapshot, idle.run, NOW).strip!.side).toEqual([]);
    const broke = ledger([...mix(1, 0, 1), going("x", "failed", "failed")]);
    expect(runProgress(broke.snapshot, broke.run, NOW).strip!.side).toEqual([{ text: "1 failed", strong: true }]);
    for (const made of [idle, broke]) {
      for (const item of runProgress(made.snapshot, made.run, NOW).strip!.side) expect(item.text).not.toMatch(/\b0\b/);
    }
  });

  it("never carries more than two counts", () => {
    const asks = [going("a", "blocked", "blocked"), going("b", "blocked", "blocked")];
    const made = ledger([...mix(1, 3, 6), ...asks, going("x", "failed", "failed")], { gates: asks.map((item) => gate(item.task.id)) });
    const strip = runProgress(made.snapshot, made.run, NOW).strip!;
    expect(strip.side.map((item) => item.text)).toEqual(["2 decisions", "1 failed"]);
  });

  it("does not count a stalled worker as working, and is not Failed for it", () => {
    const stalled = going("x", "running", "running", { attempt: { execution: { state: "stalled", retryCount: 0 } } });
    const made = ledger([...mix(0, 1, 1), stalled]);
    expect(runProgress(made.snapshot, made.run, NOW).strip).toMatchObject({ state: "running", side: [{ text: "1 working" }] });
  });

  it("is not drawn for a run with nothing to count, or one that is history", () => {
    const empty = ledger([]);
    expect(runProgress(empty.snapshot, empty.run, NOW).strip).toBeNull();
    for (const over of [{ status: "stopped" as const }, { status: "closed" as const }, { archivedAt: NOW }]) {
      const made = ledger(mix(1, 1, 3), {}, run(over));
      expect(runProgress(made.snapshot, made.run, NOW).strip).toBeNull();
    }
  });

  it("names no repository, branch, model or path", () => {
    const made = ledger(mix(2, 2, 6));
    const text = JSON.stringify(runProgress(made.snapshot, made.run, NOW).strip);
    for (const word of ["opus", "feature/x", "/repo", "Ship it", "/Users/"]) expect(text).not.toContain(word);
  });

  it("moves, and takes the accent, only while a turn is in flight", () => {
    // All planned: the run is live, and nothing is running.
    const allPlanned = ledger(mix(0, 0, 3));
    expect(runProgress(allPlanned.snapshot, allPlanned.run, NOW).strip).toMatchObject({ state: "running", live: false, working: 0, side: [] });
    // Its only worker has stalled.
    const stalled = going("x", "running", "running", { attempt: { execution: { state: "stalled", retryCount: 0 } } });
    const onlyStalled = ledger([stalled]);
    expect(runProgress(onlyStalled.snapshot, onlyStalled.run, NOW).strip).toMatchObject({ state: "running", live: false, working: 0, side: [] });
    // A failed check reopened as ready: nothing failed, nothing running.
    const reopened = ledger([{ task: task("review", "ready", { kind: "review" }) }]);
    expect(runProgress(reopened.snapshot, reopened.run, NOW).strip).toMatchObject({ state: "running", live: false, failed: 0 });
    // Preparing a workspace is the host's work, not a turn.
    const preparing = ledger([going("x", "running", "preparing")]);
    expect(runProgress(preparing.snapshot, preparing.run, NOW).strip).toMatchObject({ state: "running", live: false, working: 0 });
    // One attempt executing is enough, beside any number that are not.
    const one = ledger([stalled, ...mix(0, 1, 4)]);
    expect(runProgress(one.snapshot, one.run, NOW).strip).toMatchObject({ state: "running", live: true, working: 1, side: [{ text: "1 working" }] });
    // Never while it asks, failed or finished, whoever is still working.
    const asking = going("D", "blocked", "blocked");
    const asks = ledger([...mix(0, 2, 2), asking], { gates: [gate(asking.task.id)] });
    expect(runProgress(asks.snapshot, asks.run, NOW).strip).toMatchObject({ state: "needs", live: false, working: 2 });
    const broke = ledger([...mix(0, 2, 2), going("x", "failed", "failed")]);
    expect(runProgress(broke.snapshot, broke.run, NOW).strip).toMatchObject({ state: "failed", live: false });
    // A run that ended keeps nothing moving even if a record says executing.
    const ended = ledger(mix(0, 1, 1), {}, run({ status: "completed" }));
    expect(runProgress(ended.snapshot, ended.run, NOW).strip!.live).toBe(false);
  });

  describe("for a chat that coordinates several runs", () => {
    const inRun = (runId: string, part: ReturnType<typeof working>) => ({
      task: { ...part.task, runId }, attempt: { ...part.attempt, runId },
    });
    /** Two live runs of one chat, the newer one first as `chatSnapshot` sorts. */
    const two = (older: ReturnType<typeof working>[], newer: ReturnType<typeof working>[], over: Partial<OrchestrationSnapshot> = {}) => {
      const runs = [run({ id: "run_new", createdAt: START + 10 }), run({ id: "run_old", createdAt: START })];
      const parts = [...newer.map((part) => inRun("run_new", part)), ...older.map((part) => inRun("run_old", part))];
      const whole: OrchestrationSnapshot = {
        runs: [...runs].reverse(), tasks: parts.map((part) => part.task), attempts: parts.map((part) => part.attempt), gates: [], messages: [], ...over,
      };
      return chatSnapshot(whole, "chat:main");
    };

    it("puts a run that waits on the person ahead of a newer one that is running, and says how many runs", () => {
      const asking = going("old asks", "blocked", "blocked");
      const snapshot = two([asking, finished("old done")], [working("new 1"), working("new 2")],
        { gates: [{ ...gate(asking.task.id), runId: "run_old" }] });
      // What the strip did before: the newest live run, and the wait unseen.
      expect(stripRun(snapshot.runs)?.id).toBe("run_new");
      const line = chatStrip(snapshot, NOW)!;
      expect(line.run.id).toBe("run_old");
      expect(line.strip).toMatchObject({
        state: "needs", word: "Needs you", label: "Tasks 1/2", runs: 2, live: false,
        side: [{ text: "1 decision", strong: true }, { text: "2 runs", strong: false }],
      });
      expect(line.strip.notes[0]).toBe("The bar is one of 2 live runs of this chat, the one that waits on you.");
    });

    it("counts what waits in every run, so the one it draws no bar for is not hidden", () => {
      const a = going("a", "blocked", "blocked");
      const b = going("b", "blocked", "blocked");
      const c = going("c", "running", "running", { attempt: { execution: { state: "waiting_tool", retryCount: 0 } } });
      const snapshot = two([a], [b, c], { gates: [{ ...gate(a.task.id), runId: "run_old" }, { ...gate(b.task.id), runId: "run_new" }] });
      const line = chatStrip(snapshot, NOW, cards(c.task.id, ["permission", "p1"], ["permission", "p2"]))!;
      // The first that asks, in the order the chat lists its runs.
      expect(line.run.id).toBe("run_new");
      expect(line.strip).toMatchObject({ state: "needs", needs: 4, side: [{ text: "4 decisions", strong: true }, { text: "2 runs" }] });
      expect(line.strip.notes).toContain("1 decision in the other run.");
    });

    it("puts a failure ahead of plain progress, and a run in flight ahead of an idle one", () => {
      const failing = chatStrip(two([going("broke", "failed", "failed")], [working("new")]), NOW)!;
      expect(failing.run.id).toBe("run_old");
      expect(failing.strip).toMatchObject({ state: "failed", side: [{ text: "1 failed", strong: true }, { text: "2 runs" }] });
      const idleNew = chatStrip(two([working("old")], [{ ...working("x"), ...going("planned later", "ready", "completed") }]), NOW)!;
      expect(idleNew.run.id).toBe("run_old");
      expect(idleNew.strip).toMatchObject({ state: "running", live: true, side: [{ text: "1 working" }, { text: "2 runs" }] });
    });

    it("says nothing of runs when one is live, and reads exactly as that run does", () => {
      const made = ledger(mix(1, 1, 3));
      const scoped = chatSnapshot(made.snapshot, "chat:main");
      expect(chatStrip(scoped, NOW)!.strip).toEqual(runProgress(made.snapshot, made.run, NOW).strip);
      // A finished run beside a live one is history, not a second run.
      const snapshot = chatSnapshot({
        ...made.snapshot, runs: [made.run, run({ id: "run_done", status: "completed", createdAt: START - 5 })],
        tasks: [...made.snapshot.tasks, { ...finished("old").task, runId: "run_done" }],
      }, "chat:main");
      expect(chatStrip(snapshot, NOW)!.strip).toMatchObject({ runs: 1, side: [{ text: "1 working" }], notes: [] });
      expect(chatStrip(chatSnapshot({ runs: [], tasks: [], attempts: [], gates: [], messages: [] }, "chat:main"), NOW)).toBeNull();
    });

    it("comes back, once hidden, when another run starts to wait", () => {
      const asking = going("old asks", "blocked", "blocked");
      const quiet = chatStrip(two([asking], [working("new")]), NOW)!;
      const hidden = dismissStrip([], quiet.strip.signature);
      const asks = chatStrip(two([asking], [working("new")], { gates: [{ ...gate(asking.task.id), runId: "run_old" }] }), NOW)!;
      expect(stripHidden(hidden, asks.strip)).toBe(false);
    });
  });

  it("picks the run in flight, else the latest that is not put away", () => {
    const old = run({ id: "old", status: "completed" });
    const live = run({ id: "live", status: "running" });
    expect(stripRun([live, old])?.id).toBe("live");
    expect(stripRun([old])?.id).toBe("old");
    expect(stripRun([run({ id: "a", status: "stopped" }), run({ id: "b", status: "completed", archivedAt: 1 })])).toBeNull();
    expect(stripRun([])).toBeNull();
  });
});

describe("the tiles", () => {
  it("count tasks and time from the ledger, and tokens only when the host sent them", () => {
    const a = going("a", "completed", "completed", { attempt: { finishedAt: START + 20 * MINUTE } });
    const b = going("b", "running", "running");
    const bare = ledger([a, b]);
    expect(runProgress(bare.snapshot, bare.run, NOW).tiles).toEqual({ tasks: { done: 1, total: 2 }, tokens: null, elapsedMs: 126 * MINUTE });
    const sent = ledger([
      { ...a, attempt: { ...a.attempt, usage: { input: 9_000_000, output: 100_000 } } },
      { ...b, attempt: { ...b.attempt, usage: { input: 290_000, output: 10_000 } } },
    ]);
    expect(runProgress(sent.snapshot, sent.run, NOW).tiles.tokens).toBe(9_400_000);
  });

  it("has no time before anything was dispatched", () => {
    const made = ledger([{ task: task("x", "pending") }]);
    expect(runProgress(made.snapshot, made.run, NOW).tiles.elapsedMs).toBeNull();
  });
});

describe("hiding the strip", () => {
  const working = going("w", "running", "running", { attempt: { execution: { state: "executing", retryCount: 0 } } });
  const other = going("o", "running", "running", { attempt: { execution: { state: "executing", retryCount: 0 } } });
  const before = ledger([working, { task: task("later", "pending") }]);
  const strip = runProgress(before.snapshot, before.run, NOW).strip!;

  it("holds while the strip says the same thing, a worker starting or stopping included", () => {
    const hidden = dismissStrip([], strip.signature);
    expect(stripHidden(hidden, strip)).toBe(true);
    const more = ledger([working, other]);
    expect(stripHidden(hidden, runProgress(more.snapshot, more.run, NOW).strip)).toBe(true);
  });

  it("ends when a task finishes, something asks, or something fails", () => {
    const hidden = dismissStrip([], strip.signature);
    const done = ledger([{ ...working, task: { ...working.task, status: "completed" } }, { task: task("later", "pending") }]);
    expect(stripHidden(hidden, runProgress(done.snapshot, done.run, NOW).strip)).toBe(false);
    const asks = ledger([working, { task: task("later", "pending") }], { gates: [gate(undefined)] });
    expect(stripHidden(hidden, runProgress(asks.snapshot, asks.run, NOW).strip)).toBe(false);
  });

  it("keeps one dismissal per run, and a bounded list", () => {
    let list: string[] = [];
    for (let i = 0; i < 60; i += 1) list = dismissStrip(list, `run_${i}:running:0/1:0:0`);
    expect(list).toHaveLength(40);
    list = dismissStrip(list, "run_59:done:1/1:0:0");
    expect(list.filter((item) => item.startsWith("run_59:"))).toEqual(["run_59:done:1/1:0:0"]);
  });

  it("reads back only what it wrote", () => {
    expect(parseDismissed(JSON.stringify(["a:running:0/1:0:0", 4, null]))).toEqual(["a:running:0/1:0:0"]);
    expect(parseDismissed("{")).toEqual([]);
    expect(parseDismissed(null)).toEqual([]);
    expect(parseDismissed("\"x\"")).toEqual([]);
  });
});
