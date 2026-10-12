// A plan waiting for approval beside work that was approved and then went
// wrong, or was stopped.
//
// The four ledgers are the host's own (`__fixtures__/host/plan_after_*`): A
// was approved, started, and then failed, was blocked, completed a review
// with a failed check, or was stopped by the person; B was added afterwards,
// so the plan is with the person again. The host says `heldByPlan: false`
// for A and `true` for B in all four, and starts a retry of the failed and
// the blocked A while the plan waits.
//
// Two things are asked of every place that chooses between the plan and the
// rows: the plan never stands in for a row the person has to see, and no
// surface says nothing can start while the host would start something.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("./bridge", () => ({
  bridge: { invoke: async () => null, on: () => () => {}, onState: () => () => {} },
}));

import { agentRoster } from "./agentsDashboard";
import type { TeamAgent } from "./agentsMode";
import { chatRunStatus, chatSnapshot, rowRun } from "./chatWorkflow";
import { hostFacts } from "./__fixtures__/hostFacts";
import { missionState } from "./mission";
import type { OrchestrationSnapshot } from "./orchestration";
import { runAttention } from "./runPanel";
import { chatStrip, planStandsIn, runProgress } from "./runProgress";
import { runWaits } from "./runWaits";
import { planHoldsEveryStart, STOPPED_LABEL } from "./taskHold";
import { OrchestrationPanel, PLAN_HOLDS_ALL, PLAN_HOLDS_SOME } from "../components/OrchestrationPanel";
import { PLAN_GOES_ON, PLAN_STARTS_NOTHING, PlanReview } from "../components/PlanReview";

afterEach(() => vi.useRealTimers());

const CASES = {
  failed: hostFacts.planAfterFailed,
  blocked: hostFacts.planAfterBlocked,
  checkFailed: hostFacts.planAfterCheckFailed,
  stopped: hostFacts.planAfterStopped,
} as const;
type Case = keyof typeof CASES;
const NAMES = Object.keys(CASES) as Case[];

/** A moment after the ledger's latest stamp. */
const after = (snapshot: OrchestrationSnapshot) => Math.max(...snapshot.tasks.map((task) => task.updatedAt)) + 5_000;

const panel = (snapshot: OrchestrationSnapshot) => {
  vi.useFakeTimers();
  vi.setSystemTime(after(snapshot));
  const run = snapshot.runs[0];
  return renderToStaticMarkup(<OrchestrationPanel embedded allowManualRun={false} project={{ id: run.workspaceId, name: "Project" }}
    coordinatorKey={run.coordinatorChatKey} initialSnapshot={snapshot} onOpenChat={() => {}} onClose={() => {}} />);
};
const rows = (html: string) => html.split('<article class="orch-task').slice(1).map((part) => part.slice(0, part.indexOf("</article>")));
/** One group of the panel, by its key: "" when it is not drawn. A row holds
 *  no section of its own before its `</article>`, so the group ends at the
 *  next group or at the tab panel's end. */
const group = (html: string, key: "needs" | "running" | "finished" | "planned") => {
  const from = html.indexOf(`<section class="run-group" data-group="${key}"`);
  if (from < 0) return "";
  const next = html.indexOf('<section class="run-group"', from + 1);
  return html.slice(from, next < 0 ? html.indexOf('role="tabpanel"', from) : next);
};
const card = (snapshot: OrchestrationSnapshot) =>
  renderToStaticMarkup(<PlanReview run={snapshot.runs[0]} tasks={snapshot.tasks} drafting={false} onRequestChanges={() => {}} />);

describe("the host's own ledgers", () => {
  it.each(NAMES)("%s: A is approved and not held, B is held, and the plan is pending", (name) => {
    const snapshot = CASES[name]();
    const [a, b] = snapshot.tasks;
    expect(snapshot.runs[0].planApproval?.status).toBe("pending");
    expect(a).toMatchObject({ heldByPlan: false });
    expect(a.approvedAt).toBeGreaterThan(0);
    expect(b).toMatchObject({ status: "ready", heldByPlan: true });
    expect(b.approvedAt).toBeUndefined();
  });

  it("leaves A failed, blocked, completed with a failed check, and failed with the person's stop on it", () => {
    expect(CASES.failed().tasks[0]).toMatchObject({ status: "failed" });
    expect(CASES.failed().tasks[0].stopped).toBeUndefined();
    expect(CASES.blocked().tasks[0]).toMatchObject({ status: "blocked" });
    expect(CASES.checkFailed().tasks[0]).toMatchObject({ status: "completed", kind: "review", verdict: "fail" });
    const stopped = CASES.stopped();
    expect(stopped.tasks[0]).toMatchObject({ status: "failed", stopped: { attemptId: stopped.attempts[0].id } });
    expect(stopped.attempts[0]).toMatchObject({ status: "cancelled" });
  });
});

describe("whether the plan may stand in for the run's rows", () => {
  it.each(NAMES)("%s: it may not, A's row has to be seen", (name) => {
    const snapshot = CASES[name]();
    const run = snapshot.runs[0];
    expect(planStandsIn(run, runProgress(snapshot, run, after(snapshot)).rows)).toBe(false);
  });

  it("may while everything else is finished without a failed check, cancelled or replaced", () => {
    // Changed for this test: A completed and nothing failed.
    const done = CASES.failed();
    Object.assign(done.tasks[0], { status: "completed", result: "Done" });
    Object.assign(done.attempts[0], { status: "completed", execution: { ...done.attempts[0].execution!, state: "completed" } });
    expect(planStandsIn(done.runs[0], runProgress(done, done.runs[0], after(done)).rows)).toBe(true);
    // Changed for this test: A was cancelled; and A failed and was replaced.
    const cancelled = CASES.failed();
    cancelled.tasks[0].status = "cancelled";
    expect(planStandsIn(cancelled.runs[0], runProgress(cancelled, cancelled.runs[0], after(cancelled)).rows)).toBe(true);
    const replaced = CASES.failed();
    replaced.tasks[0].supersededBy = replaced.tasks[1].id;
    expect(planStandsIn(replaced.runs[0], runProgress(replaced, replaced.runs[0], after(replaced)).rows)).toBe(true);
  });

  it("may not for an approved task that has not started, and never for a plan that is not pending", () => {
    const beside = hostFacts.heldByPlan();
    expect(planStandsIn(beside.runs[0], runProgress(beside, beside.runs[0], after(beside)).rows)).toBe(false);
    // Changed for this test: the plan was approved.
    const approved = CASES.failed();
    approved.runs[0].planApproval!.status = "approved";
    expect(planStandsIn(approved.runs[0], runProgress(approved, approved.runs[0], after(approved)).rows)).toBe(false);
  });

  it("may for a host that does not say what the plan holds, unless a task failed, is blocked or was stopped", () => {
    // Changed for this test: no task carries `heldByPlan`, as an older host
    // sends it.
    const silent = (name: Case) => {
      const snapshot = CASES[name]();
      for (const task of snapshot.tasks) delete task.heldByPlan;
      return snapshot;
    };
    for (const name of NAMES) {
      const snapshot = silent(name);
      expect(planStandsIn(snapshot.runs[0], runProgress(snapshot, snapshot.runs[0], after(snapshot)).rows)).toBe(false);
    }
    const waiting = silent("failed");
    waiting.tasks[0].status = "ready";
    expect(planStandsIn(waiting.runs[0], runProgress(waiting, waiting.runs[0], after(waiting)).rows)).toBe(true);
  });
});

describe("whether the host would refuse every start", () => {
  it("would not for an approved task that failed, is blocked, or that the person stopped", () => {
    for (const name of ["failed", "blocked", "stopped"] as const) {
      const snapshot = CASES[name]();
      expect(planHoldsEveryStart(snapshot.runs[0], snapshot.tasks)).toBe(false);
    }
  });

  it("would while the only thing left to start is what the plan holds", () => {
    // A finished review takes no worker, whatever its verdict.
    const snapshot = CASES.checkFailed();
    expect(planHoldsEveryStart(snapshot.runs[0], snapshot.tasks)).toBe(true);
  });

  it("would not while a worker is running or an approved task waits its turn", () => {
    const beside = hostFacts.heldByPlan();
    expect(planHoldsEveryStart(beside.runs[0], beside.tasks)).toBe(false);
    // Changed for this test: A is running.
    const running = CASES.failed();
    running.tasks[0].status = "running";
    expect(planHoldsEveryStart(running.runs[0], running.tasks)).toBe(false);
  });

  it("would for a host that does not say, as the page read it before", () => {
    const snapshot = CASES.failed();
    for (const task of snapshot.tasks) delete task.heldByPlan;
    expect(planHoldsEveryStart(snapshot.runs[0], snapshot.tasks)).toBe(true);
  });
});

describe("the plan card's line beside Approve", () => {
  it.each(["failed", "blocked", "stopped"] as const)("%s: does not say no worker starts", (name) => {
    const html = card(CASES[name]());
    expect(html).not.toContain(PLAN_STARTS_NOTHING);
    expect(html).toContain(PLAN_GOES_ON);
  });

  it("says no worker starts while the host would refuse every start", () => {
    expect(card(CASES.checkFailed())).toContain(PLAN_STARTS_NOTHING);
  });
});

describe("the run panel", () => {
  it.each(NAMES)("%s: draws both rows and the run's totals beside the plan", (name) => {
    const html = panel(CASES[name]());
    expect(rows(html)).toHaveLength(2);
    expect(html).toContain('<dl class="run-tiles" aria-label="Mission totals">');
    expect(html).toContain("<dt>Tasks</dt><dd>0 / 2</dd>");
    // The plan is still there to approve, and the line under it says what
    // the host holds: every start only where the one approved task is a
    // review that finished, which takes no worker.
    expect(html).toContain("Approve plan");
    const [said, unsaid] = name === "checkFailed" ? [PLAN_HOLDS_ALL, PLAN_HOLDS_SOME] : [PLAN_HOLDS_SOME, PLAN_HOLDS_ALL];
    expect(html).toContain(said);
    expect(html).not.toContain(unsaid);
  });

  it.each([["failed", "Failed"], ["blocked", "Blocked"], ["checkFailed", "Check failed"]] as const)(
    "%s: A is first under Running, in the danger colour, with the host's word", (name, word) => {
      const html = panel(CASES[name]());
      const running = group(html, "running");
      expect(running).toContain('data-state="failed"');
      expect(running).toContain('data-tone="danger"');
      expect(running).toContain(`>${word}</span>`);
      expect(rows(running)).toHaveLength(1);
      expect(running).toContain('aria-label="Running, 1 task"');
      expect(group(html, "planned")).toContain(">Waiting for plan approval</span>");
    });

  it("stopped: A keeps Stopped by you and its way back", () => {
    const html = panel(CASES.stopped());
    const planned = group(html, "planned");
    expect(rows(planned)).toHaveLength(2);
    // The one the person stopped leads the group.
    expect(rows(planned)[0]).toContain(`>${STOPPED_LABEL}</span>`);
    expect(rows(planned)[0]).toContain('data-hold="stopped"');
    expect(rows(planned)[0]).toContain(">Start it again</button>");
    expect(group(html, "running")).toBe("");
  });

  it("draws the plan alone while everything else is finished, and says the tasks start once it is approved", () => {
    // Changed for this test: A completed and nothing failed.
    const done = CASES.failed();
    Object.assign(done.tasks[0], { status: "completed", result: "Done" });
    Object.assign(done.attempts[0], { status: "completed", execution: { ...done.attempts[0].execution!, state: "completed" } });
    const html = panel(done);
    expect(rows(html)).toHaveLength(0);
    expect(html).not.toContain('class="run-tiles"');
    expect(html).toContain(PLAN_HOLDS_ALL);
    expect(html).toContain(PLAN_STARTS_NOTHING);
  });

  it.each(NAMES)("%s: a mission draws its totals too", (name) => {
    // Changed for this test: the run is a mission.
    const snapshot = CASES[name]();
    snapshot.runs[0].workspaceMode = "mission";
    const html = panel(snapshot);
    expect(rows(html)).toHaveLength(2);
    expect(html).toContain('<dl class="run-tiles" aria-label="Mission totals">');
  });
});

describe("the strip above the composer", () => {
  const strip = (name: Case) => {
    const snapshot = CASES[name]();
    return chatStrip(chatSnapshot(snapshot, snapshot.runs[0].coordinatorChatKey), after(snapshot))!.strip;
  };

  it.each(["failed", "blocked", "checkFailed"] as const)("%s: says the plan and the failure", (name) => {
    expect(strip(name)).toMatchObject({ state: "needs", needs: 1, planOnly: true, failed: 1, label: "Tasks 0/2" });
    expect(strip(name).side.map((item) => item.text)).toEqual(["Plan to approve", "1 failed"]);
  });

  it("stopped: says the plan and the task the person stopped", () => {
    expect(strip("stopped")).toMatchObject({ state: "needs", needs: 1, planOnly: true, failed: 0 });
    expect(strip("stopped").side.map((item) => item.text)).toEqual(["Plan to approve", "1 stopped"]);
    expect(strip("stopped").notes).toEqual(["1 task stopped by you: only your Start starts it again."]);
  });

  it("gives the second count to a failure or a worker before a stopped task, and says it with no plan too", () => {
    // Changed for this test: the plan was approved, so nothing waits on the
    // person and the stopped task is all the run has to say.
    const approved = CASES.stopped();
    approved.runs[0].planApproval!.status = "approved";
    const quiet = chatStrip(chatSnapshot(approved, approved.runs[0].coordinatorChatKey), after(approved))!.strip;
    expect(quiet.state).toBe("running");
    expect(quiet.side.map((item) => item.text)).toEqual(["1 stopped"]);
  });
});

describe("the surfaces that never chose between the plan and the rows", () => {
  it("the run's attention count keeps the plan and the task that needs attention apart", () => {
    for (const name of ["failed", "blocked"] as const) {
      const snapshot = CASES[name]();
      const run = snapshot.runs[0];
      expect(runAttention(run, snapshot.tasks, snapshot.attempts, runWaits(snapshot, run))).toMatchObject({ decisions: 1, blocked: 1, total: 2 });
    }
    const stopped = CASES.stopped();
    expect(runAttention(stopped.runs[0], stopped.tasks, stopped.attempts, runWaits(stopped, stopped.runs[0]))).toMatchObject({ decisions: 1, blocked: 0 });
  });

  it("the chat list's line leads with the decision, says what failed, and counts nothing failed as done", () => {
    // A completed review whose check failed is not done: the line says 0/2
    // and "1 failed", as the strip does (`finishedWell.surfaces.test`).
    for (const name of NAMES) {
      const snapshot = CASES[name]();
      const scoped = chatSnapshot(snapshot, snapshot.runs[0].coordinatorChatKey);
      expect(chatRunStatus(scoped, rowRun(scoped)!)).toBe(name === "stopped" ? "Needs you · 0/2 done" : "Needs you · 1 failed · 0/2 done");
    }
  });

  it("the Agents page says each task's own state", () => {
    // Changed for this test: the host's tasks were handed to nobody, and
    // the Agents page lists a task under the agent it was handed to.
    const TEAM: TeamAgent[] = [{ id: "dev", name: "Dev", role: "", agent: "codex", model: "gpt-5.6-sol", access: "auto", createdAt: 1, updatedAt: 1 }];
    const labels = (name: Case) => {
      const snapshot = CASES[name]();
      for (const task of snapshot.tasks) task.assignee = { id: "dev", name: "Dev" };
      const [dev] = agentRoster({
        team: TEAM, leads: [], snapshot, projects: [], providerLabel: () => "Codex", chatTitle: () => undefined,
        chatExists: () => true, leadActivity: () => "idle", waitingOn: () => 0, now: after(snapshot),
      });
      return dev.activities.map((activity) => activity.label);
    };
    expect(labels("failed")).toEqual(["Failed", "Waiting for plan approval"]);
    expect(labels("blocked")).toEqual(["Blocked", "Waiting for plan approval"]);
    // A review that completed with a failed check is a failure, listed
    // first under its agent with the panel row's own word.
    expect(labels("checkFailed")).toEqual(["Check failed", "Waiting for plan approval"]);
    expect(labels("stopped").sort()).toEqual([STOPPED_LABEL, "Waiting for plan approval"].sort());
  });
});

describe("a mission's stage", () => {
  // Changed for these tests: the run is a mission.
  const stage = (name: Case) => {
    const snapshot = CASES[name]();
    snapshot.runs[0].workspaceMode = "mission";
    return missionState(snapshot.runs[0], snapshot.tasks).stage;
  };

  it("is not a draft while approved work that failed, is blocked or was stopped could be started", () => {
    expect(stage("failed")).toBe("building");
    expect(stage("blocked")).toBe("building");
    expect(stage("stopped")).toBe("building");
  });

  it("is under review, not a draft, while the plan holds every start and an approved check has failed", () => {
    expect(stage("checkFailed")).toBe("review");
  });

  it("is a draft while the plan holds everything and nothing approved went wrong", () => {
    // Changed for this test: A completed and nothing failed.
    const done = CASES.failed();
    Object.assign(done.tasks[0], { status: "completed", result: "Done" });
    done.runs[0].workspaceMode = "mission";
    expect(missionState(done.runs[0], done.tasks).stage).toBe("draft");
  });
});
