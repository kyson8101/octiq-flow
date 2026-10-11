import { describe, expect, it } from "vitest";
import {
  contextPercent, dismissStrip, figuresLabel, GROUP_FOLDED, minutesLabel, parseDismissed, runProgress, shownRows, stepsLabel,
  stripHidden, stripRun, tasksLabel, tokensLabel, usageTotal, type ProgressRow,
} from "./runProgress";
import type {
  OrchestrationAttempt, OrchestrationGate, OrchestrationRun, OrchestrationSnapshot, OrchestrationTask,
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

const gate = (taskId: string | undefined, status: OrchestrationGate["status"] = "open"): OrchestrationGate => ({
  id: `gate_${taskId ?? "run"}`, runId: "run_1", taskId, createdByChatKey: "chat:w", targetChatKey: "chat:main",
  question: "Which way?", options: [], status, createdAt: START, updatedAt: START,
});

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
  it("puts a worker in trouble ahead of the ones that are simply going", () => {
    const fine = going("fine", "running", "running", { attempt: { execution: { state: "executing", retryCount: 0 } } });
    const stalled = going("stalled", "running", "running", { attempt: { execution: { state: "stalled", retryCount: 0 } } });
    const made = ledger([fine, stalled]);
    expect(runProgress(made.snapshot, made.run, NOW).groups[0].rows.map((row) => row.task.title)).toEqual(["stalled", "fine"]);
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

  it("is Needs you for a card the host holds for the person, and for a native decision", () => {
    const part = going("D", "running", "running", { attempt: { execution: { state: "waiting_tool", retryCount: 0 } } });
    const made = ledger([part]);
    const waiting = new Map([[part.task.id, [{ kind: "permission" }]]]);
    expect(runProgress(made.snapshot, made.run, NOW, waiting).rows[0]).toMatchObject({ state: "needs", why: "Awaiting approval" });
    expect(runProgress(made.snapshot, made.run, NOW, new Map([[part.task.id, [{ kind: "question" }]]])).rows[0].why).toBe("Asks a question");
    const native = { id: "nd", runId: "run_1", taskId: part.task.id, attemptId: part.attempt.id, chatKey: "c", reason: "", blockedAction: null, status: "pending", continuation: "", recovery: "", observedAt: 1 };
    expect(rowOf(part, { nativeDecisions: [native] })).toMatchObject({ state: "needs", why: "Awaiting approval" });
    expect(rowOf(part, { nativeDecisions: [{ ...native, status: "resolved" }] }).state).toBe("running");
  });

  it("is failed for a failure, a block nobody is asked about, and a check that said fail", () => {
    expect(rowOf(going("x", "failed", "failed"))).toMatchObject({ state: "failed", group: "needs", why: "Failed", tone: "danger" });
    expect(rowOf(going("x", "blocked", "blocked"))).toMatchObject({ state: "failed", why: "Blocked" });
    expect(rowOf(going("x", "completed", "completed", { task: { kind: "review", verdict: "fail" } }))).toMatchObject({ state: "failed", why: "Check failed", verdict: "fail" });
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
