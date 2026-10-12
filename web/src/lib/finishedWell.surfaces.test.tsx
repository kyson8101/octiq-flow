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
import { chatRunStatus, chatSnapshot, rowRun } from "./chatWorkflow";
import { hostFacts } from "./__fixtures__/hostFacts";
import { missionState } from "./mission";
import { missionCrew } from "./missionPage";
import type { OrchestrationSnapshot } from "./orchestration";
import { runAttention, runPeople } from "./runPanel";
import { chatStrip, planStandsIn, runProgress } from "./runProgress";
import { runWaits } from "./runWaits";
import { STOPPED_LABEL } from "./taskHold";
import { OrchestrationPanel } from "../components/OrchestrationPanel";
import { RunProgressStrip } from "../components/RunProgressStrip";

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
  const label = /<span class="run-strip-label">(?:Tasks|Done ·) (\d+)\/(\d+)<\/span>/.exec(stripHtml);

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
    expect(line).toBe(plan ? `Needs decision · 1 failed · 0/${total} done` : `1 failed · 0/${total} done`);
  });

  it.each(FAILURES)("$name: the run's attention count, its people and a mission's crew say it", ({ ledger, plan }) => {
    const { attention, people, crew } = surfaces(ledger);
    expect(attention).toMatchObject({ blocked: 1, decisions: plan ? 1 : 0 });
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
    expect(line).toBe(plan ? `Needs decision · 0/${total} done` : `Running · 0/${total} done`);
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
    expect(line).toBe(plan ? `Needs decision · 1/${total} done` : `Running · 1/${total} done`);
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
