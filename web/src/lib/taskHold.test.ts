import { beforeEach, describe, expect, it } from "vitest";
import {
  forgetHolds, PLAN_LABEL, REOPEN_DETAIL, REOPEN_LABEL, REOPEN_LASTED_DETAIL, REOPEN_LASTED_LABEL, REOPEN_LASTED_MS, reopenOwedSince,
  seeHolds, stopBlocker, STOPPED_DETAIL, STOPPED_LABEL, taskHold,
} from "./taskHold";
import type { OrchestrationTask } from "./orchestration";
import host from "../../../src-tauri/src/orchestration/workspaces.rs?raw";
import ledger from "../../../src-tauri/src/orchestration.rs?raw";

const AT = 1_791_700_000_000;

// Each test is a page that has seen no hold yet.
beforeEach(() => forgetHolds());

const task = (over: Partial<OrchestrationTask> = {}): OrchestrationTask => ({
  id: "task_1", runId: "run_1", title: "Implement", spec: "", dependsOn: [], status: "ready", createdAt: AT, updatedAt: AT, ...over,
});
const reopen = (over: Partial<NonNullable<OrchestrationTask["reopens"]>[number]> = {}) => ({
  byChatKey: "chat:master", at: AT, attempt: 2, previousSpec: "Make the requested change", spec: "Address review", noticeDelivered: false, ...over,
});
const hold = (over: Partial<OrchestrationTask>, now = AT, plan?: "pending" | "approved") =>
  taskHold(task(over), plan ? { planApproval: { status: plan, requestedAt: AT } } : {}, [task(over)], now);

describe("what holds a task that has not started", () => {
  it("is nothing for a task that is free to start, running, settled or replaced", () => {
    expect(hold({})).toBeNull();
    expect(hold({ status: "pending" })).toBeNull();
    for (const status of ["running", "blocked", "completed", "cancelled", "failed"] as const) {
      expect(hold({ status, heldByReopen: true, heldByPlan: true })).toBeNull();
    }
    expect(hold({ supersededBy: "task_2", heldByReopen: true })).toBeNull();
    expect(hold({ status: "failed", supersededBy: "task_2", stopped: { at: AT, attemptId: "attempt_1" } })).toBeNull();
    // Only `true` is the host's word: the key is left out otherwise.
    expect(hold({ heldByReopen: false })).toBeNull();
  });

  it("says a reopened task whose notice is not confirmed is exactly that, and never ready", () => {
    const held = hold({ heldByReopen: true, reopens: [reopen()] });
    expect(held).toEqual({ kind: "reopen", label: REOPEN_LABEL, detail: REOPEN_DETAIL, tone: null });
    expect(REOPEN_LABEL).toBe("Reopened · notice not yet saved");
    expect(held!.label).not.toMatch(/ready/i);
  });

  it("uses the words of the host's own refusal", () => {
    // `REOPEN_NOT_TOLD` and `STOPPED_BY_PERSON`, as the host refuses a start.
    expect(host).toContain("This task was reopened with new instructions, and the notice of that in the coordinator's chat has not been confirmed as saved to disk yet, so it does not start");
    expect(REOPEN_DETAIL.startsWith("This task was reopened with new instructions, and the notice of that in the coordinator's chat has not been confirmed as saved to disk yet, so it does not start.")).toBe(true);
    expect(host).toContain("The notice may already be on screen in that chat.");
    expect(REOPEN_DETAIL).toContain("The notice may already be on screen in that chat.");
    expect(host).toContain("the coordinator's chat was deleted or its transcript cannot be written or synced to disk");
    expect(REOPEN_LASTED_DETAIL).toContain("its transcript cannot be written or synced to disk");
    expect(ledger).toContain("The person stopped this task's worker, so only they start it again: Start on its row in the run panel, or their approval of a plan it is put back on.");
    expect(STOPPED_DETAIL).toBe("You stopped this task's worker, so only you start it again: Start on its row, or your approval of a plan it is put back on.");
  });

  it("takes the warning colour only once the hold has lasted past the host's back-off", () => {
    // 4 + 8 + 16 + 32 seconds of asking again, then once a minute.
    expect(REOPEN_LASTED_MS).toBe(60_000);
    const held = { heldByReopen: true, reopens: [reopen()] };
    // The minute is counted from when the page first saw the hold, on the
    // page's own clock (`taskHold.clock.test` asks what two clocks did).
    seeHolds([task(held)], AT);
    expect(hold(held, AT + 2_000)!.tone).toBeNull();
    expect(hold(held, AT + REOPEN_LASTED_MS - 1)!.tone).toBeNull();
    const lasted = hold(held, AT + REOPEN_LASTED_MS)!;
    expect(lasted).toMatchObject({ kind: "reopen", label: REOPEN_LASTED_LABEL, tone: "warn" });
    expect(lasted.detail).toBe(`${REOPEN_DETAIL} ${REOPEN_LASTED_DETAIL}`);
    // A reader's clock behind the page's first sight never warns early.
    expect(hold(held, AT - 5_000)!.tone).toBeNull();
  });

  it("keys a hold by the oldest reopen still owed its notice, so a later reopen is a new hold", () => {
    const reopens = [reopen({ at: AT - 600_000, noticeDelivered: true }), reopen({ at: AT, attempt: 3 }), reopen({ at: AT + 30_000, attempt: 3 })];
    expect(reopenOwedSince({ reopens })).toBe(AT);
    seeHolds([task({ heldByReopen: true, reopens })], AT);
    expect(hold({ heldByReopen: true, reopens }, AT + 59_000)!.tone).toBeNull();
    expect(hold({ heldByReopen: true, reopens }, AT + 61_000)!.tone).toBe("warn");
    // The first of them is confirmed: what is owed now is a later reopen,
    // which this page has not seen yet.
    const later = [reopen({ at: AT, attempt: 3, noticeDelivered: true }), reopen({ at: AT + 30_000, attempt: 3 })];
    expect(hold({ heldByReopen: true, reopens: later }, AT + 61_000)!.tone).toBeNull();
    // A record that does not say reads as not delivered, as the host reads it.
    expect(reopenOwedSince({ reopens: [reopen({ noticeDelivered: undefined })] })).toBe(AT);
    expect(reopenOwedSince({ reopens: [reopen({ noticeDelivered: true })] })).toBeNull();
    expect(reopenOwedSince({})).toBeNull();
    // Held, and the ledger names no reopen: said, and it lasts like any
    // other hold once the page has seen it for the minute.
    expect(hold({ heldByReopen: true }, AT + 3_600_000)).toMatchObject({ kind: "reopen", label: REOPEN_LABEL, tone: null });
    seeHolds([task({ heldByReopen: true })], AT);
    expect(hold({ heldByReopen: true }, AT + REOPEN_LASTED_MS)).toMatchObject({ kind: "reopen", label: REOPEN_LASTED_LABEL, tone: "warn" });
  });

  it("says a task the person stopped is held until they start it, with their reason", () => {
    const stopped = { at: AT, attemptId: "attempt_1" };
    expect(hold({ status: "failed", stopped })).toEqual({ kind: "stopped", label: STOPPED_LABEL, detail: STOPPED_DETAIL, tone: null });
    expect(hold({ status: "failed", stopped: { ...stopped, reason: " Not these instructions " } })!.detail)
      .toBe(`${STOPPED_DETAIL} Your reason: Not these instructions`);
    // A task that failed on its own is not held by anything.
    expect(hold({ status: "failed" })).toBeNull();
  });

  it("gives a stopped task put back on a plan to the plan, whose approval releases it", () => {
    const stopped = { at: AT, attemptId: "attempt_1" };
    expect(hold({ status: "pending", stopped, heldByPlan: true }, AT, "pending")).toMatchObject({ kind: "plan", label: PLAN_LABEL });
    expect(hold({ status: "ready", stopped, heldByPlan: false }, AT, "pending")).toMatchObject({ kind: "stopped" });
  });

  it("says the plan holds a task only while the host says so, and before a reopen", () => {
    expect(hold({ heldByPlan: true }, AT, "pending")).toMatchObject({ kind: "plan", label: PLAN_LABEL, tone: null });
    expect(hold({ heldByPlan: false }, AT, "pending")).toBeNull();
    // A host that does not say: the run's own approval, as before.
    expect(hold({}, AT, "pending")).toMatchObject({ kind: "plan" });
    expect(hold({}, AT, "approved")).toBeNull();
    // Both: the plan is the one the person can do something about.
    expect(hold({ heldByPlan: true, heldByReopen: true, reopens: [reopen()] }, AT + 120_000, "pending")).toMatchObject({ kind: "plan", tone: null });
  });
});

describe("whether the person's Stop has anything to stop", () => {
  const running = { id: "attempt_1", status: "running" };
  it("is free while the task's own attempt is unsettled, as the host reads it", () => {
    expect(ledger).toContain("AttemptStatus::Preparing | AttemptStatus::Running");
    expect(stopBlocker(task({ status: "running", activeAttemptId: "attempt_1" }), running, false)).toBeNull();
    expect(stopBlocker(task({ status: "running", activeAttemptId: "attempt_1" }), { id: "attempt_1", status: "preparing" }, false)).toBeNull();
    // Blocked is unsettled only while an open gate holds it.
    expect(stopBlocker(task({ status: "blocked", activeAttemptId: "attempt_1" }), { id: "attempt_1", status: "blocked" }, true)).toBeNull();
    expect(stopBlocker(task({ status: "blocked", activeAttemptId: "attempt_1" }), { id: "attempt_1", status: "blocked" }, false))
      .toBe("No worker is running on this task yet, so there is nothing to stop.");
  });

  it("says why there is nothing to stop", () => {
    expect(ledger).toContain("No worker is running on this task, so there is nothing to stop.");
    expect(stopBlocker(task(), undefined, false)).toBe("No worker is running on this task yet, so there is nothing to stop.");
    // An attempt that is not the task's own is not the one a stop would end.
    expect(stopBlocker(task({ status: "running", activeAttemptId: "attempt_2" }), running, false)).toMatch(/nothing to stop/);
    expect(stopBlocker(task({ status: "completed" }), { id: "attempt_1", status: "completed" }, false))
      .toBe("This task has finished. No worker is running on it, so there is nothing to stop.");
    expect(stopBlocker(task({ status: "cancelled" }), undefined, false)).toMatch(/was cancelled/);
    expect(stopBlocker(task({ status: "failed", stopped: { at: AT, attemptId: "attempt_1" } }), { id: "attempt_1", status: "cancelled" }, false))
      .toBe("You stopped this task's worker. Only your Start starts it again.");
    expect(stopBlocker(undefined, undefined, false)).toBe("This task is no longer on the run.");
  });
});
