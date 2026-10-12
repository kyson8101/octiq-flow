// A reopened task whose notice is not confirmed, on every surface.
//
// The ledger is the host's own (`__fixtures__/host/held_by_reopen.json`):
// the task is `ready`, a start of it is refused, and `heldByReopen` is true.
// Each surface that names a task's state is asked what it says, and each
// surface that counts what waits on the person is asked that it counts
// nothing: nobody can answer this hold.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("./bridge", () => ({
  bridge: { invoke: async () => null, on: () => () => {}, onState: () => () => {} },
}));

import { agentRoster, workingTaskCount } from "./agentsDashboard";
import type { TeamAgent } from "./agentsMode";
import { chatRunStatus, chatSnapshot, rowRun } from "./chatWorkflow";
import { hostFacts } from "./__fixtures__/hostFacts";
import { workerChatParents, type OrchestrationSnapshot } from "./orchestration";
import { pendingReading } from "./pendingActions";
import { taskColumnCounts } from "./runPanel";
import { chatStrip, runProgress } from "./runProgress";
import { forgetHolds, REOPEN_DETAIL, REOPEN_LABEL, REOPEN_LASTED_DETAIL, REOPEN_LASTED_LABEL, REOPEN_LASTED_MS, seeHolds } from "./taskHold";
import { OrchestrationPanel } from "../components/OrchestrationPanel";

const held = hostFacts.heldByReopen();
const REOPENED_AT = held.tasks[0].reopens![0].at;
const SOON = REOPENED_AT + 2_000;
const LATER = REOPENED_AT + REOPEN_LASTED_MS + 1_000;

// The page saw the hold as it was made: the minute is counted from the
// page's first sight of it, on the page's own clock, and a surface drawn
// later does not start it over (`taskHold.clock.test`).
beforeEach(() => {
  forgetHolds();
  seeHolds(held.tasks, REOPENED_AT);
});
afterEach(() => vi.useRealTimers());

const panel = (snapshot: OrchestrationSnapshot, now: number) => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const run = snapshot.runs[0];
  return renderToStaticMarkup(<OrchestrationPanel embedded allowManualRun={false} project={{ id: run.workspaceId, name: "Project" }}
    coordinatorKey={run.coordinatorChatKey} initialSnapshot={snapshot} onOpenChat={() => {}} onClose={() => {}} />);
};
const row = (html: string) => html.slice(html.indexOf('<article class="orch-task'), html.indexOf("</article>"));

describe("the host's own ledger for it", () => {
  it("is a ready task the host holds, and says so with one key", () => {
    const [task] = held.tasks;
    expect(task).toMatchObject({ status: "ready", heldByReopen: true });
    expect(task.reopens).toEqual([expect.objectContaining({ attempt: 2, noticeDelivered: false, spec: "Entirely new instructions" })]);
    // No plan on this run: the key that says the plan holds a task is absent.
    expect(held.runs[0].planApproval).toBeUndefined();
    expect("heldByPlan" in task).toBe(false);
    // Once the notice is confirmed the key is left out, never `false`.
    const told = hostFacts.reopenNoticeDelivered().tasks[0];
    expect("heldByReopen" in told).toBe(false);
    expect(told.reopens![0].noticeDelivered).toBe(true);
  });
});

describe("the run panel's row", () => {
  it("says the task was reopened and its notice is not saved yet, never that it is ready", () => {
    const progress = runProgress(held, held.runs[0], SOON);
    const [planned] = progress.rows;
    expect(planned).toMatchObject({ state: "planned", group: "planned", why: REOPEN_LABEL, tone: null, decisions: 0 });
    expect(planned.hold).toMatchObject({ kind: "reopen", detail: REOPEN_DETAIL });
    const html = row(panel(held, SOON));
    expect(html).toContain(`>${REOPEN_LABEL}</span>`);
    // Said once on the row: the opened detail goes straight to the reason.
    expect(html.match(/>Reopened · notice not yet saved</g)).toHaveLength(1);
    expect(html).not.toContain('class="orch-task-state"');
    expect(html).not.toMatch(/>Ready(?: to start)?</);
    // The mark is "Held", not "Planned", and the tooltip gives the host's reason.
    expect(html).toContain('<span class="run-row-mark" role="img" aria-label="Held" title="Held">');
    expect(html).toContain("has not been confirmed as saved to disk yet, so it does not start.");
    expect(html).toContain('<p class="orch-task-hold" data-hold="reopen">This task was reopened with new instructions');
    // No colour while it is the ordinary moment between a reopen and its notice.
    expect(html).not.toContain('data-tone="warn"');
    expect(html).toContain('data-state="planned"');
  });

  it("takes the warning colour once it has lasted, and says what that means", () => {
    const [planned] = runProgress(held, held.runs[0], LATER).rows;
    expect(planned).toMatchObject({ state: "planned", why: REOPEN_LASTED_LABEL, tone: "warn", decisions: 0 });
    const html = row(panel(held, LATER));
    expect(html).toContain(`<span class="run-row-note" data-tone="warn"`);
    expect(html).toContain(`>${REOPEN_LASTED_LABEL}</span>`);
    expect(html).toContain('<p class="orch-task-hold" data-hold="reopen" data-tone="warn">');
    expect(html).toContain(REOPEN_LASTED_DETAIL.replace(/'/g, "&#x27;"));
  });

  it("goes back to an ordinary planned row once the notice is confirmed", () => {
    const told = hostFacts.reopenNoticeDelivered();
    expect(runProgress(told, told.runs[0], LATER).rows[0]).toMatchObject({ state: "planned", why: null, tone: null, hold: null });
    const html = row(panel(told, LATER));
    expect(html).toContain('aria-label="Planned"');
    expect(html).not.toContain("Reopened");
  });

  it("is never behind the group's N more", () => {
    // Changed for this test: five more planned tasks ahead of it in the plan.
    const many = hostFacts.heldByReopen();
    const [task] = many.tasks;
    many.tasks = [...Array.from({ length: 5 }, (_, index) => ({ ...task, id: `other_${index}`, title: `Other ${index}`, heldByReopen: undefined, reopens: undefined, activeAttemptId: undefined })), task];
    const group = runProgress(many, many.runs[0], SOON).groups.find((item) => item.key === "planned")!;
    expect(group.rows[0].task.id).toBe(task.id);
  });
});

describe("what waits on the person", () => {
  it("is nothing: no Needs you, no decision, no badge", () => {
    for (const now of [SOON, LATER]) {
      const strip = chatStrip(chatSnapshot(held, held.runs[0].coordinatorChatKey), now)!.strip;
      expect(strip).toMatchObject({ state: "running", needs: 0, failed: 0, live: false });
      expect(strip.side).toEqual([]);
      // Said in the tooltip, and only there.
      expect(strip.notes).toEqual(["1 reopened task held: the notice of it is not confirmed as saved yet."]);
    }
    const reading = pendingReading({ orchestration: held, parents: workerChatParents(held) });
    expect(reading.actions).toEqual([]);
    expect(taskColumnCounts(held, reading.held)).toMatchObject({ decisions: 0 });
    const scoped = chatSnapshot(held, held.runs[0].coordinatorChatKey);
    expect(chatRunStatus(scoped, rowRun(scoped, reading.held)!, reading.held)).not.toMatch(/Needs/);
    const html = panel(held, LATER);
    expect(html).not.toContain("Needs you");
    expect(html).not.toMatch(/to decide/);
  });
});

describe("the Agents page", () => {
  // Changed for this test: the host's task was handed to nobody, and the
  // Agents page lists a task under the agent it was handed to.
  const assigned = () => {
    const snapshot = hostFacts.heldByReopen();
    snapshot.tasks[0].assignee = { id: "dev", name: "Dev" };
    return snapshot;
  };
  const TEAM: TeamAgent[] = [{ id: "dev", name: "Dev", role: "", agent: "codex", model: "gpt-5.6-sol", access: "auto", createdAt: 1, updatedAt: 1 }];
  const roster = (now?: number) => agentRoster({
    team: TEAM, leads: [], snapshot: assigned(), projects: [], providerLabel: () => "Codex", chatTitle: () => undefined,
    chatExists: () => true, leadActivity: () => "idle", waitingOn: () => 0, now,
  });

  it("says the same words, as a task that waits and asks nothing of the person", () => {
    const [dev] = roster(SOON);
    expect(dev).toMatchObject({ state: "queued", stateLabel: REOPEN_LABEL });
    expect(dev.activities).toEqual([expect.objectContaining({ state: "queued", label: REOPEN_LABEL, detail: REOPEN_DETAIL })]);
    expect(dev.activities[0].tone).toBeUndefined();
    expect(dev.counts.needs_you).toBeUndefined();
    expect(dev.stateLabel).not.toMatch(/ready/i);
    expect(workingTaskCount(assigned())).toBe(0);
  });

  it("warns once it has lasted, and never without a clock to say so", () => {
    expect(roster(LATER)[0].activities[0]).toMatchObject({ state: "queued", label: REOPEN_LASTED_LABEL, tone: "warn" });
    expect(roster()[0].activities[0]).toMatchObject({ label: REOPEN_LABEL });
    expect(roster()[0].activities[0].tone).toBeUndefined();
  });
});
