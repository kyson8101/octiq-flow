import { describe, expect, it, vi } from "vitest";

vi.mock("./bridge", () => ({ bridge: { invoke: async () => [] } }));
import {
  agentRoster, orgChart, pendingPlan, rosterSummary, teamBadge, workingTaskCount,
  type ChatActivity, type LeadRecord, type RosterInput,
} from "./agentsDashboard";
import {
  EMPTY_ORCHESTRATION,
  type OrchestrationAttempt, type OrchestrationRun, type OrchestrationSnapshot, type OrchestrationTask,
} from "./orchestration";
import type { TeamAgent } from "./agentsMode";

const agent = (id: string, name: string, over: Partial<TeamAgent> = {}): TeamAgent => ({
  id, name, role: "", agent: "claude", model: "sonnet", access: "auto", createdAt: 1, updatedAt: 1, ...over,
});

const run = (over: Partial<OrchestrationRun> = {}): OrchestrationRun => ({
  id: "run_1", objective: "Ship", coordinatorChatKey: "chat:lead", workspaceId: "home", rootPath: "/r",
  status: "running", maxConcurrent: 2, createdAt: 1, updatedAt: 1,
  planApproval: { status: "approved", requestedAt: 1, decidedAt: 2 }, ...over,
});

const task = (id: string, status: OrchestrationTask["status"], assignee?: string, over: Partial<OrchestrationTask> = {}): OrchestrationTask => ({
  id, runId: "run_1", title: `Task ${id}`, spec: "", dependsOn: [], status, createdAt: 1, updatedAt: 1,
  ...(assignee ? { assignee: { id: assignee, name: assignee } } : {}), ...over,
});

const attempt = (taskId: string, over: Partial<OrchestrationAttempt> = {}): OrchestrationAttempt => ({
  id: `att_${taskId}`, runId: "run_1", taskId, number: 1, workerChatKey: `chat:orch-${taskId}`,
  agent: "claude", access: "auto", status: "running", cwd: "/w", branch: "b", isWorktree: true,
  filesModified: [], createdAt: 1, updatedAt: 5, ...over,
});

const PROJECTS = [{ id: "p1", name: "octiq-flow" }, { id: "p2", name: "pandahrms" }, { id: "home", name: "General" }];

function roster(over: Partial<RosterInput> = {}) {
  const chats = new Set(["chat:lead", "chat:head", "chat:orch-a", "chat:orch-b", "chat:orch-c"]);
  return agentRoster({
    team: [agent("ada", "Ada"), agent("bo", "Bo", { projectId: "p1" }), agent("cy", "Cy", { projectId: "p2" })],
    leads: [],
    snapshot: EMPTY_ORCHESTRATION,
    projects: PROJECTS,
    providerLabel: (a) => `Claude ${a.model}`,
    chatTitle: () => undefined,
    chatExists: (key) => chats.has(key),
    leadActivity: () => "ended",
    waitingOn: () => 0,
    ...over,
  });
}

const snap = (over: Partial<OrchestrationSnapshot>): OrchestrationSnapshot => ({ ...EMPTY_ORCHESTRATION, runs: [run()], ...over });
const byId = (rows: ReturnType<typeof roster>) => Object.fromEntries(rows.map((row) => [row.id, row]));

describe("agents dashboard", () => {
  it("badges each agent with its peer-help team and leaves the chart alone", () => {
    const teams = [{ id: "team_web", name: "Web", createdAt: 1, updatedAt: 1 }];
    const rows = byId(roster({
      team: [
        agent("ada", "Ada", { teamId: "team_web" }),
        agent("bo", "Bo", { reportsTo: "ada", teamId: "team_web" }),
        agent("cy", "Cy", { teamId: "team_gone" }),
        agent("di", "Di"),
      ],
      teams,
    }));
    expect(rows.ada.team).toEqual({ id: "team_web", name: "Web" });
    expect(rows.bo.team).toEqual({ id: "team_web", name: "Web" });
    // A removed team, or none at all, draws no badge.
    expect(rows.cy.team).toBeNull();
    expect(rows.di.team).toBeNull();
    // Same team, same place in the chart as without one.
    expect(rows.bo.depth).toBe(1);
    // An older backend sends no teams: nobody has a badge.
    expect(byId(roster({ team: [agent("ada", "Ada", { teamId: "team_web" })] })).ada.team).toBeNull();
    expect(teamBadge({ teamId: "team_web" }, teams)).toEqual({ id: "team_web", name: "Web" });
    expect(teamBadge({}, teams)).toBeNull();
  });

  it("draws the chart top-down with reports under their manager", () => {
    const rows = orgChart([
      agent("dev", "Dev", { reportsTo: "cto" }),
      agent("cto", "Cto", { reportsTo: "ceo" }),
      agent("ceo", "Ceo"),
      agent("ops", "Ops"),
      // A manager this list cannot see leaves its report at the top.
      agent("orphan", "Orphan", { reportsTo: "elsewhere" }),
    ]);
    expect(rows.map((row) => `${row.depth}:${row.agent.name}`)).toEqual([
      "0:Ceo", "1:Cto", "2:Dev", "0:Ops", "0:Orphan",
    ]);
  });

  it("lists every agent across projects, including ones with no work, as idle", () => {
    const rows = roster();
    expect(rows.map((row) => [row.name, row.scope?.name ?? "all", row.state])).toEqual([
      ["Ada", "all", "idle"], ["Bo", "octiq-flow", "idle"], ["Cy", "pandahrms", "idle"],
    ]);
    expect(rosterSummary(rows)).toEqual([{ state: "idle", count: 3 }]);
  });

  it("says nothing until the roster has loaded, and unknown until the ledger has", () => {
    expect(roster({ team: null })).toEqual([]);
    const rows = roster({ snapshot: null });
    expect(rows.every((row) => row.state === "unknown" && row.stateLabel === "Work not loaded")).toBe(true);
  });

  it("never calls a task that has not started working", () => {
    const rows = byId(roster({ snapshot: snap({ tasks: [task("a", "pending", "ada"), task("b", "ready", "bo")] }) }));
    expect(rows.ada).toMatchObject({ state: "queued", stateLabel: "Queued" });
    expect(rows.bo).toMatchObject({ state: "queued", stateLabel: "Ready to start" });
    // Running as the ledger has it, but the worker is still preparing.
    const preparing = byId(roster({ snapshot: snap({ tasks: [task("a", "running", "ada", { activeAttemptId: "att_a" })],
      attempts: [attempt("a", { status: "preparing" })] }) }));
    expect(preparing.ada).toMatchObject({ state: "queued", stateLabel: "Preparing workspace" });
  });

  it("reads working, stalled and disconnected off the attempt's execution", () => {
    const at = (state: NonNullable<OrchestrationAttempt["execution"]>["state"]) => byId(roster({ snapshot: snap({
      tasks: [task("a", "running", "ada", { activeAttemptId: "att_a" })],
      attempts: [attempt("a", { execution: { state, retryCount: 0 } })],
    }) })).ada;
    expect(at("executing")).toMatchObject({ state: "working", stateLabel: "Executing" });
    expect(at("waiting_tool")).toMatchObject({ state: "working", stateLabel: "Running a tool" });
    expect(at("stalled")).toMatchObject({ state: "stalled" });
    expect(at("retrying")).toMatchObject({ state: "stalled", stateLabel: "Retrying" });
    expect(at("capacity_blocked")).toMatchObject({ state: "blocked" });
    expect(at("disconnected")).toMatchObject({ state: "unknown", stateLabel: "Disconnected" });
    expect(at("queued")).toMatchObject({ state: "queued" });
  });

  it("puts a person-only wait ahead of everything but work, and names it", () => {
    const gated = byId(roster({ snapshot: snap({
      tasks: [task("a", "running", "ada", { activeAttemptId: "att_a" })],
      attempts: [attempt("a", { status: "blocked" })],
      gates: [{ id: "g", runId: "run_1", taskId: "a", createdByChatKey: "chat:orch-a", targetChatKey: "chat:lead",
        question: "?", options: [], status: "open", createdAt: 1, updatedAt: 1 }],
    }) }));
    expect(gated.ada).toMatchObject({ state: "needs_you", stateLabel: "Waiting on a decision" });
    const carded = byId(roster({
      snapshot: snap({ tasks: [task("a", "running", "ada", { activeAttemptId: "att_a" })],
        attempts: [attempt("a", { execution: { state: "waiting_tool", retryCount: 0 } })] }),
      waitingOn: (key) => key === "chat:orch-a" ? 1 : 0,
    }));
    expect(carded.ada).toMatchObject({ state: "needs_you", stateLabel: "Needs your approval" });
  });

  it("holds several tasks at once: working leads, the rest are counted", () => {
    const rows = byId(roster({ snapshot: snap({
      tasks: [
        task("a", "running", "ada", { activeAttemptId: "att_a", updatedAt: 3 }),
        task("b", "blocked", "ada"),
        task("c", "pending", "ada"),
      ],
      attempts: [attempt("a", { execution: { state: "executing", retryCount: 0 } })],
    }) }));
    expect(rows.ada.state).toBe("working");
    expect(rows.ada.counts).toEqual({ working: 1, blocked: 1, queued: 1 });
    // Its own list puts what is owed first.
    expect(rows.ada.activities.map((a) => a.taskId)).toEqual(["b", "a", "c"]);
  });

  it("leaves history out: settled tasks and stopped, finished or archived runs", () => {
    const rows = byId(roster({ snapshot: {
      ...EMPTY_ORCHESTRATION,
      runs: [run({ id: "stopped", status: "stopped" }), run({ id: "done", status: "completed" }), run({ id: "gone", archivedAt: 9 })],
      tasks: [
        task("a", "blocked", "ada", { runId: "stopped" }),
        task("b", "failed", "ada", { runId: "done" }),
        task("c", "running", "ada", { runId: "gone" }),
        task("d", "completed", "bo"),
      ],
    } }));
    expect(rows.ada.state).toBe("idle");
    expect(rows.ada.activities).toEqual([]);
    expect(rows.bo.state).toBe("idle");
  });

  it("holds tasks of a plan awaiting approval as waiting, and the lead as the one who needs you", () => {
    const leads: LeadRecord[] = [{ chatKey: "chat:lead", leadId: "ada", leadName: "Ada", projectId: "p1", createdAt: 1 }];
    const rows = byId(roster({
      leads,
      snapshot: snap({ runs: [run({ planApproval: { status: "pending", requestedAt: 1 } })], tasks: [task("a", "pending", "bo")] }),
    }));
    expect(rows.ada).toMatchObject({ state: "needs_you", stateLabel: "Plan awaiting approval" });
    expect(rows.ada.activities[0]).toMatchObject({ kind: "lead", chatKey: "chat:lead", project: { name: "octiq-flow" } });
    expect(rows.bo).toMatchObject({ state: "queued", stateLabel: "Waiting for plan approval" });
  });

  it("reads a direct lead conversation's turn: working while busy, idle once it ends", () => {
    const leads: LeadRecord[] = [
      { chatKey: "chat:head", leadId: "ada", leadName: "Ada", projectId: "home", crossProject: true, createdAt: 4 },
    ];
    const withActivity = (activity: ChatActivity) => byId(roster({
      leads, snapshot: EMPTY_ORCHESTRATION,
      chatTitle: (key) => key === "chat:head" ? "Plan the week" : undefined,
      leadActivity: () => activity,
    })).ada;
    expect(withActivity("busy")).toMatchObject({ state: "working", stateLabel: "In conversation" });
    expect(withActivity("busy").activities[0]).toMatchObject({ title: "Plan the week", crossProject: true, project: null });
    const ended = withActivity("ended");
    expect(ended.state).toBe("idle");
    // Still one way back into what it last did.
    expect(ended.recent).toMatchObject({ chatKey: "chat:head", title: "Plan the week" });
    expect(withActivity("idle").state).toBe("idle");
    expect(withActivity("unknown")).toMatchObject({ state: "unknown", stateLabel: "Session open" });
  });

  it("keeps a lead conversation's evidence even when the ledger never loaded", () => {
    const leads: LeadRecord[] = [{ chatKey: "chat:lead", leadId: "bo", leadName: "Bo", projectId: "p1", createdAt: 1 }];
    const rows = byId(roster({ leads, snapshot: null, leadActivity: () => "busy" }));
    expect(rows.bo.state).toBe("working");
    expect(rows.ada.state).toBe("unknown");
  });

  it("ignores a lead record whose conversation was deleted", () => {
    const leads: LeadRecord[] = [{ chatKey: "chat:deleted", leadId: "ada", leadName: "Ada", projectId: "p1", createdAt: 1 }];
    const rows = byId(roster({ leads, leadActivity: () => "busy" }));
    expect(rows.ada.state).toBe("idle");
  });

  it("keeps a role whole and apart from what the agent runs on", () => {
    const role = "Leave module lead.\n\nOwns the rules, " + "and reviews every change; ".repeat(60);
    const rows = byId(roster({ team: [agent("ada", "Ada", { role, agent: "codex", model: "gpt-5" })] }));
    expect(rows.ada.role).toBe(role);
    expect(rows.ada.detail).toBe("Claude gpt-5");
  });

  it("names each agent's effort and the registered agent it reports to", () => {
    const rows = byId(roster({
      team: [
        agent("ada", "Ada", { effort: "high" }),
        agent("bo", "Bo", { reportsTo: "ada", effort: "medium" }),
        // A manager that is no longer registered: it reports to nobody here.
        agent("cy", "Cy", { reportsTo: "gone" }),
      ],
    }));
    expect(rows.ada).toMatchObject({ effort: "high", reportsTo: null });
    expect(rows.bo).toMatchObject({ effort: "medium", reportsTo: { id: "ada", name: "Ada" } });
    expect(rows.cy).toMatchObject({ effort: null, reportsTo: null });
  });

  it("maps work by id through a rename, and shows the real destination project", () => {
    const rows = byId(roster({
      team: [agent("ada", "Ada Lovelace", { agent: "codex", model: "gpt-5" })],
      snapshot: snap({
        tasks: [
          task("a", "running", "ada", { activeAttemptId: "att_a", destination: { projectId: "p2", projectName: "old name", repository: "/r" } }),
          task("b", "pending", "ada"),
        ],
        attempts: [attempt("a")],
      }),
    }));
    expect(rows.ada.name).toBe("Ada Lovelace");
    expect(rows.ada.detail).toBe("Claude gpt-5");
    expect(rows.ada.role).toBe("");
    const [working, queued] = rows.ada.activities;
    expect(working).toMatchObject({ project: { id: "p2", name: "pandahrms" }, chatKey: "chat:orch-a" });
    // No destination recorded: no project is guessed.
    expect(queued).toMatchObject({ project: null, chatKey: null, runId: "run_1" });
  });

  it("keeps a removed agent visible only while it still holds current work", () => {
    const rows = roster({ snapshot: snap({
      tasks: [task("a", "running", "ghost", { activeAttemptId: "att_a" }), task("b", "completed", "gone")],
      attempts: [attempt("a")],
    }) });
    const ghost = rows.find((row) => row.id === "ghost");
    expect(ghost).toMatchObject({ removed: true, state: "working", name: "ghost" });
    expect(rows.some((row) => row.id === "gone")).toBe(false);
  });

  it("finds the plan waiting in this chat, and only a live one", () => {
    const pending = run({ planApproval: { status: "pending", requestedAt: 1 } });
    const snapshot: OrchestrationSnapshot = { ...EMPTY_ORCHESTRATION, runs: [pending], tasks: [task("a", "ready", "ada")] };
    expect(pendingPlan(snapshot, "chat:lead")?.tasks).toHaveLength(1);
    expect(pendingPlan(snapshot, "chat:other")).toBeNull();
    expect(pendingPlan({ ...snapshot, runs: [{ ...pending, status: "stopped" }] }, "chat:lead")).toBeNull();
    expect(pendingPlan({ ...snapshot, runs: [run()] }, "chat:lead")).toBeNull();
  });
});

describe("working tasks, for the chat row's running ring", () => {
  const executing = (taskId: string, state: NonNullable<OrchestrationAttempt["execution"]>["state"] = "executing", over: Partial<OrchestrationAttempt> = {}) =>
    attempt(taskId, { execution: { state, retryCount: 0 }, ...over });
  const none = () => 0;

  it("follows one task from queued through executing to each way it can end", () => {
    const at = (status: OrchestrationTask["status"], attempts: OrchestrationAttempt[] = []) =>
      workingTaskCount(snap({ tasks: [task("a", status)], attempts }), none);
    expect(at("pending")).toBe(0);
    expect(at("ready")).toBe(0);
    expect(at("running", [executing("a", "queued")])).toBe(0);
    expect(at("running", [attempt("a", { status: "preparing" })])).toBe(0);
    expect(at("running", [executing("a")])).toBe(1);
    expect(at("running", [executing("a", "waiting_tool")])).toBe(1);
    // An older backend's attempt carries no execution; its status speaks.
    expect(at("running", [attempt("a")])).toBe(1);
    expect(at("running", [executing("a", "retrying")])).toBe(0);
    expect(at("running", [executing("a", "stalled")])).toBe(0);
    expect(at("running", [executing("a", "awaiting_report")])).toBe(0);
    expect(at("completed", [executing("a", "completed", { status: "completed" })])).toBe(0);
    expect(at("failed", [executing("a", "failed", { status: "failed" })])).toBe(0);
    expect(at("cancelled", [executing("a", "cancelled", { status: "cancelled" })])).toBe(0);
    expect(at("blocked", [executing("a", "blocked", { status: "blocked" })])).toBe(0);
  });

  it("does not count a worker waiting on the person, by card or by decision", () => {
    const snapshot = snap({ tasks: [task("a", "running")], attempts: [executing("a", "waiting_tool")] });
    expect(workingTaskCount(snapshot, (taskId) => taskId === "a" ? 1 : 0)).toBe(0);
    const gate = { id: "g", runId: "run_1", taskId: "a", createdByChatKey: "chat:orch-a", targetChatKey: "chat:lead",
      question: "Which?", options: [], status: "open" as const, createdAt: 1, updatedAt: 1 };
    expect(workingTaskCount({ ...snapshot, gates: [gate] }, none)).toBe(0);
    expect(workingTaskCount({ ...snapshot, gates: [{ ...gate, status: "resolved" }] }, none)).toBe(1);
  });

  it("reads the task's current attempt, not an earlier one still marked running", () => {
    const tasks = [task("a", "running", undefined, { activeAttemptId: "att_new" })];
    const attempts = [executing("a", "executing", { id: "att_old", number: 1 }), executing("a", "queued", { id: "att_new", number: 2 })];
    expect(workingTaskCount(snap({ tasks, attempts }), none)).toBe(0);
  });

  it("counts across several runs and keeps counting while any task still works", () => {
    const tasks = [task("a", "running"), task("b", "running", undefined, { runId: "run_2" }), task("c", "ready"), task("d", "completed")];
    const attempts = [executing("a"), executing("b", "executing", { runId: "run_2" })];
    const both = snap({ runs: [run(), run({ id: "run_2" })], tasks, attempts });
    expect(workingTaskCount(both, none)).toBe(2);
    // One finishes; the other still holds the ring.
    const one = { ...both, tasks: [{ ...tasks[0], status: "completed" as const }, ...tasks.slice(1)] };
    expect(workingTaskCount(one, none)).toBe(1);
  });

  it("ignores work left behind in a run that is over or put away", () => {
    const tasks = [task("a", "running")];
    const attempts = [executing("a")];
    for (const status of ["completed", "failed", "stopped"] as const) {
      expect(workingTaskCount(snap({ runs: [run({ status })], tasks, attempts }), none)).toBe(0);
    }
    expect(workingTaskCount(snap({ runs: [run({ archivedAt: 9 })], tasks, attempts }), none)).toBe(0);
    expect(workingTaskCount(snap({ runs: [], tasks, attempts }), none)).toBe(0);
  });
});
