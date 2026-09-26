import { describe, expect, it } from "vitest";
import {
  EMPTY_ORCHESTRATION, workerChatParents, type OrchestrationAttempt, type OrchestrationGate,
  type OrchestrationRun, type OrchestrationSnapshot, type OrchestrationTask,
} from "./orchestration";
import {
  pendingActions, pendingByRow, pendingByTask, pendingDescription, pendingLabel, pendingSelector,
  type PendingActionInput,
} from "./pendingActions";

const run = (id: string, over: Partial<OrchestrationRun> = {}): OrchestrationRun => ({
  id, objective: id, coordinatorChatKey: "chat:main", workspaceId: "p", rootPath: "/r",
  status: "running", maxConcurrent: 2, createdAt: 1, updatedAt: 1, ...over,
});
const task = (id: string, runId: string, over: Partial<OrchestrationTask> = {}): OrchestrationTask => ({
  id, runId, title: id, spec: "", dependsOn: [], status: "running", createdAt: 1, updatedAt: 1, ...over,
});
const attempt = (id: string, runId: string, taskId: string, chat: string, number = 1): OrchestrationAttempt => ({
  id, runId, taskId, number, workerChatKey: `chat:${chat}`, agent: "claude", access: "auto", status: "running",
  cwd: "/r", branch: "b", isWorktree: true, filesModified: [], createdAt: number, updatedAt: number,
});
const gate = (id: string, runId: string, over: Partial<OrchestrationGate> = {}): OrchestrationGate => ({
  id, runId, createdByChatKey: "chat:w1", targetChatKey: "chat:main", question: "Which?", options: [],
  status: "open", createdAt: 1, updatedAt: 1, ...over,
});

/** A main chat with two runs: r1 still running with worker w1, r2 older and
 *  finished, whose worker w2 is still parked on a card. */
function ledger(over: Partial<OrchestrationSnapshot> = {}): OrchestrationSnapshot {
  return {
    ...EMPTY_ORCHESTRATION,
    runs: [run("r1"), run("r2", { status: "completed" })],
    tasks: [task("t1", "r1"), task("t2", "r2", { status: "completed" })],
    attempts: [attempt("a1", "r1", "t1", "w1"), attempt("a2", "r2", "t2", "w2")],
    ...over,
  };
}
function input(orchestration = ledger(), over: Partial<PendingActionInput> = {}): PendingActionInput {
  return { orchestration, parents: workerChatParents(orchestration), ...over };
}

describe("pending actions", () => {
  it("rolls a worker's card up to the main chat row while keeping its task", () => {
    const actions = pendingActions(input(ledger(), { asks: { w1: [{ id: "p1" }] } }));
    expect(actions).toEqual([{
      key: "permission:p1", kind: "permission", rowId: "main", openChatId: "main", surface: "chat", runId: "r1", taskId: "t1",
    }]);
    expect(pendingByTask(actions).get("t1")?.map((a) => a.key)).toEqual(["permission:p1"]);
  });

  it("counts every run of the main chat, including one that is no longer active", () => {
    const actions = pendingActions(input(ledger({ gates: [gate("g1", "r1", { taskId: "t1" })] }), {
      asks: { w2: [{ id: "p2" }] }, safetyBlocks: { main: [{ id: "s1" }] },
    }));
    const row = pendingByRow(actions).get("main") ?? [];
    expect(row.map((a) => a.key)).toEqual(["permission:p2", "safety:s1", "gate:g1"]);
    expect(pendingLabel(row)).toBe("Action needed · 3");
    expect(pendingDescription(row)).toBe("1 permission request, 1 blocked action to review, 1 decision");
    // The finished run's worker keeps its own task for the task row.
    expect(actions[0]).toMatchObject({ runId: "r2", taskId: "t2", openChatId: "main" });
    expect(actions.find((a) => a.kind === "gate")).toMatchObject({ surface: "run", openChatId: "main", taskId: "t1" });
  });

  it("counts an action once even when it reaches the list twice", () => {
    const actions = pendingActions(input(ledger({ gates: [gate("g1", "r1"), gate("g1", "r1")] }), {
      asks: { w1: [{ id: "p1" }, { id: "p1" }] },
    }));
    expect(actions.map((a) => a.key)).toEqual(["permission:p1", "gate:g1"]);
  });

  it("treats a question batch as one card that stays while any question in it is unanswered", () => {
    const three = [{ id: "q1", batch: "b" }, { id: "q2", batch: "b" }, { id: "q3", batch: "b" }];
    expect(pendingActions(input(EMPTY_ORCHESTRATION, { questions: { c: three } })).map((a) => a.key)).toEqual(["question:b"]);
    const oneLeft = pendingActions(input(EMPTY_ORCHESTRATION, { questions: { c: [three[2]] } }));
    expect(oneLeft).toMatchObject([{ key: "question:b", rowId: "c", openChatId: "c" }]);
    expect(pendingLabel(oneLeft)).toBe("Answer needed");
    // A lone question is its own card.
    expect(pendingActions(input(EMPTY_ORCHESTRATION, { questions: { c: [{ id: "q9" }] } }))[0].key).toBe("question:q9");
  });

  it("leaves out a worker's question, which no screen draws a card for", () => {
    expect(pendingActions(input(ledger(), { questions: { w1: [{ id: "q1" }] } }))).toEqual([]);
    expect(pendingActions(input(ledger(), { questions: { main: [{ id: "q2" }] } })).map((a) => a.key)).toEqual(["question:q2"]);
  });

  it("clears a settled request, gate or plan", () => {
    expect(pendingActions(input(ledger(), { asks: { w1: [] }, questions: {} }))).toEqual([]);
    for (const status of ["resolved", "cancelled"] as const) {
      expect(pendingActions(input(ledger({ gates: [gate("g1", "r1", { status })] })))).toEqual([]);
    }
    const approved = ledger({ runs: [run("r1", { planApproval: { status: "approved", requestedAt: 1, revision: 2 } })] });
    expect(pendingActions(input(approved))).toEqual([]);
  });

  it("keys a plan by revision, so a revision after approval is a new action", () => {
    const pending = (revision: number) => pendingActions(input(ledger({
      runs: [run("r1", { planApproval: { status: "pending", requestedAt: 1, revision } })],
    })));
    expect(pending(2)).toEqual([{ key: "plan:r1:2", kind: "plan", rowId: "main", openChatId: "main", surface: "chat", runId: "r1" }]);
    expect(pending(3)[0].key).toBe("plan:r1:3");
    expect(pendingLabel(pending(3))).toBe("Plan approval");
  });

  it("does not ask for a plan that cannot be approved", () => {
    const planned = (over: Partial<OrchestrationRun>, tasks = [task("t1", "r1", { status: "pending" })]) => pendingActions(input(ledger({
      runs: [run("r1", { planApproval: { status: "pending", requestedAt: 1, revision: 1 }, ...over })], tasks,
    })));
    expect(planned({})).toHaveLength(1);
    expect(planned({}, [])).toEqual([]); // still being written
    expect(planned({}, [task("t1", "r1", { status: "cancelled" })])).toEqual([]); // withdrawn
    expect(planned({ status: "stopped" })).toEqual([]);
    expect(planned({ status: "completed", archivedAt: 5 })).toEqual([]);
  });

  it("ignores gates of an archived run and records with no identity", () => {
    const archived = ledger({ runs: [run("r1", { status: "completed", archivedAt: 9 })], gates: [gate("g1", "r1")] });
    expect(pendingActions(input(archived))).toEqual([]);
    expect(pendingActions(input(ledger(), { asks: { w1: [{}] } }))).toEqual([]);
  });

  it("never reads execution states as the person's action", () => {
    const capacity = ledger();
    capacity.attempts[0] = { ...capacity.attempts[0], execution: { state: "capacity_blocked", retryCount: 1 } };
    capacity.tasks[0] = { ...capacity.tasks[0], status: "blocked" };
    expect(pendingActions(input(capacity))).toEqual([]);
  });

  it("names a retried worker's newest task", () => {
    const retried = ledger({
      tasks: [task("t1", "r1"), task("t3", "r1")],
      attempts: [attempt("a1", "r1", "t1", "w1", 1), attempt("a3", "r1", "t3", "w1", 2)],
    });
    expect(pendingActions(input(retried, { asks: { w1: [{ id: "p" }] } }))[0].taskId).toBe("t3");
  });

  it("finds a card by any of the keys it carries", () => {
    expect(pendingSelector("question:b")).toBe('[data-pending-keys~="question:b"]');
    expect(pendingSelector('odd"key')).toBe('[data-pending-keys~="odd\\"key"]');
  });
});
