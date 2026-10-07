import { describe, expect, it } from "vitest";
import { taskBoardFixture } from "./__fixtures__/agentTaskBoard";
import {
  attemptIsLive, boardCounts, currentAttempt, pendingDecision, runElapsed, shortBranch, stepCountLabel, stepLabel, taskElapsed, taskProgress,
  taskStage, taskStateLabel, taskStepSummary,
} from "./agentTaskBoard";
import type { OrchestrationAttempt, OrchestrationTask } from "./orchestration";

describe("a task row's state word (feedback ee0a43b0)", () => {
  const task = { id: "t", runId: "r", title: "Review", spec: "", dependsOn: [], status: "running", activeAttemptId: "a",
    createdAt: 1, updatedAt: 1 } as OrchestrationTask;
  const attempt = { id: "a", taskId: "t", status: "running",
    execution: { state: "waiting_tool", pendingTools: {} } } as unknown as OrchestrationAttempt;

  it("says a worker parked on an approval card is awaiting approval, with the card pending", () => {
    expect(taskStateLabel(task, attempt, [{ attemptId: "a", status: "pending" }])).toBe("Awaiting approval");
    expect(taskStateLabel(task, attempt, [{ attemptId: "a", status: "dismissed" }])).toBe("Waiting for a tool");
    expect(taskStateLabel(task, attempt, [])).toBe("Waiting for a tool");
  });

  it("says a replaced task was replaced, keeping how it ended (feedback 6b0870f9)", () => {
    const replaced = { ...task, status: "blocked", supersededBy: "t2" } as OrchestrationTask;
    expect(taskStateLabel(replaced, { ...attempt, status: "blocked" } as OrchestrationAttempt)).toBe("Blocked · replaced");
  });

  it("never calls a finished check that failed plain Done", () => {
    const done = { ...task, status: "completed", activeAttemptId: undefined } as OrchestrationTask;
    expect(taskStateLabel(done, undefined)).toBe("Done");
    expect(taskStateLabel({ ...done, verdict: "fail" }, undefined)).toBe("Done · check failed");
    expect(taskStateLabel({ ...done, verdict: "pass" }, undefined)).toBe("Done");
  });

  it("says what a check found, and never lets a check without a verdict read as done", () => {
    const done = { ...task, status: "completed", activeAttemptId: undefined, kind: "review" } as OrchestrationTask;
    expect(taskStateLabel({ ...done, verdict: "pass" }, undefined)).toBe("Done · passed");
    expect(taskStateLabel({ ...done, verdict: "fail" }, undefined)).toBe("Done · check failed");
    expect(taskStateLabel(done, undefined)).toBe("Done · no verdict");
    // Ordinary work with no kind keeps its plain word: nothing is invented.
    expect(taskStateLabel({ ...done, kind: undefined }, undefined)).toBe("Done");
    // With its worker's execution evidence too, as a real settled task has.
    const settled = { ...attempt, status: "completed", execution: { state: "completed", pendingTools: {} } } as unknown as OrchestrationAttempt;
    const withAttempt = { ...done, activeAttemptId: "a" };
    expect(taskStateLabel({ ...withAttempt, verdict: "pass" }, settled)).toBe("Done · passed");
    expect(taskStateLabel({ ...withAttempt, kind: undefined, verdict: "fail" }, settled)).toBe("Done · check failed");
    expect(taskStateLabel({ ...withAttempt, kind: undefined }, settled)).toBe("Completed");
  });

  it("says the host is preparing, or queueing for, the task's environment rather than a tool", () => {
    const on = (label: string) => ({ ...attempt, execution: { state: "waiting_tool", pendingTools: { "octiq:environment": label } } }) as unknown as OrchestrationAttempt;
    expect(taskStateLabel(task, on("Preparing test environment"))).toBe("Preparing environment");
    expect(taskStateLabel(task, on("Waiting for environment capacity: 3 of 3 in use, position 1 in line"))).toBe("Waiting for an environment slot");
  });

  it("names the native decision only when one was observed", () => {
    const decisions = [{ attemptId: "a", status: "pending", id: "nd_1" }, { attemptId: "b", status: "pending", id: "nd_2" }];
    expect(pendingDecision(attempt, decisions)?.id).toBe("nd_1");
    expect(pendingDecision(attempt, [])).toBeUndefined();
    expect(pendingDecision(attempt, [{ attemptId: "a", status: "dismissed", id: "x" }])).toBeUndefined();
  });
});

describe("agent task progress", () => {
  it("counts assignments once, including unstarted and blocked work", () => {
    expect(boardCounts(taskBoardFixture().tasks)).toEqual({ done: 1, total: 4, percent: 25, todo: 1, running: 1, blocked: 1, cancelled: 0 });
  });
  it("uses reported steps, with no estimated percentage when the plan is absent", () => {
    const snapshot = taskBoardFixture();
    const task = snapshot.tasks[1];
    expect(taskProgress(task).percent).toBeNull();
    expect(taskProgress(task, snapshot.reports!["chat:w-reader"])).toEqual({ total: 4, done: 2, remaining: 2, percent: 50 });
    expect(taskStage(task, snapshot.reports!["chat:w-reader"])).toBe("Run focused tests");
    expect(taskProgress(snapshot.tasks[0]).percent).toBe(100);
    expect(taskProgress(snapshot.tasks[3]).percent).toBe(0);
    expect(taskStage(snapshot.tasks[0], snapshot.reports!["chat:w-reader"])).toBe("Done");
  });
  it("keeps cancellation out of successful completion", () => {
    const snapshot = taskBoardFixture();
    snapshot.tasks[3].status = "cancelled";
    expect(boardCounts(snapshot.tasks)).toMatchObject({ done: 1, percent: 25, todo: 0, cancelled: 1 });
  });
});

describe("a task row's reported steps", () => {
  const board = () => {
    const snapshot = taskBoardFixture();
    const task = snapshot.tasks[1];
    const attempt = snapshot.attempts[1];
    const report = snapshot.reports!["chat:w-reader"];
    return { snapshot, task, attempt, report };
  };

  it("counts the steps as reported and names the one the running worker is on", () => {
    const { task, attempt, report } = board();
    const summary = taskStepSummary(task, attempt, report)!;
    expect(summary).toEqual({ done: 2, total: 4, step: "Run focused tests", current: true });
    expect(stepCountLabel(summary)).toBe("2/4 steps");
    expect(stepLabel(summary)).toBe("Run focused tests");
    // Host execution never takes the step's place: it is the row's first word.
    const waiting = { ...attempt, execution: { state: "waiting_tool", retryCount: 0, pendingTools: {} } } as OrchestrationAttempt;
    expect(stepLabel(taskStepSummary(task, waiting, report)!)).toBe("Run focused tests");
  });

  it("keeps a stopped task's count and calls its step the last one, never the current one", () => {
    const { task, attempt, report } = board();
    for (const status of ["blocked", "failed", "cancelled"] as const) {
      const summary = taskStepSummary({ ...task, status }, { ...attempt, status: status === "cancelled" ? "cancelled" : status }, report)!;
      expect(summary).toMatchObject({ done: 2, total: 4, current: false });
      expect(stepLabel(summary)).toBe("Last step: Run focused tests");
    }
    // A running task whose shown attempt is not its authoritative one.
    expect(taskStepSummary({ ...task, activeAttemptId: "other" }, attempt, report)!.current).toBe(false);
  });

  it("never lets completion stand in for reported steps", () => {
    const { task, attempt, report } = board();
    const done = { ...task, status: "completed" } as OrchestrationTask;
    expect(taskProgress(done, report).percent).toBe(100);
    const summary = taskStepSummary(done, { ...attempt, status: "completed" }, report)!;
    expect(stepCountLabel(summary)).toBe("2/4 steps");
    expect(stepLabel(summary)).toBe("Last step: Run focused tests");
    expect(taskStepSummary({ ...done, verdict: "fail" }, { ...attempt, status: "completed" }, report)!.done).toBe(2);
  });

  it("says nothing without a checklist, and nothing for a report older than the attempt", () => {
    const { task, attempt, report } = board();
    expect(taskStepSummary(task, attempt, undefined)).toBeNull();
    expect(taskStepSummary(task, attempt, { ...report, steps: [] })).toBeNull();
    expect(taskStepSummary(task, undefined, report)).toBeNull();
    expect(taskStepSummary(task, { ...attempt, createdAt: report.reportedAt + 1 }, report)).toBeNull();
  });

  it("offers no pending step as the current one, takes the first active, and skips a blank title", () => {
    const { task, attempt, report } = board();
    const steps = (states: [string, "done" | "active" | "pending"][]) => ({ ...report, steps: states.map(([title, state]) => ({ title, state })) });
    const noActive = taskStepSummary(task, attempt, steps([["One", "done"], ["Two", "pending"]]))!;
    expect(noActive).toMatchObject({ done: 1, total: 2, step: null });
    expect(stepLabel(noActive)).toBeNull();
    expect(taskStepSummary(task, attempt, steps([["First", "active"], ["Second", "active"]]))!.step).toBe("First");
    expect(stepLabel(taskStepSummary(task, attempt, steps([["  ", "active"], ["Next", "pending"]]))!)).toBeNull();
    expect(stepCountLabel(taskStepSummary(task, attempt, steps([["Only", "active"]]))!)).toBe("0/1 step");
  });
});

describe("branch names in a one-line row", () => {
  it("drops the run id a prepared worktree carries, and keeps a name someone chose", () => {
    expect(shortBranch("feature/octiq-cc2541144f174ad492ba768b5b5671c1")).toBe("octiq-cc25…");
    expect(shortBranch("develop")).toBe("develop");
    expect(shortBranch("feature/excel-import")).toBe("excel-import");
    expect(shortBranch("release/2026-09-excel-import-and-payroll-fixes")).toBe("2026-09-excel-import-an…");
    expect(shortBranch("")).toBe("");
  });
});

describe("agent elapsed time", () => {
  it("stops settled timers, while decision waits continue", () => {
    const snapshot = taskBoardFixture();
    expect(taskElapsed(snapshot, snapshot.tasks[0], 2_000_000)).toBe(480_000);
    expect(taskElapsed(snapshot, snapshot.tasks[2], 1_000_000)).toBe(420_000);
    snapshot.gates = [];
    expect(attemptIsLive(snapshot, snapshot.attempts[2])).toBe(false);
    expect(taskElapsed(snapshot, snapshot.tasks[2], 2_000_000)).toBe(240_000);
    expect(taskElapsed(snapshot, snapshot.tasks[3], 2_000_000)).toBeNull();
  });
  it("counts concurrent wall time once and freezes at the last settlement", () => {
    const snapshot = taskBoardFixture();
    expect(runElapsed(snapshot, "run", 1_000_000)).toBe(600_000);
    snapshot.attempts[1].status = "completed";
    snapshot.gates = [];
    expect(runElapsed(snapshot, "run", 2_000_000)).toBe(540_000);
    expect(runElapsed(snapshot, "empty", 2_000_000)).toBeNull();
  });
  it("does not add archival or later metadata updates to completed runtime", () => {
    const snapshot = taskBoardFixture();
    snapshot.attempts[0].finishedAt = snapshot.attempts[0].updatedAt;
    snapshot.attempts[0].updatedAt = 9_000_000;
    expect(taskElapsed(snapshot, snapshot.tasks[0], 10_000_000)).toBe(480_000);
  });
  it("uses the authoritative attempt and sums retry time without the idle gap", () => {
    const snapshot = taskBoardFixture();
    const task = snapshot.tasks[1];
    snapshot.attempts[1].status = "failed";
    snapshot.attempts.push({ ...snapshot.attempts[1], id: "retry", number: 2, workerChatKey: "chat:retry", createdAt: 980_000, updatedAt: 990_000, status: "running" });
    task.activeAttemptId = "retry";
    expect(currentAttempt(snapshot, task)?.id).toBe("retry");
    expect(taskElapsed(snapshot, task, 1_000_000)).toBe(320_000);
    expect(snapshot.reports![currentAttempt(snapshot, task)!.workerChatKey]).toBeUndefined();
  });
});
