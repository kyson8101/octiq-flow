// One question, every surface: did this task finish well?
//
// A task finished well when it completed and its check did not fail. A
// completed task whose check failed is a failure everywhere a failure is
// shown: present, named as a failed check, in the danger colour, counted as
// failed and never as done. This file is the proof. Five ledgers, each with
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
import { checkFailed, finishedWell, isSettled, type OrchestrationSnapshot, type OrchestrationTask } from "./orchestration";
import { runStages } from "./runAcceptance";
import { attentionLabel, attentionSpoken, attentionTone, runAttention, runPeople } from "./runPanel";
import { chatStrip, planStandsIn, runCounts, runProgress, runTally } from "./runProgress";
import { runWaits } from "./runWaits";
import { STOPPED_LABEL } from "./taskHold";
import { OrchestrationPanel } from "../components/OrchestrationPanel";
import { RunProgressStrip } from "../components/RunProgressStrip";
import { drawnStatus } from "../components/TaskMeter";
import agentsCss from "../components/AgentsDashboard.css?raw";
import workflowBarCss from "../components/ChatWorkflowBar.css?raw";
import missionCss from "../components/MissionPage.css?raw";
import runPanelCss from "../components/OrchestrationPanel.css?raw";

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
  // The Agents page lists current work, and a run the host calls completed,
  // failed or stopped is history there for every kind of failure alike. The
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
  "./orchestration.ts": { uses: 5, why: "the status types of a run, a task, an attempt and an execution, and isSettled: the one comparison of a task's status with the word" },
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
  "../components/OrchestrationPanel.tsx": { uses: 6, why: "the row's pass / fail pill (4), the chip of a REPLACED failed check, and a check's kind chip" },
};

describe("how a task ended has one reader", () => {
  // A source scan is the only practical proof here: nothing at run time can
  // tell that a second function compared a status, only that the text does.
  const READS = { completed: /["'`]completed["'`]/g, verdict: /\.verdict\b/g };

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
    // A comment, a record's key and a type's field are not readers.
    expect(code("// status === \"completed\" is not done\nconst LABELS = { completed: \"Done\" };").match(READS.completed)).toBeNull();
    expect(code("type Row = { verdict: \"pass\" | \"fail\" | null }; /* task.verdict */").match(READS.verdict)).toBeNull();
  });
});
