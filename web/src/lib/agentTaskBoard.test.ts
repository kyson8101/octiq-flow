import { describe, expect, it } from "vitest";
import { taskBoardFixture } from "./__fixtures__/agentTaskBoard";
import { attemptIsLive, boardCounts, currentAttempt, runElapsed, shortBranch, taskElapsed, taskProgress, taskStage } from "./agentTaskBoard";

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
