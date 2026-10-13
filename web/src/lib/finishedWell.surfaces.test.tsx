// One question, every surface: did this task finish well?
//
// A task finished well when it completed and its check did not fail. A
// completed task whose check failed is never done, and is a failure like a
// task that failed or is blocked. Whether a failure is SHOWN as one, in the
// danger colour and counted failed, is whose move it is, and the host says
// (the second half of this file, "A failure, and whose move it is"). On a
// host that does not say, which is what the first half's ledgers are (they
// were recorded before it did, and carry no `retryLimit`), every failure is
// shown as one: present, named, in the danger colour, counted as failed.
// This file is the proof of both. Five ledgers, each with
// an unapproved task on a pending plan and with no plan at all, and for each
// one EVERY surface that says anything of a task or of a run's tasks is
// asked the same things:
//
//   - how many tasks are done, where the surface draws that count;
//   - how many failed, where it draws or says that;
//   - whether A is there, under which word and in which colour.
//
// The surfaces, each read the way the page reads it (drawn to markup where
// the surface is a component):
//
//   strip        the line above the composer         chatStrip + RunProgressStrip
//   tiles        the panel's Tasks tile              runProgress + OrchestrationPanel
//   rows         the panel's rows and groups         runProgress + OrchestrationPanel
//   runLine      a run's one line, folded            boardCounts (RunLine)
//   runList      the run picker's "N/M tasks"        OrchestrationPanel
//   attention    "N blocked" beside a run            runAttention
//   people       who a run is with, and the crew     runPeople, missionCrew
//   sidebar      the chat list's line                chatRunStatus
//   agents       the Agents page                     agentRoster, rosterSummary
//   mission      a mission's stage                   missionState
//
// The ledgers are the host's own (`__fixtures__/host/plan_after_*`): A was
// approved, started, and then failed, was blocked, completed a review with a
// failed check, or was stopped by the person; B was added afterwards, so the
// plan is with the person again. What is changed in a copy is said where it
// is changed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("./bridge", () => ({
  bridge: { invoke: async () => null, on: () => () => {}, onState: () => () => {} },
}));

import { agentRoster, rosterSummary } from "./agentsDashboard";
import type { TeamAgent } from "./agentsMode";
import { boardCounts } from "./agentTaskBoard";
import { chatRunLine, chatRunStatus, chatSnapshot, rowRun, workerLine } from "./chatWorkflow";
import { hostFacts } from "./__fixtures__/hostFacts";
import { missionState } from "./mission";
import { missionCrew } from "./missionPage";
import {
  checkFailed, failureMove, failureOf, failureShown, finishedWell, isRetrying, isSettled, saysFailures, shownRunStatus,
  type OrchestrationSnapshot, type OrchestrationTask,
} from "./orchestration";
import { runStages } from "./runAcceptance";
import { attentionLabel, attentionSpoken, attentionTone, runAttention, runPeople } from "./runPanel";
import { chatStrip, COORDINATOR_WORD, failureNote, planStandsIn, RETRYING_WORD, runCounts, runProgress, runTally, stripLine } from "./runProgress";
import { runWaits } from "./runWaits";
import { STOPPED_LABEL } from "./taskHold";
import { OrchestrationPanel } from "../components/OrchestrationPanel";
import { RunProgressStrip } from "../components/RunProgressStrip";
import { drawnStatus } from "../components/TaskMeter";
import agentsCss from "../components/AgentsDashboard.css?raw";
import workflowBarCss from "../components/ChatWorkflowBar.css?raw";
import missionCss from "../components/MissionPage.css?raw";
import runPanelCss from "../components/OrchestrationPanel.css?raw";
import runProgressCss from "../components/RunProgress.css?raw";

afterEach(() => vi.useRealTimers());

const MAIN = "chat:main";
const TEAM: TeamAgent[] = [{ id: "dev", name: "Dev", role: "", agent: "codex", model: "gpt-5.6-sol", access: "auto", createdAt: 1, updatedAt: 1 }];

/** One of the host's ledgers, set in this file's chat and project. Changed
 *  in the copy: the run's coordinator is renamed `chat:main`, its project
 *  `p1`, and both tasks are handed to Dev, because the Agents page and the
 *  crew list a task under the agent it was handed to and the host's probe
 *  handed its tasks to nobody. Nothing "finished well" is read from is
 *  touched. */
function placed(snapshot: OrchestrationSnapshot): OrchestrationSnapshot {
  const coordinator = JSON.stringify(snapshot.runs[0].coordinatorChatKey);
  const renamed = JSON.parse(JSON.stringify(snapshot).replaceAll(coordinator, JSON.stringify(MAIN))) as OrchestrationSnapshot;
  return {
    ...renamed,
    runs: renamed.runs.map((item) => ({ ...item, workspaceId: "p1" })),
    tasks: renamed.tasks.map((item) => ({ ...item, assignee: { id: "dev", name: "Dev" } })),
  };
}

/** The fifth ledger. Changed in a copy of `plan_after_failed`: A completed,
 *  as a plain task with no verdict, and so did its attempt. */
function finished(): OrchestrationSnapshot {
  const snapshot = hostFacts.planAfterFailed();
  Object.assign(snapshot.tasks[0], { status: "completed", result: "Done" });
  Object.assign(snapshot.attempts[0], { status: "completed", execution: { ...snapshot.attempts[0].execution!, state: "completed" } });
  return snapshot;
}

/** The same ledger with no plan at all. Changed in the copy: B, the task
 *  the person has not approved, is removed; the run carries no plan
 *  approval and A no `heldByPlan`, which is how the host sends a run that
 *  never had one (the key is left out). The run's status is left as the
 *  host recorded it. */
function noPlan(snapshot: OrchestrationSnapshot): OrchestrationSnapshot {
  const copy = JSON.parse(JSON.stringify(snapshot)) as OrchestrationSnapshot;
  copy.tasks = copy.tasks.slice(0, 1);
  delete copy.runs[0].planApproval;
  delete copy.tasks[0].heldByPlan;
  return copy;
}

const KINDS = {
  failed: hostFacts.planAfterFailed,
  blocked: hostFacts.planAfterBlocked,
  checkFailed: hostFacts.planAfterCheckFailed,
  stopped: hostFacts.planAfterStopped,
  finished,
} as const;
type Kind = keyof typeof KINDS;

/** What every surface has to say of A. Written by hand, never computed. */
const EXPECTED: Record<Kind, { done: number; failed: number; word: string | null }> = {
  failed: { done: 0, failed: 1, word: "Failed" },
  blocked: { done: 0, failed: 1, word: "Blocked" },
  checkFailed: { done: 0, failed: 1, word: "Check failed" },
  // Nothing failed: the person held it themselves.
  stopped: { done: 0, failed: 0, word: STOPPED_LABEL },
  finished: { done: 1, failed: 0, word: null },
};

type Scene = { name: string; kind: Kind; plan: boolean; ledger: OrchestrationSnapshot; total: number };
const SCENES: Scene[] = (Object.keys(KINDS) as Kind[]).flatMap((kind) => [
  { name: `${kind}, beside a pending plan`, kind, plan: true, ledger: placed(KINDS[kind]()), total: 2 },
  { name: `${kind}, with no plan`, kind, plan: false, ledger: placed(noPlan(KINDS[kind]())), total: 1 },
]);

/** A moment after the ledger's latest stamp. */
const after = (snapshot: OrchestrationSnapshot) => Math.max(...snapshot.tasks.map((task) => task.updatedAt)) + 5_000;
const count = (text: string | undefined) => text ? Number(text) : 0;

type Counts = { done: number | null; total: number | null; failed: number | null };

function surfaces(snapshot: OrchestrationSnapshot) {
  const now = after(snapshot);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const run = snapshot.runs[0];
  const scoped = chatSnapshot(snapshot, MAIN);
  const waits = runWaits(snapshot, run);
  const progress = runProgress(snapshot, run, now);
  const a = progress.rows[0];

  // The strip, as read and as drawn.
  const picked = chatStrip(scoped, now);
  const stripHtml = picked ? renderToStaticMarkup(<RunProgressStrip strip={picked.strip} onOpen={() => {}} onHide={() => {}} />) : "";
  const label = /<span class="run-strip-count" aria-hidden="true">(\d+)\/(\d+)<\/span>/.exec(stripHtml);

  // The panel beside the chat, as drawn: its tile and its rows.
  const panelHtml = renderToStaticMarkup(<OrchestrationPanel embedded allowManualRun={false} project={{ id: "p1", name: "Project" }}
    coordinatorKey={MAIN} initialSnapshot={snapshot} onOpenChat={() => {}} onClose={() => {}} />);
  const tile = /<dt>Tasks<\/dt><dd>(\d+) \/ (\d+)<\/dd>/.exec(panelHtml);
  const drawnRows = panelHtml.split('<article class="orch-task').slice(1).map((part) => part.slice(0, part.indexOf("</article>")));
  // A plan that stands in for the run draws neither rows nor totals: there
  // is nothing else to show (`planStandsIn`), which is true only while
  // everything else finished well.
  const stoodIn = planStandsIn(run, progress.rows);
  expect(drawnRows.length, "the panel draws every row, or the plan alone").toBe(stoodIn ? 0 : progress.rows.length);
  expect(!!tile, "the panel draws its totals with its rows").toBe(!stoodIn);

  // The whole panel, whose picker lists every run with its count.
  const wholeHtml = renderToStaticMarkup(<OrchestrationPanel project={{ id: "p1", name: "Project" }} coordinatorKey={MAIN}
    initialSnapshot={snapshot} onOpenChat={() => {}} onClose={() => {}} />);
  const picker = /<small>(\d+)\/(\d+) tasks/.exec(wholeHtml);

  // A run's one line while it is folded.
  const board = boardCounts(snapshot.tasks, snapshot);

  // The chat list's line.
  const line = chatRunStatus(scoped, rowRun(scoped)!);
  const lineDone = /(\d+)\/(\d+) done/.exec(line);

  // The Agents page.
  const roster = agentRoster({
    team: TEAM, leads: [], snapshot, projects: [{ id: "p1", name: "Project" }], providerLabel: () => "Codex",
    chatTitle: () => undefined, chatExists: () => true, leadActivity: () => "idle", waitingOn: () => 0, now,
  });
  const dev = roster[0];
  const mine = dev.activities.find((activity) => activity.taskId === snapshot.tasks[0].id);
  const summary = Object.fromEntries(rosterSummary(roster).map((item) => [item.state as string, item.count]));

  // Who the run is with, and a mission's crew.
  const people = runPeople(run, snapshot.tasks, snapshot.attempts, waits.gated, TEAM);
  const crew = missionCrew(run, snapshot.tasks, snapshot.attempts, waits.gated, TEAM, null);

  vi.useRealTimers();
  return {
    a, line, dev, mine, summary, people, crew, stripHtml, panelHtml, drawnRows, stoodIn,
    attention: runAttention(run, snapshot.tasks, snapshot.attempts, waits),
    stage: missionState({ ...run, workspaceMode: "mission" }, snapshot.tasks),
    counts: {
      strip: { done: picked?.strip.done ?? null, total: picked?.strip.total ?? null, failed: picked?.strip.failed ?? null },
      stripDrawn: { done: label ? Number(label[1]) : null, total: label ? Number(label[2]) : null, failed: count(/(\d+) failed/.exec(stripHtml)?.[1]) },
      tiles: { ...progress.tiles.tasks, failed: null },
      tileDrawn: { done: tile ? Number(tile[1]) : null, total: tile ? Number(tile[2]) : null, failed: null },
      rows: { done: progress.rows.filter((row) => row.state === "done").length, total: progress.rows.length, failed: progress.rows.filter((row) => row.state === "failed").length },
      rowsDrawn: stoodIn ? { done: null, total: null, failed: null }
        : { done: drawnRows.filter((row) => row.includes('data-state="done"')).length, total: drawnRows.length, failed: drawnRows.filter((row) => row.includes('data-state="failed"')).length },
      runLine: { done: board.done, total: board.total, failed: null },
      runList: { done: picker ? Number(picker[1]) : null, total: picker ? Number(picker[2]) : null, failed: null },
      sidebar: { done: lineDone ? Number(lineDone[1]) : null, total: lineDone ? Number(lineDone[2]) : null, failed: count(/(\d+) failed/.exec(line)?.[1]) },
      // The Agents page counts no finished work. What failed is one item
      // under its agent each, and the agent is in that state.
      agents: { done: null, total: null, failed: dev.activities.filter((activity) => (activity.state as string) === "failed").length },
    } satisfies Record<string, Counts>,
  };
}

describe("the ledgers", () => {
  it("are the host's, A settled each way and B on the pending plan", () => {
    expect(hostFacts.planAfterFailed().tasks[0]).toMatchObject({ status: "failed" });
    expect(hostFacts.planAfterBlocked().tasks[0]).toMatchObject({ status: "blocked" });
    expect(hostFacts.planAfterCheckFailed().tasks[0]).toMatchObject({ status: "completed", kind: "review", verdict: "fail" });
    expect(hostFacts.planAfterStopped().tasks[0]).toMatchObject({ status: "failed", stopped: {} });
    expect(finished().tasks[0]).toMatchObject({ status: "completed" });
    for (const scene of SCENES) {
      expect(scene.ledger.tasks, scene.name).toHaveLength(scene.total);
      expect(scene.ledger.runs[0].planApproval?.status, scene.name).toBe(scene.plan ? "pending" : undefined);
      // Live in every one: what the Agents page calls current work.
      expect(scene.ledger.runs[0].status, scene.name).toBe("running");
    }
  });
});

describe("every surface counts the same tasks done and the same tasks failed", () => {
  it.each(SCENES)("$name", ({ kind, ledger, total }) => {
    const { counts } = surfaces(ledger);
    const want = EXPECTED[kind];
    for (const [surface, said] of Object.entries(counts) as [string, Counts][]) {
      if (said.done !== null) expect(said.done, `${surface}: done`).toBe(want.done);
      if (said.total !== null) expect(said.total, `${surface}: of`).toBe(total);
      if (said.failed !== null) expect(said.failed, `${surface}: failed`).toBe(want.failed);
    }
  });
});

describe("a failure is there, under the panel's word, in the danger colour", () => {
  const FAILURES = SCENES.filter((scene) => EXPECTED[scene.kind].failed > 0);

  it.each(FAILURES)("$name: the panel's row", ({ kind, ledger }) => {
    const { a, drawnRows } = surfaces(ledger);
    expect(a).toMatchObject({ state: "failed", group: "running", why: EXPECTED[kind].word, tone: "danger" });
    const drawn = drawnRows.find((row) => row.includes('data-state="failed"'))!;
    expect(drawn).toContain('data-tone="danger"');
    expect(drawn).toContain(`>${EXPECTED[kind].word}</span>`);
  });

  it.each(FAILURES)("$name: the Agents page lists it under its agent, with the panel's word, and the agent is not Queued", ({ kind, ledger, plan }) => {
    const { a, dev, mine, summary } = surfaces(ledger);
    expect(mine, "A is listed").toBeDefined();
    // The word is the panel row's own, so the two cannot say different
    // things of one task.
    expect(mine!.label).toBe(a.why);
    expect(mine!.label).toBe(EXPECTED[kind].word);
    expect(mine!.state as string).toBe("failed");
    expect(mine!.tone as string).toBe("danger");
    // What failed leads the agent's own list, and is the agent's state.
    expect(dev.activities[0].taskId).toBe(mine!.taskId);
    expect(dev.state as string).toBe("failed");
    expect(dev.stateLabel).toBe(EXPECTED[kind].word);
    expect(dev.counts).toEqual(plan ? { failed: 1, queued: 1 } : { failed: 1 });
    expect(summary).toEqual({ failed: 1 });
  });

  it.each(FAILURES)("$name: the chat list's line says it", ({ ledger, plan, total }) => {
    const { line } = surfaces(ledger);
    expect(line).toBe(plan ? `Needs you · 1 failed · 0/${total} done` : `1 failed · 0/${total} done`);
  });

  it.each(FAILURES)("$name: the run's attention count, its people and a mission's crew say it", ({ ledger, plan }) => {
    const { attention, people, crew } = surfaces(ledger);
    expect(attention).toMatchObject({ blocked: 1, failed: 1, decisions: plan ? 1 : 0 });
    // Beside a plan the decision leads the button; alone, the failure is
    // its word and its colour.
    expect(attentionLabel(attention)).toBe(plan ? "Approval needed" : "1 failed");
    expect(attentionTone(attention)).toBe(plan ? "decision" : "failed");
    expect(attentionSpoken(attention)).toBe(plan ? "1 decision waiting, 1 task failed" : "1 task failed");
    expect(people.map((person) => person.state as string)).toEqual(["failed"]);
    expect(crew.map((member) => member.state as string)).toEqual(["failed"]);
  });
});

describe("a task the person stopped is held, not failed", () => {
  it.each(SCENES.filter((scene) => scene.kind === "stopped"))("$name", ({ ledger, plan, total }) => {
    const { a, mine, dev, line, attention, people } = surfaces(ledger);
    expect(a).toMatchObject({ state: "planned", why: STOPPED_LABEL });
    expect(mine).toMatchObject({ state: "queued", label: STOPPED_LABEL });
    expect(dev.state).toBe("queued");
    expect(line).toBe(plan ? `Needs you · 0/${total} done` : `Running · 0/${total} done`);
    expect(attention.blocked).toBe(0);
    expect(people.map((person) => person.state as string)).toEqual(["assigned"]);
  });
});

describe("a task that finished well is folded away quietly", () => {
  it.each(SCENES.filter((scene) => scene.kind === "finished"))("$name", ({ ledger, plan, total }) => {
    const { a, mine, dev, line, attention, people, summary } = surfaces(ledger);
    expect(a).toMatchObject({ state: "done", group: "finished", why: null, tone: null });
    // The Agents page shows no successful history.
    expect(mine).toBeUndefined();
    expect(dev.state).toBe(plan ? "queued" : "idle");
    expect(summary).toEqual(plan ? { queued: 1 } : { idle: 1 });
    expect(line).toBe(plan ? `Needs you · 1/${total} done` : `Running · 1/${total} done`);
    expect(attention.blocked).toBe(0);
    expect(people.map((person) => person.state as string)).toEqual([plan ? "assigned" : "done"]);
  });
});

describe("a mission's stage", () => {
  const stage = (kind: Kind, plan: boolean) => surfaces(SCENES.find((scene) => scene.kind === kind && scene.plan === plan)!.ledger).stage;

  it("is never Ready to merge, or a draft, while an approved check has failed", () => {
    // Everything that could take a worker is settled or held, and a review
    // of approved work did not pass: under review, and waiting on someone.
    expect(stage("checkFailed", false)).toMatchObject({ stage: "review", blocked: true });
    expect(stage("checkFailed", true)).toMatchObject({ stage: "review", blocked: true });
  });

  it("is Ready to merge once everything finished well", () => {
    expect(stage("finished", false)).toMatchObject({ stage: "ready", blocked: false });
  });

  it("keeps the stage of approved work that failed, is blocked or was stopped", () => {
    for (const kind of ["failed", "blocked", "stopped"] as const) {
      expect(stage(kind, true).stage, kind).toBe("building");
      expect(stage(kind, false).stage, kind).toBe("building");
    }
  });
});

/* ---- The reader --------------------------------------------------------- */

describe("how a task ended is read in one place", () => {
  const ended = (over: Partial<OrchestrationTask>) => ({ status: "completed", ...over }) as OrchestrationTask;

  it("settled, failed its check, finished well", () => {
    // [task, settled, check failed, finished well]. Written by hand.
    const table: [Partial<OrchestrationTask>, boolean, boolean, boolean][] = [
      [{ status: "completed" }, true, false, true],
      [{ status: "completed", kind: "review", verdict: "pass" }, true, false, true],
      [{ status: "completed", kind: "review", verdict: "fail" }, true, true, false],
      // An ordinary task whose worker reported a failing verdict all the same.
      [{ status: "completed", verdict: "fail" }, true, true, false],
      // Replaced: history, owed nothing, like a replaced task that failed.
      [{ status: "completed", verdict: "fail", supersededBy: "t2" }, true, false, true],
      // A check with no verdict (an older record) did not fail.
      [{ status: "completed", kind: "check" }, true, false, true],
      [{ status: "failed" }, false, false, false],
      [{ status: "blocked" }, false, false, false],
      [{ status: "running" }, false, false, false],
      [{ status: "ready" }, false, false, false],
      [{ status: "cancelled" }, false, false, false],
    ];
    for (const [task, settled, failed, well] of table) {
      const name = JSON.stringify(task);
      expect(isSettled(ended(task)), name).toBe(settled);
      expect(checkFailed(ended(task)), name).toBe(failed);
      expect(finishedWell(ended(task)), name).toBe(well);
    }
  });

  it("is not lifted by accepting the result: the host goes on holding what depends on it", () => {
    const accepted = ended({ kind: "review", verdict: "fail", activeAttemptId: "at", acceptance: { attemptId: "at" } as OrchestrationTask["acceptance"] });
    expect(checkFailed(accepted)).toBe(true);
    expect(finishedWell(accepted)).toBe(false);
  });

  it("holds a task that depends on a failed check, and says after what", () => {
    // Changed in a copy of the host's ledger: B depends on A, and is not
    // ready (the host leaves a task pending while a dependency holds it).
    const snapshot = placed(noPlan(hostFacts.planAfterCheckFailed()));
    const b: OrchestrationTask = { ...hostFacts.planAfterCheckFailed().tasks[1], status: "pending", dependsOn: [snapshot.tasks[0].id] };
    delete b.heldByPlan;
    const both = { ...snapshot, tasks: [snapshot.tasks[0], b] };
    expect(runProgress(both, both.runs[0], after(both)).rows[1].after).toEqual([snapshot.tasks[0].title]);
    // Once the check passes, nothing holds it.
    both.tasks[0] = { ...both.tasks[0], verdict: "pass" };
    expect(runProgress(both, both.runs[0], after(both)).rows[1].after).toEqual([]);
  });
});

describe("the counts are one function's", () => {
  it.each(SCENES)("$name: the strip, the tile, the chat list's line and the run picker read runTally", ({ ledger }) => {
    const run = ledger.runs[0];
    const progress = runProgress(ledger, run, after(ledger));
    const tally = runTally(run, progress.rows);
    expect(progress.tiles.tasks).toEqual({ done: tally.done, total: tally.total });
    expect(runCounts(ledger, run)).toEqual(tally);
    if (progress.strip) expect(progress.strip).toMatchObject(tally);
  });

  it("says a run the host calls failed as one failure, unless what it left failed is a task the person stopped", () => {
    const failedRun = (kind: Kind) => {
      // Changed in a copy: the run's status is what the host's
      // `recompute_run` gives a run whose only task failed.
      const ledger = placed(noPlan(KINDS[kind]()));
      ledger.runs[0].status = "failed";
      return runCounts(ledger, ledger.runs[0]);
    };
    expect(failedRun("failed")).toEqual({ done: 0, total: 1, failed: 1 });
    expect(failedRun("stopped")).toEqual({ done: 0, total: 1, failed: 0 });
  });
});

describe("the chat list's lines", () => {
  it("draw a decision in the decision colour and a failure in the danger colour, never the accent", () => {
    const tone = (kind: Kind, plan: boolean) => {
      const { ledger } = SCENES.find((scene) => scene.kind === kind && scene.plan === plan)!;
      const scoped = chatSnapshot(ledger, MAIN);
      return chatRunLine(scoped, rowRun(scoped)!).tone;
    };
    expect(tone("checkFailed", true)).toBe("decide");
    expect(tone("checkFailed", false)).toBe("danger");
    expect(tone("failed", false)).toBe("danger");
    expect(tone("stopped", false)).toBeNull();
    expect(tone("finished", false)).toBeNull();
    const rules = workflowBarCss.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rules).toMatch(/\.chat-workflow-status\[data-tone="danger"\]\s*\{\s*color:\s*var\(--danger\);/);
    expect(rules).toMatch(/\.chat-workflow-status\[data-tone="decide"\]\s*\{\s*color:\s*var\(--decide\);/);
  });

  it("say a worker's chat whose task failed its check failed it, and never 'completed'", () => {
    const ledger = hostFacts.planAfterCheckFailed();
    const [task] = ledger.tasks;
    const [attempt] = ledger.attempts;
    expect(attempt.status).toBe("completed");
    expect(workerLine(task, attempt)).toEqual({ text: `${task.title} · check failed`, tone: "danger" });
    // An earlier attempt of the task says how it ended itself.
    expect(workerLine(task, { ...attempt, id: "earlier", status: "failed" })).toEqual({ text: `${task.title} · failed`, tone: null });
    expect(workerLine(task, { ...attempt, archivedAt: 9 })).toEqual({ text: `${task.title} · archived`, tone: null });
    // Changed in a copy: the check passed.
    expect(workerLine({ ...task, verdict: "pass" }, attempt)).toEqual({ text: `${task.title} · completed`, tone: null });
  });
});

describe("a failure's colour is the danger colour on every sheet that draws one", () => {
  const rules = (sheet: string) => sheet.replace(/\/\*[\s\S]*?\*\//g, "");

  it("the Agents page: the chip, the count, the dot and the word", () => {
    const sheet = rules(agentsCss);
    expect(sheet).toMatch(/\.dash-state\.is-failed\s*\{[^}]*var\(--danger\)/);
    expect(sheet).toMatch(/\.dash-count\.is-failed\s*\{\s*color:\s*var\(--danger\);/);
    expect(sheet).toMatch(/\.dash-dot\.is-failed\s*\{\s*background:\s*var\(--danger\);/);
    expect(sheet).toMatch(/\.dash-item\[data-tone="danger"\] \.dash-item-state\s*\{\s*color:\s*var\(--danger\);/);
    // And nothing of a failure is on the warning colour.
    for (const rule of sheet.split("}")) if (rule.includes("is-failed")) expect(rule, rule).not.toMatch(/--warn\b/);
  });

  it("the panel: a row read as failed, whatever the ledger's status word, and who it is with", () => {
    const sheet = rules(runPanelCss);
    expect(sheet).toMatch(/\.orch-task\[data-state="failed"\]\s*\{\s*--task-color:\s*var\(--danger\);/);
    // After the status rules, so it wins over `data-status="completed"`.
    expect(sheet.indexOf('.orch-task[data-state="failed"]')).toBeGreaterThan(sheet.indexOf('.orch-task[data-status="completed"]'));
    expect(sheet).toMatch(/\.orch-person\[data-state="failed"\] \.orch-person-state\s*\{\s*color:\s*var\(--danger\);/);
    expect(sheet).toMatch(/\.orch-attention\[data-tone="failed"\]\s*\{[^}]*color:\s*var\(--danger\);/);
    expect(sheet).toMatch(/\.orch-stage-value\[data-tone="danger"\][^{]*\{\s*color:\s*var\(--danger\);/);
    expect(rules(missionCss)).toMatch(/\.mission-crew > li\[data-state="failed"\] \.mission-crew-state\s*\{\s*color:\s*var\(--danger\);/);
  });

  it("the acceptance line says a failing check in it, not in the warning colour", () => {
    const ledger = hostFacts.planAfterCheckFailed();
    const stages = runStages(ledger.tasks, ledger.attempts, null);
    expect(stages.find((stage) => stage.key === "acceptance")).toMatchObject({ value: "Failing", tone: "danger" });
    expect(stages.find((stage) => stage.key === "checks")).toMatchObject({ value: "1 failed", tone: "danger" });
    // "Settled" is the word where a failed check is in the count.
    expect(stages.find((stage) => stage.key === "tasks")).toMatchObject({ label: "Tasks settled", value: "1 of 2" });
  });

  it("the board that is not on any page draws a failed check as a failure too", () => {
    const [task] = hostFacts.planAfterCheckFailed().tasks;
    expect(drawnStatus(task)).toBe("failed");
    expect(drawnStatus({ ...task, verdict: "pass" })).toBe("completed");
    expect(boardCounts([task])).toMatchObject({ done: 0, total: 1, blocked: 1 });
  });
});

describe("a run that is over", () => {
  // On a host that does not say whose move a failure is. The Agents page
  // lists current work, and a run the host calls completed, failed or
  // stopped is history there for every kind of failure alike. The
  // host calls a run completed once every task has settled, failed checks
  // included, and failed once nothing is left but a failed task
  // (`recompute_run`). The strip and the panel go on saying the failure
  // until the run is archived, stopped or closed.
  const over = (kind: Kind, status: "completed" | "failed") => {
    // Changed in a copy: the run's status, to what the host gives it.
    const ledger = placed(noPlan(KINDS[kind]()));
    ledger.runs[0].status = status;
    return surfaces(ledger);
  };

  it.each([["checkFailed", "completed"], ["failed", "failed"]] as const)("%s in a run the host calls %s: the strip, the panel and the chat list say it, the Agents page lists no current work", (kind, status) => {
    const { counts, a, line, dev, mine } = over(kind, status);
    expect(counts.strip).toMatchObject({ done: 0, total: 1, failed: 1 });
    expect(counts.rowsDrawn).toMatchObject({ failed: 1 });
    expect(a).toMatchObject({ state: "failed", tone: "danger", why: EXPECTED[kind].word });
    expect(line).toBe("1 failed · 0/1 done");
    expect(mine).toBeUndefined();
    expect(dev.state).toBe("idle");
  });
});

/* ---- A failure, and whose move it is ------------------------------------ */

// The host says whose move each failure is (`task.failure.awaits`), and the
// page is quiet until one is the person's. Seven ledgers, each the host's
// own (`__fixtures__/host`, recorded from `retry_tests`), and every surface
// is asked the same things of each: how many tasks failed, how many are
// done, and what it says of A. Written by hand, never computed.
//
//   coordinator   failed once, retries remain          quiet: grey, counted nowhere
//   retrying      the coordinator's retry at work      grey "Retrying"
//   person        both retries used                    red, under Needs you, one decision
//   escalated     the coordinator asks the person      red; the gate is the decision, once
//   replaced      another task replaced it             history: "Replaced", counted nowhere
//   completedRun  a failed check, run "completed"      quiet: the run has not ended
//   stoppedRun    its run was stopped                  history: muted "Failed", counted nowhere

type Told = {
  ledger: () => OrchestrationSnapshot;
  /** The tasks that count as work, of the run's tasks. */
  total: number;
  failed: number;
  decisions: number;
  row: { state: string; group: string; why: string | null; tone: string | null };
  /** The strip's state and the word it draws, or null for no strip. */
  strip: [string, string] | null;
  line: [string, "danger" | "decide" | null];
  /** The run's attention button: its label and colour, or null for none. */
  attention: [string, string] | null;
  people: string[];
  /** A on the Agents page: its state and label, or null when not listed. */
  agent: [string, string] | null;
  status: string;
};

const TOLD: Record<string, Told> = {
  coordinator: {
    ledger: hostFacts.failureAwaitsCoordinator, total: 1, failed: 0, decisions: 0,
    row: { state: "running", group: "running", why: COORDINATOR_WORD, tone: null },
    // The host calls this run failed. It has not ended: its coordinator is on it.
    strip: ["running", "Running"], line: ["Running · 0/1 done", null], attention: null,
    people: ["assigned"], agent: ["queued", COORDINATOR_WORD], status: "running",
  },
  retrying: {
    ledger: hostFacts.retryExecuting, total: 1, failed: 0, decisions: 0,
    row: { state: "running", group: "running", why: RETRYING_WORD, tone: null },
    strip: ["running", "Running"], line: ["Running · 0/1 done", null], attention: null,
    people: ["assigned"], agent: ["queued", RETRYING_WORD], status: "running",
  },
  person: {
    ledger: hostFacts.failureAwaitsPerson, total: 1, failed: 1, decisions: 1,
    row: { state: "failed", group: "needs", why: "Failed", tone: "danger" },
    strip: ["failed", "1 failed"], line: ["1 failed · 0/1 done", "danger"], attention: ["1 failed", "failed"],
    people: ["failed"], agent: ["failed", "Failed"], status: "failed",
  },
  escalated: {
    ledger: hostFacts.failureEscalated, total: 2, failed: 1, decisions: 1,
    row: { state: "failed", group: "needs", why: "Failed", tone: "danger" },
    strip: ["failed", "1 failed"], line: ["1 failed · 0/2 done", "danger"], attention: ["1 failed", "failed"],
    people: ["failed"], agent: ["failed", "Failed"], status: "waiting",
  },
  replaced: {
    ledger: hostFacts.failureReplaced, total: 1, failed: 0, decisions: 0,
    row: { state: "closed", group: "finished", why: "Replaced", tone: null },
    strip: ["running", "Running"], line: ["Running · 0/1 done", null], attention: null,
    people: ["assigned"], agent: null, status: "running",
  },
  completedRun: {
    ledger: hostFacts.failureInCompletedRun, total: 1, failed: 0, decisions: 0,
    row: { state: "running", group: "running", why: COORDINATOR_WORD, tone: null },
    strip: ["running", "Running"], line: ["Running · 0/1 done", null], attention: null,
    people: ["assigned"], agent: ["queued", COORDINATOR_WORD], status: "running",
  },
  stoppedRun: {
    ledger: hostFacts.failureInStoppedRun, total: 0, failed: 0, decisions: 0,
    row: { state: "closed", group: "finished", why: "Failed", tone: null },
    strip: null, line: ["Stopped", null], attention: null,
    people: ["stopped"], agent: null, status: "stopped",
  },
};
const MOVES = Object.entries(TOLD).map(([name, told]) => ({ name, ...told }));

describe("the failure ledgers", () => {
  it("are the host's, and say whose move each failure is", () => {
    const first = (name: string) => TOLD[name].ledger().tasks[0];
    expect(first("coordinator")).toMatchObject({ status: "failed", retriesUsed: 0, retryLimit: 2, failure: { kind: "failed", awaits: "coordinator" } });
    expect(first("retrying")).toMatchObject({ status: "running", retrying: true, retriesUsed: 1 });
    expect(first("retrying").failure).toBeUndefined();
    expect(first("person")).toMatchObject({ status: "failed", retriesUsed: 2, failure: { awaits: "person", because: "retries_used" } });
    expect(first("escalated")).toMatchObject({ failure: { awaits: "person", because: "escalated" } });
    const [gate] = hostFacts.failureEscalated().gates;
    expect(gate).toMatchObject({ status: "open", awaits: "person", aboutTaskId: first("escalated").id, id: first("escalated").failure!.gateId });
    expect(gate.taskId).toBeUndefined();
    expect(first("replaced")).toMatchObject({ supersededBy: expect.any(String), failure: { awaits: "nobody", because: "replaced" } });
    expect(first("completedRun")).toMatchObject({ status: "completed", verdict: "fail", failure: { kind: "check_failed", awaits: "coordinator" } });
    expect(first("stoppedRun")).toMatchObject({ status: "failed", failure: { awaits: "nobody", because: "run_ended" } });
    // What the host calls the run is not whether a failure in it is history.
    expect(MOVES.map((move) => move.ledger().runs[0].status)).toEqual(["failed", "running", "failed", "waiting", "running", "completed", "stopped"]);
  });
});

describe("every surface says the same of a failure, by whose move it is", () => {
  it.each(MOVES)("$name: the counts", (told) => {
    const { counts } = surfaces(placed(told.ledger()));
    // What failed, wherever a surface says or draws a count of it.
    for (const [surface, said] of Object.entries(counts) as [string, Counts][]) {
      if (said.failed !== null) expect(said.failed, `${surface}: failed`).toBe(told.failed);
      if (said.done !== null) expect(said.done, `${surface}: done`).toBe(0);
    }
    // Done of the tasks that count: the strip, the tile, the picker and the
    // chat list's line are one function's (`runTally`). A stopped run has
    // nothing to count and draws neither a strip nor "0/0".
    for (const surface of ["strip", "stripDrawn", "sidebar"] as const) {
      expect(counts[surface].total, `${surface}: of`).toBe(told.total || null);
    }
    for (const surface of ["tiles", "tileDrawn", "runList"] as const) expect(counts[surface].total, `${surface}: of`).toBe(told.total);
  });

  it.each(MOVES)("$name: the row, and the row as drawn", (told) => {
    const { a, drawnRows } = surfaces(placed(told.ledger()));
    expect(a).toMatchObject(told.row);
    expect(a.decisions).toBe(told.decisions);
    const drawn = drawnRows[0];
    expect(drawn).toContain(`data-state="${told.row.state}"`);
    expect(drawn.includes('data-tone="danger"'), "the danger colour").toBe(told.row.tone === "danger");
    // Never the warning colour: a failure somebody is fixing is no warning.
    expect(drawn).not.toContain('data-tone="warn"');
    if (told.row.why) expect(drawn).toContain(`>${told.row.why}</span>`);
  });

  it.each(MOVES)("$name: the strip, the chat list's line, the attention button and the run's status", (told) => {
    const ledger = placed(told.ledger());
    const { line, attention, stripHtml, panelHtml } = surfaces(ledger);
    const scoped = chatSnapshot(ledger, MAIN);
    const picked = chatStrip(scoped, after(ledger));
    expect(picked ? [picked.strip.state, stripLine(picked.strip).word] : null).toEqual(told.strip);
    if (told.strip) expect(stripHtml).toContain(`data-state="${told.strip[0]}"`);
    expect(picked?.strip.needs ?? 0).toBe(told.decisions);
    expect([line, chatRunLine(scoped, rowRun(scoped)!).tone]).toEqual(told.line);
    expect(attention.decisions).toBe(told.decisions);
    expect(attentionLabel(attention) ? [attentionLabel(attention), attentionTone(attention)] : null).toEqual(told.attention);
    expect(shownRunStatus(ledger.runs[0], ledger.tasks)).toBe(told.status);
    // As drawn: a run its coordinator is fixing has no red mark and no
    // attention button, whatever the host calls the run.
    expect(panelHtml.includes("orch-status is-failed"), "a red run mark").toBe(told.status === "failed");
    expect(panelHtml.includes('class="orch-attention"'), "an attention button").toBe(!!told.attention);
  });

  it.each(MOVES)("$name: who the run is with, a mission's crew and the Agents page", (told) => {
    const { people, crew, mine, dev, summary } = surfaces(placed(told.ledger()));
    expect(people.map((person) => person.state as string)).toEqual(told.people);
    expect(crew.map((member) => member.state as string)).toEqual(told.people);
    expect(mine ? [mine.state as string, mine.label] : null).toEqual(told.agent);
    // Red on the Agents page only for a failure that waits on the person.
    expect(mine?.tone as string | undefined).toBe(told.failed ? "danger" : undefined);
    expect(summary.failed ?? 0).toBe(told.failed);
    expect((dev.state as string) === "failed").toBe(told.failed > 0);
  });
});

describe("a failure that waits on the person is one decision, with what moves it in words on the row", () => {
  it("retries used: counted once, and the row says to start it or put the run away", () => {
    const ledger = placed(hostFacts.failureAwaitsPerson());
    const { a, panelHtml, drawnRows } = surfaces(ledger);
    const waits = runWaits(ledger, ledger.runs[0]);
    expect(waits.person).toEqual([{ key: `failure:${a.task.id}`, kind: "failure", on: "person", runId: ledger.runs[0].id, taskId: a.task.id, failure: true }]);
    expect(a.failure).toMatchObject({ move: "person", kind: "failed", because: "retries_used", askCoordinator: false });
    expect(a.failure!.note).toBe("Its 2 automatic retries are used. Open this row for Start retry, or stop or archive the run.");
    // On the row itself, folded: not a tooltip, and not behind the disclosure.
    const row = drawnRows[0];
    const sentence = `<p class="orch-task-ask"><span>${a.failure!.note}</span></p>`;
    expect(row).toContain(sentence);
    expect(row.indexOf(sentence)).toBeLessThan(row.indexOf('class="orch-task-detail"'));
    expect(row).toContain(`data-pending-keys="failure:${a.task.id}"`);
    // The one start, where the row's other starts are, and offered once.
    expect(row.split(">Start retry<").length - 1).toBe(1);
    expect(panelHtml).toContain('aria-label="1 decision waiting, 1 task failed. Show"');
    expect(panelHtml).toContain("Needs you · 1 decision");
  });

  it("escalated: the gate is the decision, tied to the task's row and never counted beside the failure", () => {
    const ledger = placed(hostFacts.failureEscalated());
    const { a, panelHtml } = surfaces(ledger);
    const [gate] = ledger.gates;
    const waits = runWaits(ledger, ledger.runs[0]);
    expect(waits.person.map((wait) => [wait.key, wait.kind, wait.taskId, wait.failure])).toEqual([[`gate:${gate.id}`, "gate", a.task.id, true]]);
    expect(waits.tasks.get(a.task.id)!.person).toHaveLength(1);
    // Nothing of the task waits on it: it is not parked, and still starts.
    expect(waits.gated.has(a.task.id)).toBe(false);
    expect(a.failure!.note).toBe(`Its coordinator asks you: ${gate.question} Answer it under Needs you above, open this row for Start retry, or stop or archive the run.`);
    // Drawn as the decision it is, named for its task, and answered on the
    // page: the person's own answer is what gives the task its retries back.
    const box = panelHtml.slice(panelHtml.indexOf('class="orch-gate"'), panelHtml.indexOf("</article>", panelHtml.indexOf('class="orch-gate"')));
    expect(box).toContain(`data-pending-keys="gate:${gate.id}"`);
    expect(box).toContain(`>${a.task.title}</p>`);
    expect(box).not.toContain("This mission");
    expect(box).toContain(">Answer</button>");
    expect(box).not.toContain("Send to main chat");
  });

  it("a failed check with nothing to start says where to go, with the way there", () => {
    // Changed in a copy of the host's ledger: the same failed check with
    // both retries used, as `retry_tests` leaves a failed task
    // (`failure_awaits_person`). The host records no such ledger for a check.
    const ledger = placed(hostFacts.failureInCompletedRun());
    Object.assign(ledger.tasks[0], { retriesUsed: 2, failure: { kind: "check_failed", awaits: "person", because: "retries_used" } });
    const { a, drawnRows, line, attention, stage } = surfaces(ledger);
    expect(a).toMatchObject({ state: "failed", group: "needs", why: "Check failed", tone: "danger", decisions: 1 });
    expect(a.failure).toMatchObject({ askCoordinator: true });
    expect(a.failure!.note).toBe("Its 2 automatic retries are used. It cannot be started from here: ask the coordinator in its chat, or stop or archive the run.");
    expect(drawnRows[0]).toContain(`<span>${a.failure!.note}</span><button type="button" class="orch-task-ask-go">Open the coordinator&#x27;s chat</button>`);
    expect(drawnRows[0]).not.toContain(">Start retry<");
    expect(line).toBe("1 failed · 0/1 done");
    expect(attentionLabel(attention)).toBe("1 failed");
    expect(shownRunStatus(ledger.runs[0], ledger.tasks)).toBe("failed");
    expect(stage).toMatchObject({ stage: "review", blocked: true });
    const stages = runStages(ledger.tasks, ledger.attempts, null);
    expect(stages.find((item) => item.key === "acceptance")).toMatchObject({ value: "Failing", tone: "danger" });
  });

  it("beside a card of another kind the line says Needs you, and the failure is still said", () => {
    const ledger = placed(hostFacts.failureAwaitsPerson());
    const task = ledger.tasks[0];
    const held = new Map([[task.id, [{ key: "permission:p1", kind: "permission" }]]]);
    const scoped = chatSnapshot(ledger, MAIN);
    const picked = chatStrip(scoped, after(ledger), held)!;
    expect(picked.strip).toMatchObject({ state: "needs", needs: 2, failures: 1, failed: 1 });
    expect(picked.strip.side.map((item) => item.text)).toEqual(["2 decisions", "1 failed"]);
    expect(chatRunLine(scoped, rowRun(scoped, held)!, held)).toEqual({ text: "Needs you · 1 failed · 0/1 done", tone: "decide" });
    const waits = runWaits(ledger, ledger.runs[0], held);
    const attention = runAttention(ledger.runs[0], ledger.tasks, ledger.attempts, waits);
    expect([attentionLabel(attention), attentionTone(attention), attention.total]).toEqual(["2 to decide", "decision", 2]);
    // The card leads the row, where it is answered; the failure's sentence
    // is still on it, and both are counted.
    const row = runProgress(ledger, ledger.runs[0], after(ledger), held).rows[0];
    expect(row).toMatchObject({ state: "needs", group: "needs", why: "Awaiting approval", tone: "decide", decisions: 2 });
    expect(row.failure?.move).toBe("person");
  });
});

describe("a failure the coordinator is fixing, and one that is history, is no colour", () => {
  it("the coordinator's: its row says whose it is, in a sentence, and nothing asks", () => {
    const ledger = placed(hostFacts.failureAwaitsCoordinator());
    const { a, drawnRows, panelHtml, stage } = surfaces(ledger);
    expect(a.failure).toMatchObject({ move: "coordinator", askCoordinator: false, note: "Its coordinator is fixing it: 0 of 2 automatic retries used. Nothing is asked of you." });
    expect(a.flight).toBe(false);
    expect(drawnRows[0]).toContain('data-failure="coordinator"');
    expect(drawnRows[0]).not.toContain("orch-task-ask");
    expect(drawnRows[0]).toContain(`<p class="orch-task-hold" data-failure="coordinator">${a.failure!.note}</p>`);
    expect(panelHtml).not.toContain("Needs you");
    expect(panelHtml).not.toMatch(/\d+ failed/);
    expect(stage.blocked).toBe(false);
    // The strip says it in its tooltip only.
    const strip = chatStrip(chatSnapshot(ledger, MAIN), after(ledger))!.strip;
    expect(strip.notes).toEqual(["1 failure with the coordinator, which is fixing it: nothing is asked of you."]);
    expect(strip.live).toBe(false);
  });

  it("a failed check in a run the host calls completed is not history, and is not a failing colour", () => {
    const ledger = placed(hostFacts.failureInCompletedRun());
    const { drawnRows, stage } = surfaces(ledger);
    // The fail pill is still said, in the row's ink.
    expect(drawnRows[0]).toMatch(/class="run-row-pill" data-verdict="fail" data-quiet="true"/);
    expect(stage).toMatchObject({ stage: "review", blocked: false });
    const stages = runStages(ledger.tasks, ledger.attempts, null);
    expect(stages.find((item) => item.key === "acceptance")).toMatchObject({ value: "Failing", tone: "quiet" });
    expect(stages.find((item) => item.key === "checks")).toMatchObject({ value: "1 failed", tone: "quiet" });
    expect(workerLine(ledger.tasks[0], ledger.attempts[0])).toEqual({ text: `${ledger.tasks[0].title} · check failed`, tone: null });
    expect(boardCounts(ledger.tasks, ledger)).toMatchObject({ done: 0, blocked: 0 });
  });

  it("history: listed with what finished, muted, with its details", () => {
    const ledger = placed(hostFacts.failureInStoppedRun());
    const { a, drawnRows } = surfaces(ledger);
    expect(a.failure).toMatchObject({ move: "history", note: "Its run was stopped, closed or archived. Nothing is owed for it." });
    expect(drawnRows[0]).toContain('data-failure="history"');
    expect(drawnRows[0]).toContain('data-state="closed"');
    // Its run is over: no start is offered.
    expect(drawnRows[0]).not.toContain("Start retry");
  });

  it("the sheets take the status colour off both, after the status rules", () => {
    const rules = (sheet: string) => sheet.replace(/\/\*[\s\S]*?\*\//g, "");
    const panel = rules(runPanelCss);
    expect(panel).toMatch(/\.orch-task\[data-failure="coordinator"\],\s*\.orch-task\[data-failure="history"\]\s*\{\s*--task-color:\s*var\(--fg-3\);/);
    expect(panel.indexOf('.orch-task[data-failure="coordinator"]')).toBeGreaterThan(panel.indexOf('.orch-task[data-status="failed"]'));
    expect(panel.indexOf('.orch-task[data-failure="coordinator"]')).toBeGreaterThan(panel.indexOf('.orch-task[data-status="blocked"]'));
    expect(panel).toMatch(/\.orch-task\[data-failure="person"\]\s*\{\s*--task-color:\s*var\(--danger\);/);
    const rows = rules(runProgressCss);
    expect(rows).toMatch(/\.run-row-pill\[data-verdict="fail"\]\[data-quiet\]\s*\{[^}]*color:\s*var\(--fg-2\);/);
    // The sentence on the row is reading ink: no state colour, and it wraps.
    const ask = /\.orch-task-ask\s*\{([^}]*)\}/.exec(panel)![1];
    expect(ask).toMatch(/color:\s*var\(--fg-1\)/);
    expect(ask).toMatch(/overflow-wrap:\s*anywhere/);
    expect(ask).not.toMatch(/nowrap|--danger|--warn|--accent/);
  });
});

describe("whose move a failure is has one reader", () => {
  const task = (over: Partial<OrchestrationTask>) => ({ status: "failed", ...over }) as OrchestrationTask;

  it("says it of a host that says, and nothing of one that does not", () => {
    // [task, says, move, shown]. Written by hand.
    const table: [Partial<OrchestrationTask>, boolean, string, string | null][] = [
      // A host that does not say: read as before.
      [{ status: "failed" }, false, "unsaid", "red"],
      [{ status: "blocked" }, false, "unsaid", "red"],
      [{ status: "completed", verdict: "fail" }, false, "unsaid", "red"],
      [{ status: "failed", supersededBy: "t2" }, false, "unsaid", null],
      [{ status: "failed", stopped: { at: 1 } as OrchestrationTask["stopped"] }, false, "unsaid", null],
      [{ status: "running" }, false, "unsaid", null],
      // A failure sent with no `retryLimit` is not this host's contract.
      [{ status: "failed", failure: { kind: "failed", awaits: "coordinator" } }, false, "unsaid", "red"],
      // A host that says.
      [{ status: "failed", retryLimit: 2, failure: { kind: "failed", awaits: "coordinator" } }, true, "coordinator", "quiet"],
      [{ status: "failed", retryLimit: 2, failure: { kind: "failed", awaits: "person", because: "retries_used" } }, true, "person", "red"],
      [{ status: "failed", retryLimit: 2, failure: { kind: "failed", awaits: "nobody", because: "run_ended" } }, true, "history", "history"],
      [{ status: "completed", verdict: "fail", retryLimit: 2, failure: { kind: "check_failed", awaits: "coordinator" } }, true, "coordinator", "quiet"],
      // The person stopped it: the host sends no failure, and nothing failed.
      [{ status: "failed", retryLimit: 2, stopped: { at: 1 } as OrchestrationTask["stopped"] }, true, "none", null],
      [{ status: "running", retryLimit: 2, retrying: true }, true, "none", null],
      // A word this page does not know is not guessed at.
      [{ status: "failed", retryLimit: 2, failure: { kind: "failed", awaits: "somebody" as "person" } }, true, "unsaid", "red"],
    ];
    for (const [over, says, move, shown] of table) {
      const name = JSON.stringify(over);
      expect(saysFailures(task(over)), name).toBe(says);
      expect(failureMove(task(over)), name).toBe(move);
      expect(failureShown(task(over)), name).toBe(shown);
      expect(failureOf(task(over))?.move ?? null, name).toBe(["coordinator", "person", "history"].includes(move) ? move : null);
    }
    expect(isRetrying(task({ retrying: true }))).toBe(true);
    expect(isRetrying(task({}))).toBe(false);
  });

  it("never reads the run's status to call a failure history", () => {
    // The host's own: a failure that waits on the person in a run it calls
    // failed, and one its coordinator is fixing in a run it calls completed.
    for (const [ledger, move] of [[hostFacts.failureAwaitsPerson(), "person"], [hostFacts.failureInCompletedRun(), "coordinator"]] as const) {
      for (const status of ["planning", "running", "waiting", "completed", "failed"] as const) {
        const copy = placed(ledger);
        copy.runs[0].status = status;
        expect(runProgress(copy, copy.runs[0], after(copy)).rows[0].failure?.move, `${move} in a ${status} run`).toBe(move);
      }
    }
  });

  it("says in a sentence what moves a failure that waits on the person, for every reason the host gives", () => {
    const failed = (because: string | undefined, kind = "failed") =>
      ({ retryLimit: 2, retriesUsed: 2, failure: { kind, awaits: "person", ...(because ? { because } : {}) } }) as OrchestrationTask;
    const start = { label: "Start retry", blocked: null };
    const put = "stop or archive the run";
    expect(failureNote(failed("retries_used"), start, null)!.note).toBe(`Its 2 automatic retries are used. Open this row for Start retry, or ${put}.`);
    expect(failureNote(failed("coordinator_gone"), start, null)!.note).toBe(`The chat that coordinated this run is gone, so nobody retries it. Open this row for Start retry, or ${put}.`);
    // Its chat is gone: there is nobody to ask, and no way there is offered.
    expect(failureNote(failed("coordinator_gone", "check_failed"), null, null)).toMatchObject({
      askCoordinator: false, note: "The chat that coordinated this run is gone, so nobody retries it. Stop or archive the run to put it away.",
    });
    expect(failureNote(failed("time_limit"), start, null)!.note).toBe(`This peer request used up its working time. Open this row for Start retry, or ${put}.`);
    expect(failureNote(failed("escalated"), null, "Replace it?")!.note).toBe(`Its coordinator asks you: Replace it? Answer it under Needs you above, or ${put}.`);
    // A start the host would refuse says why, and that is what moves it.
    expect(failureNote(failed("retries_used"), { label: "Start retry", blocked: "The plan is with you." }, null)!.note).toBe("Its 2 automatic retries are used. The plan is with you.");
    // A reason this page does not know still ends in what moves it.
    expect(failureNote(failed(undefined), start, null)!.note).toBe(`This failure waits on you. Open this row for Start retry, or ${put}.`);
    // Every one of them is a whole sentence that ends in something to do.
    for (const because of ["retries_used", "escalated", "coordinator_gone", "time_limit", undefined]) {
      for (const offered of [start, null]) {
        const said = failureNote(failed(because), offered, null)!;
        expect(said.note, String(because)).toMatch(/(stop or archive the run|to put it away)\.$/i);
      }
    }
    // Not in failure, or a host that does not say: nothing to say.
    expect(failureNote({ retryLimit: 2 } as OrchestrationTask, start, null)).toBeNull();
    expect(failureNote({ failure: { kind: "failed", awaits: "person" } } as OrchestrationTask, start, null)).toBeNull();
  });
});

/* ---- Nobody else reads how a task ended --------------------------------- */

const SOURCES = import.meta.glob<string>("../**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true });

/** The code of a file, without its comments: a comment may say "completed". */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

type Allowed = Record<string, { uses: number; why: string }>;

/** Every file that may write the status word "completed" as a string, with
 *  how often and why. None of them asks whether a TASK is done: that is
 *  `orchestration.isSettled` / `checkFailed` / `finishedWell`, and a file
 *  that compares a task's status with the word itself is a second reader.
 *  The counts are exact: one more use in any of them fails this test, and
 *  so does a use anywhere else. */
const COMPLETED: Allowed = {
  "./orchestration.ts": { uses: 6, why: "the status types of a run, a task, an attempt and an execution; isSettled, the one comparison of a task's status with the word; and shownRunStatus, of a RUN the host calls completed while a failure in it is still somebody's move" },
  "./taskHold.ts": { uses: 2, why: "a RUN that completed offers no start, and an ATTEMPT that completed leaves a ready task its next attempt" },
  "./agentsDashboard.ts": { uses: 1, why: "a RUN that is over has no plan waiting" },
  "./missionPage.ts": { uses: 1, why: "a RUN that has ended hands no task on" },
  "../components/OrchestrationPanel.tsx": { uses: 1, why: "a RUN that completed offers to archive its workers" },
  "../components/TaskMeter.tsx": { uses: 1, why: "the mark for a status its caller chose with drawnStatus, which turns a failed check into failed first" },
  "./chat.ts": { uses: 2, why: "a tool call's own status in a transcript" },
  "./taskEvidence.ts": { uses: 1, why: "the rows of an agent's own todo list" },
  "./codexEvents.ts": { uses: 1, why: "a Codex stream item's status" },
  "./chatComplete.ts": { uses: 2, why: "the chat-completed event" },
  "./useChatCompletions.ts": { uses: 1, why: "the chat-completed event" },
  "./pullRequests.ts": { uses: 3, why: "a pull request workflow's completion" },
  "../components/PullRequestsDashboard.tsx": { uses: 2, why: "a pull request workflow's completion" },
};

/** Every file that may read a task's `verdict`. Whether a check FAILED is
 *  `orchestration.checkFailed` and nobody else's to work out; the rest draw
 *  or count the verdict as it was reported. */
const VERDICT: Allowed = {
  "./orchestration.ts": { uses: 1, why: "checkFailed, the one reader" },
  "./runProgress.ts": { uses: 1, why: "a settled row carries its verdict for the pill" },
  "./agentTaskBoard.ts": { uses: 1, why: "a check that finished well says passed, or that it has no verdict" },
  "./runAcceptance.ts": { uses: 4, why: "check coverage: verdicts counted as they were reported, a replaced check's included" },
  "../components/OrchestrationPanel.tsx": { uses: 7, why: "the row's pass / fail pill (4) and whether a fail pill is quiet (asked of failureShown), the chip of a REPLACED failed check, and a check's kind chip" },
};

/** Every file that may name what the host says of a task's failure: the
 *  task's `failure`, `retryLimit` and `retrying`, and a gate's
 *  `aboutTaskId`. Whose move a failure is is `orchestration.failureMove` and
 *  nobody else's to work out (its `awaits` is in the other scan, in
 *  `runWaits.surfaces.test`); the rest count retries for a sentence, hand a
 *  task on by type, or name the task a decision is about. */
const FAILURE: Allowed = {
  "./orchestration.ts": { uses: 12, why: "the types, and the readers: saysFailures, failureMove, failureOf, isRetrying, isFailureGate" },
  "./runWaits.ts": { uses: 3, why: "a gate about a failed task is that task's decision: tied to its row, counted once" },
  "./runProgress.ts": { uses: 2, why: "failureNote says how many automatic retries a task has, in its sentence" },
  "./chatWorkflow.ts": { uses: 1, why: "a type: what workerLine hands failureShown" },
  "../components/OrchestrationPanel.tsx": { uses: 1, why: "a decision's box names the task it is about" },
  "./codexEvents.ts": { uses: 2, why: "a Codex stream item's own failure message, which is no task" },
};

describe("how a task ended has one reader", () => {
  // A source scan is the only practical proof here: nothing at run time can
  // tell that a second function compared a status, only that the text does.
  const READS = {
    completed: /["'`]completed["'`]/g, verdict: /\.verdict\b/g,
    failure: /\b(?:task|item|other|candidate)\.failure\b|\bretryLimit\b|\.retrying\b|\baboutTaskId\b/g,
  };

  const found = (pattern: RegExp) => {
    const uses: Record<string, number> = {};
    for (const [path, text] of Object.entries(SOURCES)) {
      if (/\.test\.tsx?$/.test(path) || path.includes("/__fixtures__/")) continue;
      const count = code(text).match(pattern)?.length ?? 0;
      if (count) uses[path] = count;
    }
    return uses;
  };
  const exact = (allowed: Allowed) => Object.fromEntries(Object.entries(allowed).map(([path, rule]) => [path, rule.uses]));

  it("writes the word \"completed\" only where a run, an attempt or something that is no task is meant", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(300);
    expect(found(READS.completed)).toEqual(exact(COMPLETED));
  });

  it("reads a task's verdict only to draw or count it", () => {
    expect(found(READS.verdict)).toEqual(exact(VERDICT));
  });

  it("reads what the host says of a failure only through the readers", () => {
    expect(found(READS.failure)).toEqual(exact(FAILURE));
  });

  it("catches a reader written the usual ways", () => {
    for (const line of [
      "const done = tasks.filter((task) => task.status === \"completed\").length;",
      "if (task.status !== 'completed') return null;",
      "if ([\"completed\", \"cancelled\"].includes(task.status)) return null;",
      "const settled = row.task.status == `completed`;",
    ]) expect(code(line).match(READS.completed), line).not.toBeNull();
    for (const line of [
      "if (task.verdict === \"fail\") return \"failed\";",
      "const bad = tasks.filter((item) => item.verdict !== 'pass');",
    ]) expect(code(line).match(READS.verdict), line).not.toBeNull();
    for (const line of [
      "if (task.failure?.awaits === \"person\") return \"failed\";",
      "const quiet = tasks.filter((item) => item.failure && item.retriesUsed < 2);",
      "const old = typeof task.retryLimit !== 'number';",
      "if (row.task.retrying) return \"Retrying\";",
      "const about = gates.find((gate) => gate.aboutTaskId === id);",
    ]) expect(code(line).match(READS.failure), line).not.toBeNull();
    // A row's own reading and a wait's flag are not the host's fact.
    expect(code("const mine = row.failure?.move; const own = waits.person.filter((wait) => wait.failure);").match(READS.failure)).toBeNull();
    // A comment, a record's key and a type's field are not readers.
    expect(code("// status === \"completed\" is not done\nconst LABELS = { completed: \"Done\" };").match(READS.completed)).toBeNull();
    expect(code("type Row = { verdict: \"pass\" | \"fail\" | null }; /* task.verdict */").match(READS.verdict)).toBeNull();
  });
});
