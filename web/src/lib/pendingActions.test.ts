import { describe, expect, it } from "vitest";
import {
  EMPTY_ORCHESTRATION, workerChatParents, type OrchestrationAttempt, type OrchestrationGate,
  type OrchestrationRun, type OrchestrationSnapshot, type OrchestrationTask,
} from "./orchestration";
import {
  pendingActions, pendingByRow, pendingByTask, pendingDescription, pendingLabel, pendingSelector,
  type PendingActionInput,
} from "./pendingActions";
import { PendingRequests, type RequestState } from "./pendingRequests";
import type { Question } from "../components/UserQuestion";

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

  it("asks for a review of a refused action, never an approval", () => {
    // A Claude auto-mode refusal can no longer be allowed from OctiqFlow; the
    // card only lets the person choose how the agent goes on.
    const actions = pendingActions(input(ledger(), { safetyBlocks: { w1: [{ id: "s1" }] } }));
    expect(pendingLabel(actions)).toBe("Review needed");
    expect(pendingDescription(actions)).toBe("1 blocked action to review");
  });

  it("labels an outage card calmly: nothing on it needs review", () => {
    // Claude's check gave no verdict, so nothing was judged. The key is the
    // card's own `safety:` key, so the badge still finds the card.
    const outage = pendingActions(input(ledger(), { safetyBlocks: { w1: [{ id: "o1", kind: "outage" }] } }));
    expect(outage).toEqual([expect.objectContaining({ key: "safety:o1", kind: "outage", rowId: "main", taskId: "t1" })]);
    expect(pendingLabel(outage)).toBe("Safety check was down");
    expect(pendingLabel(outage)).not.toContain("Review");
    expect(pendingDescription(outage)).toBe("1 safety check outage");
    expect(pendingSelector(outage[0].key)).toBe('[data-pending-keys~="safety:o1"]');
    // A safety refusal beside it still asks for a review, and comes first.
    const both = pendingActions(input(ledger(), {
      safetyBlocks: { w1: [{ id: "o1", kind: "outage" }, { id: "s1", kind: "high-risk-action" }] },
    }));
    expect(both.map((a) => [a.key, a.kind])).toEqual([["safety:s1", "safety"], ["safety:o1", "outage"]]);
    expect(pendingLabel(both.filter((a) => a.kind === "safety"))).toBe("Review needed");
    expect(pendingDescription(both)).toBe("1 blocked action to review, 1 safety check outage");
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

  // question_store reports one status per ask_user call: "pending" until every
  // answer is in, "saved" while the answers wait to be delivered, "failed"
  // when delivery failed or could not be confirmed. Older servers send none.
  const questions = (list: object[]) => pendingActions(input(EMPTY_ORCHESTRATION, { questions: { c: list } }));

  it("does not ask again for answers that are saved and waiting to be delivered", () => {
    expect(questions([{ id: "q1", status: "saved", answer: "Yes" }])).toEqual([]);
    expect(questions([{ id: "q1", batch: "b", status: "saved" }, { id: "q2", batch: "b", status: "saved" }])).toEqual([]);
  });

  it("keeps a batch only while one of its questions still needs the person", () => {
    const mixed = questions([{ id: "q1", batch: "b", status: "saved" }, { id: "q2", batch: "b", status: "pending" }]);
    expect(mixed.map((a) => a.key)).toEqual(["question:b"]);
    expect(pendingLabel(mixed)).toBe("Answer needed");
    // Two calls in one chat: the saved one drops out, the other keeps its key.
    const two = questions([
      { id: "q1", batch: "b1", status: "saved" }, { id: "q2", batch: "b1", status: "saved" },
      { id: "q3", batch: "b2", status: "pending" }, { id: "q4", batch: "b2", status: "pending" },
    ]);
    expect(two.map((a) => a.key)).toEqual(["question:b2"]);
  });

  it("names a failed delivery as its own action, never as an unanswered question", () => {
    const failed = questions([{ id: "q1", batch: "b", status: "failed", answer: "Yes", error: "Could not continue", retryable: true }, { id: "q2", batch: "b", status: "failed", answer: "No" }]);
    expect(failed).toEqual([{ key: "delivery:b", kind: "delivery", rowId: "c", openChatId: "c", surface: "chat", runId: undefined, taskId: undefined }]);
    expect(pendingLabel(failed)).toBe("Delivery failed");
    expect(pendingDescription(failed)).toBe("1 failed answer delivery");
    // An unconfirmed delivery (not retryable) still waits on the person: the
    // card's Cancel is the only way it closes.
    expect(questions([{ id: "q9", status: "failed", retryable: false }]).map((a) => a.key)).toEqual(["delivery:q9"]);
    // Saved beside failed is the failure; unanswered beside failed is the question.
    expect(questions([{ id: "q1", batch: "b", status: "saved" }, { id: "q2", batch: "b", status: "failed" }]).map((a) => a.key)).toEqual(["delivery:b"]);
    expect(questions([{ id: "q1", batch: "b", status: "pending" }, { id: "q2", batch: "b", status: "failed" }]).map((a) => a.key)).toEqual(["question:b"]);
  });

  it("reads an older server's status-less question as unanswered", () => {
    expect(questions([{ id: "q1" }]).map((a) => a.key)).toEqual(["question:q1"]);
    expect(questions([{ id: "q1", status: "pending" }]).map((a) => a.key)).toEqual(["question:q1"]);
  });

  it("follows a question from asked to saved to delivered, and back from a reconnect", () => {
    const store = new PendingRequests<Question>();
    const at = (state: RequestState<Question>) => pendingActions(input(EMPTY_ORCHESTRATION, { questions: state })).map((a) => a.key);
    // Shaped as question_store's Asked view sends it.
    const mine = (status: Question["status"], id = "q1"): Question => ({
      id, chatKey: "chat:c", question: id === "q1" ? "Which?" : "And?", batch: "b", batchSize: 2, status,
      ...(status === "pending" ? {} : { answer: "Yes" }),
      ...(status === "failed" ? { error: "Your answers are saved. Could not continue the agent: gone", retryable: true } : {}),
    });
    // user-question, twice for a batch of two
    store.add(mine("pending"));
    expect(at(store.add(mine("pending", "q2")))).toEqual(["question:b"]);
    // question-updated once the answers are in: saved, waiting for delivery
    store.add(mine("saved"));
    expect(at(store.current)).toEqual(["question:b"]); // mid-update, q2 still pending
    expect(at(store.add(mine("saved", "q2")))).toEqual([]);
    // Reconnect: question_pending still lists the saved record, and it stays quiet.
    const token = store.begin();
    expect(at(store.finish(token, [mine("saved"), mine("saved", "q2")])!)).toEqual([]);
    // Delivery fails: now the card needs the person, under its own name.
    store.add(mine("failed"));
    expect(at(store.add(mine("failed", "q2")))).toEqual(["delivery:b"]);
    // Retry puts it back to saved; delivery removes it.
    store.add(mine("saved"));
    expect(at(store.add(mine("saved", "q2")))).toEqual([]);
    store.remove("q1");
    expect(at(store.remove("q2"))).toEqual([]);
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
