import { expect, it } from "vitest";
import { taskSlot, queuedStart } from "./taskSlot";
import { taskHold } from "./taskHold";
import { runProgress } from "./runProgress";
import { NO_WAITS, runWaits } from "./runWaits";
import { taskState } from "./agentsDashboard";
import { finishedWell, failureShown, type OrchestrationRun, type OrchestrationSnapshot, type OrchestrationTask } from "./orchestration";
const run: OrchestrationRun = { id: "r", objective: "Schedule safely", coordinatorChatKey: "chat:c", workspaceId: "p", rootPath: "/repo", status: "running", maxConcurrent: 3, createdAt: 1, updatedAt: 1 };
const task: OrchestrationTask = { id: "t", runId: "r", title: "Queued task", spec: "", status: "ready", dependsOn: [], createdAt: 1, updatedAt: 1,
  assignee: { id: "fe", name: "OCTIQ FE" }, slotWait: { reason: "agent", agentId: "fe", ahead: 2 } };
it("names agent, ahead, host and an absent slot wait", () => {
  expect(taskSlot(task)).toBe("Queued · OCTIQ FE is busy · 2 ahead");
  expect(taskSlot({ slotWait: { reason: "host", ahead: 0, running: 4, limit: 4 } })).toBe("Queued · machine limit (4 of 4 running)");
  expect(taskSlot({})).toBeNull();
});
it("lets plan, reopen and stopped holds lead", () => {
  for (const patch of [{ heldByPlan: true }, { heldByReopen: true }, { stopped: { attemptId: "a", at: 1 } }]) {
    const held = { ...task, ...patch };
    const hold = taskHold(held, run, [held], 1);
    expect(hold).not.toBeNull(); expect(taskSlot(held, hold)).toBe(hold!.label);
  }
});
it("keeps a queued task Planned and neutral across waits, completion and Agents", () => {
  const snapshot: OrchestrationSnapshot = { runs: [run], tasks: [task], attempts: [], gates: [], messages: [] };
  const waits = runWaits(snapshot, run);
  expect(waits.person).toEqual([]);
  expect(finishedWell(task)).toBe(false); expect(failureShown(task)).toBeNull();
  expect(runProgress(snapshot, run, 1).rows[0]).toMatchObject({ state: "planned", group: "planned", tone: null, decisions: 0, why: taskSlot(task), flight: false });
  expect(runProgress({ ...snapshot, tasks: [{ ...task, retrying: true }] }, run, 1).rows[0]).toMatchObject({ state: "planned", tone: null, decisions: 0, why: taskSlot(task) });
  expect(taskState(task, run, undefined, waits.tasks.get(task.id) ?? NO_WAITS, null)).toMatchObject({ state: "queued", label: taskSlot(task) });
});
it("recognises successful queued replies and QUEUED_FOR_SLOT errors", () => {
  expect(queuedStart({ queued: true })).toMatch(/^Queued/);
  expect(queuedStart(new Error("QUEUED_FOR_SLOT: machine limit (4 of 4 running)"))).toBe("Queued · machine limit (4 of 4 running)");
  expect(queuedStart(new Error("Profile unavailable"))).toBeNull();
});
