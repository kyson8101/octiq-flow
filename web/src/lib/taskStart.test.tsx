// Whether the page may start a task, and what it calls a task's state.
//
// One reader decides both (`lib/taskHold`): a control that would start an
// attempt is offered enabled only when the host would take the start, and a
// task something holds is never called by its ledger status alone. The
// ledgers are the host's own (`__fixtures__/host`).
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import panelSource from "../components/OrchestrationPanel.tsx?raw";

vi.mock("./bridge", () => ({
  bridge: { invoke: async () => null, on: () => () => {}, onState: () => () => {} },
}));

import { hostFacts } from "./__fixtures__/hostFacts";
import type { OrchestrationSnapshot } from "./orchestration";
import {
  PLAN_DETAIL, REOPEN_DETAIL, REOPEN_LABEL, startBlocker, startControl, statusLine, STOPPED_LABEL,
} from "./taskHold";
import { OrchestrationPanel } from "../components/OrchestrationPanel";

afterEach(() => vi.useRealTimers());

const panel = (snapshot: OrchestrationSnapshot) => {
  vi.useFakeTimers();
  vi.setSystemTime(Math.max(...snapshot.tasks.map((task) => task.updatedAt)) + 5_000);
  const run = snapshot.runs[0];
  return renderToStaticMarkup(<OrchestrationPanel embedded allowManualRun={false} project={{ id: run.workspaceId, name: "Project" }}
    coordinatorKey={run.coordinatorChatKey} initialSnapshot={snapshot} onOpenChat={() => {}} onClose={() => {}} />);
};
const rows = (html: string) => html.split('<article class="orch-task').slice(1).map((part) => part.slice(0, part.indexOf("</article>")));
/** Every control of a row that starts an attempt, as it is drawn. */
const starts = (row: string) => [...row.matchAll(/<button type="button" class="orch-start"[^>]*>([^<]*)<\/button>/g)].map((match) => match[0]);
const control = (snapshot: OrchestrationSnapshot, index = 0) => {
  const task = snapshot.tasks[index];
  const run = snapshot.runs.find((item) => item.id === task.runId)!;
  return startControl(task, run, snapshot.tasks, snapshot.attempts.filter((attempt) => attempt.taskId === task.id), false);
};

describe("a reopened task whose notice is not confirmed", () => {
  const held = hostFacts.heldByReopen();

  it("has a next attempt the host would refuse, and the reader says so with the host's reason", () => {
    const [task] = held.tasks;
    expect(task).toMatchObject({ status: "ready", heldByReopen: true });
    expect(held.attempts[0]).toMatchObject({ id: task.activeAttemptId, status: "completed" });
    expect(startBlocker(task, held.runs[0], held.tasks)).toBe(REOPEN_DETAIL);
    expect(control(held)).toMatchObject({ kind: "next", label: "Start next attempt", attempt: held.attempts[0], blocked: REOPEN_DETAIL });
  });

  it("is never called Ready in its details, and its ledger status is said as the ledger's beside what holds it", () => {
    const [row] = rows(panel(held));
    expect(row).not.toMatch(/>Task: Ready</);
    expect(row).not.toMatch(/>Ready(?: to start)?</);
    expect(row).toContain(`<p class="orch-task-ledger">Task: ${REOPEN_LABEL} · ledger status: Ready</p>`);
    expect(statusLine(held.tasks[0], REOPEN_LABEL)).toBe(`Task: ${REOPEN_LABEL} · ledger status: Ready`);
  });

  it("offers Start next attempt switched off, with the reason beside it", () => {
    const [row] = rows(panel(held));
    const [button, ...more] = starts(row);
    expect(more).toEqual([]);
    expect(button).toContain(">Start next attempt</button>");
    expect(button).toContain('aria-disabled="true"');
    const why = /aria-describedby="([^"]+)"/.exec(button)![1];
    expect(row).toContain(`<span id="${why}" class="orch-start-why">${REOPEN_DETAIL.replace(/'/g, "&#x27;")}</span>`);
  });

  it("offers it enabled once the notice is confirmed", () => {
    const told = hostFacts.reopenNoticeDelivered();
    expect(control(told)).toMatchObject({ kind: "next", blocked: null });
    const [button] = starts(rows(panel(told))[0]);
    expect(button).toContain(">Start next attempt</button>");
    expect(button).not.toContain("aria-disabled");
    expect(rows(panel(told))[0]).toContain('<p class="orch-task-ledger">Task: Ready</p>');
  });
});

describe("a task the plan holds", () => {
  it("has no start while it never ran: there is no attempt to retry", () => {
    const snapshot = hostFacts.planAfterFailed();
    expect(snapshot.tasks[1]).toMatchObject({ status: "ready", heldByPlan: true });
    expect(control(snapshot, 1)).toBeNull();
    expect(startBlocker(snapshot.tasks[1], snapshot.runs[0], snapshot.tasks)).toBe(PLAN_DETAIL);
  });

  it("does not hold the approved task beside it, whose retry the host starts", () => {
    for (const snapshot of [hostFacts.planAfterFailed(), hostFacts.planAfterBlocked()]) {
      expect(control(snapshot)).toMatchObject({ kind: "retry", label: "Start retry", blocked: null });
      const [button] = starts(rows(panel(snapshot))[0]);
      expect(button).toContain(">Start retry</button>");
      expect(button).not.toContain("aria-disabled");
    }
  });

  it("switches a failed task's retry off when the host says the plan holds it", () => {
    // Changed for this test: A changed hands after it failed, so its
    // approval was cleared and the host says the plan holds it.
    const snapshot = hostFacts.planAfterFailed();
    delete snapshot.tasks[0].approvedAt;
    snapshot.tasks[0].heldByPlan = true;
    expect(control(snapshot)).toMatchObject({ kind: "retry", blocked: PLAN_DETAIL });
    const [button] = starts(rows(panel(snapshot))[0]);
    expect(button).toContain('aria-disabled="true"');
  });

  it("keeps a mission's retry off while its plan is pending on a host that does not say what the plan holds", () => {
    // Changed for this test: a mission, and no task carries `heldByPlan`.
    const snapshot = hostFacts.planAfterFailed();
    snapshot.runs[0].workspaceMode = "mission";
    for (const task of snapshot.tasks) delete task.heldByPlan;
    expect(control(snapshot)).toMatchObject({ kind: "retry", blocked: PLAN_DETAIL });
    snapshot.runs[0].workspaceMode = "auto";
    expect(control(snapshot)).toMatchObject({ kind: "retry", blocked: null });
  });
});

describe("a task the person stopped", () => {
  it("has one way back, their own Start of the attempt they stopped", () => {
    const { snapshot } = hostFacts.taskStopped();
    const index = snapshot.tasks.findIndex((task) => task.stopped);
    const task = snapshot.tasks[index];
    expect(control(snapshot, index)).toMatchObject({ kind: "again", label: "Start it again", blocked: null, attempt: { id: task.stopped!.attemptId } });
    const row = rows(panel(snapshot)).find((item) => item.includes('data-hold="stopped"'))!;
    const buttons = starts(row);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toContain(">Start it again</button>");
    expect(buttons[0]).not.toContain("aria-disabled");
  });

  it("is said as stopped in its details, never as Failed alone", () => {
    const { snapshot } = hostFacts.taskStopped();
    const row = rows(panel(snapshot)).find((item) => item.includes('data-hold="stopped"'))!;
    expect(row).not.toMatch(/>Task: Failed</);
    expect(row).toContain(`<p class="orch-task-ledger">Task: ${STOPPED_LABEL} · ledger status: Failed</p>`);
  });

  it("has that Start switched off while the plan holds it or its reopen is not told", () => {
    // Changed for this test: the stopped task was put back on the plan.
    const planned = hostFacts.planAfterStopped();
    planned.tasks[0].heldByPlan = true;
    expect(control(planned)).toMatchObject({ kind: "again", blocked: PLAN_DETAIL });
    const [button] = starts(rows(panel(planned)).find((item) => item.includes(">Start it again<"))!);
    expect(button).toContain('aria-disabled="true"');
    // Changed for this test: it was reopened and the notice is not saved.
    const reopened = hostFacts.planAfterStopped();
    reopened.tasks[0].heldByReopen = true;
    expect(control(reopened)).toMatchObject({ kind: "again", blocked: REOPEN_DETAIL });
  });

  it("has no start at all in a run that takes none", () => {
    for (const status of ["stopped", "closed", "completed"] as const) {
      const snapshot = hostFacts.planAfterStopped();
      snapshot.runs[0].status = status;
      expect(control(snapshot)).toBeNull();
    }
    const archived = hostFacts.planAfterStopped();
    archived.runs[0].archivedAt = 1;
    expect(control(archived)).toBeNull();
  });
});

describe("a task that was replaced, or is parked on a decision", () => {
  it("offers its retry switched off and names what replaced it", () => {
    // Changed for this test: B replaced the failed A.
    const snapshot = hostFacts.planAfterFailed();
    snapshot.tasks[0].supersededBy = snapshot.tasks[1].id;
    expect(control(snapshot)).toMatchObject({ kind: "retry" });
    expect(control(snapshot)!.blocked).toBe('This task was replaced by "Implement" and no longer starts. Start that task instead; this one keeps its history.');
  });

  it("offers nothing while an open decision holds the blocked task", () => {
    const snapshot = hostFacts.planAfterBlocked();
    const [task] = snapshot.tasks;
    expect(startControl(task, snapshot.runs[0], snapshot.tasks, snapshot.attempts, true)).toBeNull();
  });
});

describe("the ledger's status in a task's details", () => {
  it("stands alone only when it is the task's state", () => {
    const [task] = hostFacts.reopenNoticeDelivered().tasks;
    expect(statusLine(task, "Ready")).toBe("Task: Ready");
    expect(statusLine({ status: "running" }, "Executing")).toBe("Task: Executing · ledger status: Working");
    expect(statusLine({ status: "failed" }, STOPPED_LABEL)).toBe(`Task: ${STOPPED_LABEL} · ledger status: Failed`);
  });
});

describe("every control that starts an attempt", () => {
  it("is drawn by the one component that asks the reader", () => {
    // One place sends the start, and one place calls it.
    expect(panelSource.match(/"orchestration_worker_start"/g)).toHaveLength(1);
    expect(panelSource.match(/onRetry\(/g)).toHaveLength(1);
    expect(panelSource).toMatch(/const start = startControl\(/);
    // No label of a start is written anywhere but the reader.
    expect(panelSource).not.toMatch(/>Start (retry|next attempt|it again)</);
    expect(panelSource).not.toMatch(/"Start (retry|next attempt|it again)"/);
  });
});
