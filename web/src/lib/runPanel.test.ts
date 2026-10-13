import { describe, expect, it, vi } from "vitest";
import { EMPTY_ORCHESTRATION, type OrchestrationAttempt, type OrchestrationGate, type OrchestrationRun, type OrchestrationTask } from "./orchestration";
import {
  attentionLabel, attentionSpoken, attentionTone, mainChatTarget, nextRunTab, NO_STEPS, runAttention as attentionOf, runPeople as peopleOf, splitArchived, stopRun,
  TASK_TAB_LABEL, TASK_TABS, taskColumnCounts, taskTabKey,
} from "./runPanel";
import { runWaits, type Waiting } from "./runWaits";

const run = (id: string, coordinatorChatKey: string, extra: Partial<OrchestrationRun> = {}): OrchestrationRun => ({
  id, objective: id, coordinatorChatKey, workspaceId: "project", rootPath: "/repo",
  status: "running", maxConcurrent: 2, createdAt: 1, updatedAt: 1, ...extra,
});
const task = (id: string, status: OrchestrationTask["status"], extra: Partial<OrchestrationTask> = {}): OrchestrationTask => ({
  id, runId: "a", title: id, spec: "", dependsOn: [], status, createdAt: 1, updatedAt: 1, ...extra,
});
/** An open gate the host says waits on the person, unless told otherwise. */
const gate = (id: string, taskId?: string, awaits: OrchestrationGate["awaits"] | null = "person"): OrchestrationGate => ({
  id, runId: "a", taskId, createdByChatKey: "chat:w", targetChatKey: "chat:main", question: "?", options: [],
  status: "open", createdAt: 1, updatedAt: 1, ...(awaits ? { awaits } : {}),
});

/** The run's attention as the panel reads it: off `lib/runWaits`' reading of
 *  the ledger, and of the cards the page holds. */
const runAttention = (
  a: OrchestrationRun, tasks: OrchestrationTask[], attempts: OrchestrationAttempt[], gates: OrchestrationGate[], held?: Waiting,
) => attentionOf(a, tasks, attempts, runWaits({ ...EMPTY_ORCHESTRATION, runs: [a], tasks, attempts, gates }, a, held));
const runPeople = (
  a: OrchestrationRun, tasks: OrchestrationTask[], attempts: OrchestrationAttempt[], gates: OrchestrationGate[],
  roster: Parameters<typeof peopleOf>[4],
) => peopleOf(a, tasks, attempts, runWaits({ ...EMPTY_ORCHESTRATION, runs: [a], tasks, attempts, gates }, a).gated, roster);

describe("run tabs", () => {
  it("moves with arrows, wraps, and jumps with Home/End", () => {
    expect(nextRunTab("tasks", "ArrowRight")).toBe("notifications");
    expect(nextRunTab("log", "ArrowRight")).toBe("tasks");
    expect(nextRunTab("tasks", "ArrowLeft")).toBe("log");
    expect(nextRunTab("notifications", "Home")).toBe("tasks");
    expect(nextRunTab("tasks", "End")).toBe("log");
    expect(nextRunTab("tasks", "Enter")).toBeNull();
  });
});

describe("an opened task row's tabs", () => {
  const press = (key: string) => ({ key, repeat: false });

  it("are Steps then Details, and a row opens on Steps", () => {
    expect(TASK_TABS).toEqual(["steps", "details"]);
    expect(TASK_TAB_LABEL).toEqual({ steps: "Steps", details: "Details" });
    expect(NO_STEPS).toBe("No steps reported yet");
  });

  it("move with the arrows, wrap, and jump with Home and End", () => {
    expect(taskTabKey("steps", press("ArrowRight"))).toEqual({ to: "details", drop: true });
    expect(taskTabKey("details", press("ArrowRight"))).toEqual({ to: "steps", drop: true });
    expect(taskTabKey("steps", press("ArrowLeft"))).toEqual({ to: "details", drop: true });
    expect(taskTabKey("details", press("ArrowLeft"))).toEqual({ to: "steps", drop: true });
    expect(taskTabKey("details", press("Home"))).toEqual({ to: "steps", drop: true });
    expect(taskTabKey("steps", press("End"))).toEqual({ to: "details", drop: true });
  });

  it("leave every other key to the page", () => {
    for (const key of ["Tab", "Escape", "ArrowDown", "ArrowUp", "a", "Enter", " "]) {
      expect(taskTabKey("steps", press(key)), key).toEqual({ to: null, drop: false });
    }
  });

  it("move once for a key held down, and press nothing with its repeats", () => {
    for (const key of ["ArrowRight", "ArrowLeft", "Home", "End", "Enter", " ", "Spacebar"]) {
      expect(taskTabKey("steps", { key, repeat: true }), key).toEqual({ to: null, drop: true });
    }
    expect(taskTabKey("steps", { key: "Tab", repeat: true })).toEqual({ to: null, drop: false });
    expect(taskTabKey("steps", { key: "ArrowDown", repeat: true })).toEqual({ to: null, drop: false });
  });
});

describe("run attention", () => {
  it("counts a task blocked by a decision once, and a plan waiting as a decision", () => {
    const a = run("a", "chat:main", { planApproval: { status: "pending", requestedAt: 1 } });
    const tasks = [task("gated", "blocked"), task("stuck", "failed"), task("fine", "running")];
    const attention = runAttention(a, tasks, [], [gate("g", "gated")]);
    expect(attention).toEqual({ decisions: 2, planOnly: false, blocked: 1, failed: 1, total: 3 });
    expect(attentionLabel(attention)).toBe("2 to decide");
    // The plan alone is an approval, said as one.
    const alone = runAttention(a, tasks.slice(1), [], []);
    expect(alone).toMatchObject({ decisions: 1, planOnly: true });
    expect(attentionLabel(alone)).toBe("Approval needed");
  });

  it("counts as a decision only a gate that is the person's", () => {
    const a = run("a", "chat:main");
    const tasks = [task("gated", "blocked"), task("fine", "running")];
    for (const awaits of ["coordinator", "nobody", null] as const) {
      // Not a decision of the person's, and not a stuck task either: it is
      // waiting on a gate that is open.
      expect(runAttention(a, tasks, [], [gate("g", "gated", awaits)]), String(awaits)).toEqual({ decisions: 0, planOnly: false, blocked: 0, failed: 0, total: 0 });
    }
    expect(runAttention(a, tasks, [], [gate("g", "gated", "person"), gate("h", undefined, "coordinator")]).decisions).toBe(1);
  });

  it("owes nothing for a blocked task the coordinator replaced (feedback 6b0870f9)", () => {
    const a = run("a", "chat:main");
    const tasks = [task("old-review", "blocked", { supersededBy: "new-review" }), task("new-review", "pending")];
    expect(runAttention(a, tasks, [], [])).toEqual({ decisions: 0, planOnly: false, blocked: 0, failed: 0, total: 0 });
    expect(attentionLabel(runAttention(a, tasks, [], []))).toBeNull();
    expect(runAttention(a, [task("old-review", "blocked")], [], []).blocked).toBe(1);
  });

  it("names a stalled worker as blocked, and says nothing when nothing is owed", () => {
    const a = run("a", "chat:main");
    const attempt = { id: "at", runId: "a", taskId: "t", execution: { state: "stalled", retryCount: 0 } } as OrchestrationAttempt;
    const stalled = runAttention(a, [task("t", "running", { activeAttemptId: "at" })], [attempt], []);
    expect(attentionLabel(stalled)).toBe("1 blocked");
    expect(attentionTone(stalled)).toBe("blocked");
    expect(attentionSpoken(stalled)).toBe("1 task needs attention");
    expect(attentionLabel(runAttention(a, [task("t", "completed")], [], []))).toBeNull();
    // What failed is said as that, in the danger colour, and a worker in
    // trouble beside it is still in the button's sentence.
    for (const broke of [task("b", "failed"), task("b", "blocked"), task("b", "completed", { kind: "review", verdict: "fail" })]) {
      const failed = runAttention(a, [broke], [], []);
      expect(failed, broke.status).toMatchObject({ blocked: 1, failed: 1, total: 1 });
      expect(attentionLabel(failed)).toBe("1 failed");
      expect(attentionTone(failed)).toBe("failed");
      expect(attentionSpoken(failed)).toBe("1 task failed");
    }
    const both = runAttention(a, [task("b", "failed"), task("t", "running", { activeAttemptId: "at" })], [attempt], []);
    expect(both).toMatchObject({ blocked: 2, failed: 1 });
    expect(attentionLabel(both)).toBe("1 failed");
    expect(attentionSpoken(both)).toBe("1 task failed, 1 task needs attention");
    // A plan on a stopped run is no longer waiting on anyone.
    const stopped = run("a", "chat:main", { status: "stopped", planApproval: { status: "pending", requestedAt: 1 } });
    expect(runAttention(stopped, [], [], []).total).toBe(0);
    // Nor is a failure in it: nothing can retry a stopped run.
    expect(runAttention(stopped, [task("t", "failed")], [], []).total).toBe(0);
  });
});

describe("the top bar's Tasks button", () => {
  it("counts the column's tasks and the decisions waiting in it, across the chat's runs", () => {
    const a = run("a", "chat:main", { planApproval: { status: "pending", requestedAt: 1 } });
    const b = run("b", "chat:main");
    const tasks = [task("one", "running"), task("two", "blocked"), task("three", "pending", { runId: "b" })];
    const gates = [gate("g", "two"), { ...gate("h"), runId: "b" }];
    expect(taskColumnCounts({ ...EMPTY_ORCHESTRATION, runs: [a, b], tasks, gates }))
      .toEqual({ tasks: 3, decisions: 3 });
  });

  it("leaves archived runs out, and owes nothing for a settled gate or plan", () => {
    const live = run("a", "chat:main", { planApproval: { status: "approved", requestedAt: 1 } });
    const archived = run("b", "chat:main", { status: "completed", archivedAt: 2, planApproval: { status: "pending", requestedAt: 1 } });
    const tasks = [task("one", "completed"), task("old", "completed", { runId: "b" })];
    const gates = [{ ...gate("g"), status: "resolved" as const }, { ...gate("h"), runId: "b" }];
    expect(taskColumnCounts({ ...EMPTY_ORCHESTRATION, runs: [live, archived], tasks, gates }))
      .toEqual({ tasks: 1, decisions: 0 });
    expect(taskColumnCounts(EMPTY_ORCHESTRATION)).toEqual({ tasks: 0, decisions: 0 });
  });
});

describe("who a run is with", () => {
  const a = run("a", "chat:cto");
  const assigned = (id: string, status: OrchestrationTask["status"], who: string, extra: Partial<OrchestrationTask> = {}) =>
    task(id, status, { assignee: { id: who, name: `${who} (then)` }, ...extra });
  const attempt = (id: string, taskId: string, extra: Partial<OrchestrationAttempt> = {}) =>
    ({ id, runId: "a", taskId, number: 1, status: "running", ...extra }) as OrchestrationAttempt;
  const roster = [
    { id: "noah", name: "Noah", avatar: "noah.png" },
    { id: "maya", name: "Maya" },
    { id: "tofu", name: "Tofu" },
  ];

  it("tells working from merely assigned, stuck and finished, active first", () => {
    const tasks = [
      assigned("t1", "completed", "tofu"),
      assigned("t2", "ready", "maya"),
      assigned("t3", "running", "noah", { activeAttemptId: "x3" }),
      assigned("t4", "blocked", "rex"),
    ];
    const people = runPeople(a, tasks, [attempt("x3", "t3", { execution: { state: "executing", retryCount: 0 } })], [],
      [...roster, { id: "rex", name: "Rex" }]);
    // Blocked with no decision open is what the panel's row calls failed.
    expect(people.map((p) => [p.name, p.state])).toEqual([["Noah", "working"], ["Rex", "failed"], ["Maya", "assigned"], ["Tofu", "done"]]);
    expect(people[0].avatar).toBe("noah.png");
  });

  it("calls only work that finished well done: a task whose check failed is that person's failure", () => {
    const review = (over: Partial<OrchestrationTask> = {}) => assigned("r", "completed", "tofu", { kind: "review", ...over });
    const state = (task: OrchestrationTask) => runPeople(a, [task], [], [], roster)[0].state;
    expect(state(review({ verdict: "pass" }))).toBe("done");
    expect(state(review({ verdict: "fail" }))).toBe("failed");
    // Replaced, it is history.
    expect(state(review({ verdict: "fail", supersededBy: "r2" }))).toBe("done");
    // And it is counted with what the run owes, once.
    expect(runAttention(a, [review({ verdict: "fail" })], [], []).blocked).toBe(1);
    expect(runAttention(a, [review({ verdict: "pass" })], [], []).blocked).toBe(0);
    expect(runAttention(a, [review({ verdict: "fail", supersededBy: "r2" })], [], []).blocked).toBe(0);
  });

  it("does not call a running task working unless its worker is executing", () => {
    const tasks = [assigned("t", "running", "noah", { activeAttemptId: "x" })];
    const retrying = runPeople(a, tasks, [attempt("x", "t", { execution: { state: "retrying", retryCount: 1 } })], [], roster);
    expect(retrying[0].state).toBe("assigned");
    const stalled = runPeople(a, tasks, [attempt("x", "t", { execution: { state: "stalled", retryCount: 0 } })], [], roster);
    expect(stalled[0].state).toBe("blocked");
    // A task waiting on a decision is that person's block.
    expect(runPeople(a, [assigned("g", "running", "maya")], [], [gate("q", "g")], roster)[0].state).toBe("blocked");
  });

  it("names each person once, with their most urgent state and the roster's current name", () => {
    const tasks = [assigned("t1", "completed", "noah"), assigned("t2", "failed", "noah"), assigned("t3", "ready", "noah")];
    const [noah, ...rest] = runPeople(a, tasks, [], [], roster);
    expect(rest).toHaveLength(0);
    expect(noah).toMatchObject({ name: "Noah", state: "failed", tasks: 3, removed: false });
  });

  it("falls back to the name the task was given when the roster no longer has them", () => {
    const tasks = [assigned("t", "ready", "gone")];
    expect(runPeople(a, tasks, [], [], roster)[0]).toMatchObject({ name: "gone (then)", removed: true });
    // An unloaded roster says nothing about removal.
    expect(runPeople(a, tasks, [], [], [])[0]).toMatchObject({ name: "gone (then)", removed: false });
    // Tasks with no assignee are not people.
    expect(runPeople(a, [task("plain", "running")], [], [], roster)).toEqual([]);
  });

  it("marks unfinished work on a stopped run as stopped", () => {
    const stopped = run("a", "chat:cto", { status: "stopped" });
    const people = runPeople(stopped, [assigned("t1", "running", "noah"), assigned("t2", "completed", "maya")], [], [], roster);
    expect(people.map((p) => [p.name, p.state])).toEqual([["Maya", "done"], ["Noah", "stopped"]]);
  });
});

describe("main chat routing", () => {
  it("goes to the coordinator the ledger names for the run on screen", () => {
    const runs = [run("a", "chat:cto"), run("b", "chat:noah")];
    expect(mainChatTarget(runs, "b", "chat:cto")).toBe("chat:noah");
    expect(mainChatTarget(runs, "a", "chat:noah")).toBe("chat:cto");
    // Nothing selected yet: the first run shown, then the panel's own chat.
    expect(mainChatTarget(runs, null, "chat:other")).toBe("chat:cto");
    expect(mainChatTarget([], null, "chat:other")).toBe("chat:other");
  });

  it("keeps archived runs apart from the list", () => {
    const { live, archived } = splitArchived([run("a", "c"), run("b", "c", { status: "stopped", archivedAt: 5 })]);
    expect(live.map((item) => item.id)).toEqual(["a"]);
    expect(archived.map((item) => item.id)).toEqual(["b"]);
  });

  it("does not put away an archived run that still holds something for the person", () => {
    const runs = [run("a", "c"), run("b", "c", { status: "completed", archivedAt: 5 }), run("d", "c", { status: "stopped", archivedAt: 6 })];
    const { live, archived } = splitArchived(runs, (item) => item.id === "b");
    expect(live.map((item) => item.id)).toEqual(["a", "b"]);
    expect(archived.map((item) => item.id)).toEqual(["d"]);
  });
});

describe("stop, then archive", () => {
  const target = run("run_1", "chat:main");
  const succeed = () => vi.fn(async (_command: string, _args: Record<string, unknown>) => null);

  it("stops only, when archive was not chosen", async () => {
    const invoke = succeed();
    expect(await stopRun(invoke, target, false)).toEqual({ ok: true, archived: false });
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["orchestration_run_stop"]);
    expect(invoke).toHaveBeenCalledWith("orchestration_run_stop", expect.objectContaining({ actorChatKey: "chat:main", runId: "run_1" }));
  });

  it("archives only after the stop has landed", async () => {
    const invoke = succeed();
    expect(await stopRun(invoke, target, true)).toEqual({ ok: true, archived: true });
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["orchestration_run_stop", "orchestration_run_archive"]);
    expect(invoke).toHaveBeenLastCalledWith("orchestration_run_archive", { actorChatKey: "chat:main", runId: "run_1", archived: true });
  });

  it("never archives when the stop fails, and says so", async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "orchestration_run_stop") throw new Error("Only this run's coordinator may do that.");
      return null;
    });
    const outcome = await stopRun(invoke, target, true);
    expect(outcome).toEqual({ ok: false, stopped: false,
      error: "Could not stop this run: Only this run's coordinator may do that. Nothing was archived." });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("reports a stopped run whose archive failed as exactly that", async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "orchestration_run_archive") throw new Error("disk full");
      return null;
    });
    expect(await stopRun(invoke, target, true)).toEqual({ ok: false, stopped: true,
      error: "Stopped, but could not archive: disk full The run stays in the list." });
  });
});
