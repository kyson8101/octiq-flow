import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { projectTaskCounts, projectTasks } from "../lib/projectTasks";
import type { Conversation } from "../lib/store";
import { ProjectsPage } from "./ProjectsPage";
import type { Project } from "./Sidebar";
import type { OrchestrationSnapshot } from "../lib/orchestration";

const projects: Project[] = [
  { id: "p1", name: "octiq-flow", primary_path: "/work/octiq-flow" },
  { id: "p2", name: "starfall-social" },
];
const shelved: Project[] = [{ id: "p3", name: "old-site" }];

const chat = (id: string, projectId: string, updatedAt: number, extra: Partial<Conversation> = {}): Conversation => ({
  id, projectId, title: `Task ${id}`, messages: [], createdAt: 1, updatedAt, ...extra,
});

const conversations = [
  chat("open", "p1", 300),
  chat("ticked", "p1", 100, { doneAt: 500 }),
  chat("saved", "p1", 200, { pinned: true }),
  chat("elsewhere", "p2", 900),
];

function html(over: Partial<Parameters<typeof ProjectsPage>[0]> = {}) {
  return renderToStaticMarkup(<ProjectsPage
    projects={projects} shelved={shelved} conversations={conversations}
    selectedProjectId={null} busy={new Set()} chatParents={new Map()}
    onSelectProject={() => {}} onOpenChat={() => {}} onNewTask={() => {}}
    onNewProject={() => {}} onProjectSettings={() => {}} onClose={() => {}}
    {...over}
  />);
}

describe("projectTasks", () => {
  it("lists every chat in the project whatever its view, newest first", () => {
    expect(projectTasks(conversations, "p1").map((c) => c.id)).toEqual(["open", "saved", "ticked"]);
    expect(projectTasks(conversations, "p3")).toEqual([]);
  });

  it("counts chats per project", () => {
    const counts = projectTaskCounts(conversations);
    expect(counts.get("p1")).toBe(3);
    expect(counts.get("p2")).toBe(1);
    expect(counts.get("p3")).toBeUndefined();
  });

  it("discovers one pinned coordinator through every completed task destination", () => {
    const coordinator = chat("cto", "general", 400, { pinned: true, customTitle: true });
    const ledger: OrchestrationSnapshot = {
      runs: [
        { id: "old", coordinatorChatKey: "chat:cto", objective: "Old", workspaceId: "general", rootPath: "/General", status: "completed", maxConcurrent: 2, createdAt: 1, updatedAt: 2 },
        { id: "new", coordinatorChatKey: "chat:cto", objective: "New", workspaceId: "general", rootPath: "/General", status: "completed", maxConcurrent: 2, createdAt: 3, updatedAt: 4 },
      ],
      tasks: [
        { id: "a", runId: "old", title: "A", spec: "A", destination: { projectId: "p1", projectName: "octiq-flow", repository: "/p1" }, dependsOn: [], status: "completed", createdAt: 1, updatedAt: 2 },
        { id: "b", runId: "new", title: "B", spec: "B", destination: { projectId: "p2", projectName: "starfall-social", repository: "/p2" }, dependsOn: [], status: "completed", createdAt: 3, updatedAt: 4 },
      ],
      attempts: [], gates: [], messages: [],
    };
    const keys = new Set(["chat:cto"]);
    expect(projectTasks([...conversations, coordinator], "p1", ledger, keys).map((item) => item.id))
      .toEqual(["cto", "open", "saved", "ticked"]);
    expect(projectTasks([...conversations, coordinator], "p2", ledger, keys).map((item) => item.id))
      .toEqual(["elsewhere", "cto"]);
    expect(projectTasks([...conversations, coordinator], "general", ledger, keys)).toEqual([]);
    expect(projectTaskCounts([...conversations, coordinator], ledger, keys).get("p1")).toBe(4);
    expect(coordinator.pinned).toBe(true);
    expect(coordinator.customTitle).toBe(true);
  });
});

describe("ProjectsPage", () => {
  it("lists projects with their task counts, shelved ones apart", () => {
    const out = html();
    expect(out).toContain('aria-label="Projects"');
    expect(out).toContain(">Projects</h1>");
    expect(out).toContain('aria-label="octiq-flow, 3 tasks"');
    expect(out).toContain('aria-label="starfall-social, 1 task"');
    expect(out).toContain("/work/octiq-flow</span>");
    expect(out.indexOf("Shelved</h2>")).toBeGreaterThan(out.indexOf("starfall-social"));
    expect(out).toContain('aria-label="old-site, 0 tasks"');
    expect(out).toContain('aria-label="Back to chat"');
  });

  it("lists every task in the chosen project, ticked and pinned ones included", () => {
    const out = html({ selectedProjectId: "p1", busy: new Set(["open"]) });
    expect(out).toContain(">octiq-flow</h1>");
    expect(out).toContain("3 tasks</h2>");
    expect(out).toContain('aria-label="Tasks in octiq-flow"');
    expect(out.indexOf("Task open")).toBeLessThan(out.indexOf("Task saved"));
    expect(out.indexOf("Task saved")).toBeLessThan(out.indexOf("Task ticked"));
    expect(out).not.toContain("Task elsewhere");
    expect(out).toContain('aria-label="Task open, Working"');
    expect(out).toContain('aria-label="Task saved, Pinned"');
    expect(out).toContain('aria-label="Task ticked, Done"');
    expect(out).toContain(">Projects</span>");
  });

  it("finds the same canonical coordinator on each linked project page", () => {
    const coordinator = chat("cto", "general", 500, { pinned: true, title: "Coordinate launch" });
    const ledger: OrchestrationSnapshot = {
      runs: [{ id: "run", coordinatorChatKey: "chat:cto", objective: "Launch", workspaceId: "general", rootPath: "/General", status: "completed", maxConcurrent: 2, createdAt: 1, updatedAt: 2 }],
      tasks: ["p1", "p2"].map((projectId, index) => ({ id: `task-${index}`, runId: "run", title: projectId, spec: projectId, dependsOn: [], status: "completed" as const, createdAt: 1, updatedAt: index,
        destination: { projectId, projectName: projectId, repository: `/work/${projectId}` } })),
      attempts: [], gates: [], messages: [],
    };
    const shared = { conversations: [...conversations, coordinator], ledgerSnapshot: ledger, coordinatorChatKeys: new Set(["chat:cto"]) };
    expect(html({ ...shared, selectedProjectId: "p1" })).toContain("Coordinate launch");
    expect(html({ ...shared, selectedProjectId: "p2" })).toContain("Coordinate launch");
    expect(html({ ...shared, selectedProjectId: "p1" }).match(/Coordinate launch/g)).toHaveLength(2);
  });

  it("removes project-level task creation in agents mode", () => {
    const out = html({ selectedProjectId: "p2", conversations: [], allowNewTask: false });
    expect(out).toContain("No tasks in starfall-social yet.");
    expect(out).not.toContain("New task");
    expect(out).not.toContain("Start a task");
  });

  it("neither lists nor counts a run's workers, mapped or still loading", () => {
    const withWorkers = [
      ...conversations,
      chat("legacy-worker", "p1", 999, { pinned: true }), // mapped by the ledger, no orch- prefix
      chat("orch-abc123", "p1", 998), // ledger not loaded yet: the reserved prefix alone
    ];
    const list = html({ conversations: withWorkers, chatParents: new Map([["legacy-worker", "open"]]) });
    expect(list).toContain('aria-label="octiq-flow, 3 tasks"');
    const tasks = html({ selectedProjectId: "p1", conversations: withWorkers, chatParents: new Map([["legacy-worker", "open"]]) });
    expect(tasks).toContain("3 tasks</h2>");
    expect(tasks).not.toContain("legacy-worker");
    expect(tasks).not.toContain("orch-abc123");
    expect(tasks).not.toContain("Agent");
  });

  it("says a project has no tasks yet and offers to start one", () => {
    const out = html({ selectedProjectId: "p2", conversations: [] });
    expect(out).toContain("No tasks in starfall-social yet.");
    expect(out).toContain("Start a task</button>");
    expect(out).not.toContain("projects-task-list");
  });

  it("does not offer a new task in a shelved project", () => {
    const out = html({ selectedProjectId: "p3" });
    expect(out).toContain("No tasks in old-site yet.");
    expect(out).not.toContain("Start a task");
    expect(out).not.toContain("New task</span>");
    expect(out).toContain("Project settings</button>");
  });

  it("owns New project and the shelf, which left the sidebar", () => {
    const out = html({ onShowShelved: () => {}, onRestoreProject: async () => {} });
    expect(out).toContain("New project</span>");
    expect(out).toContain('aria-label="Shelved projects"');
    expect(out).toContain("Restore shelved projects</button>");
  });

  it("offers Restore on a shelved project's page, and only there", () => {
    const shelvedPage = html({ selectedProjectId: "p3", onRestoreProject: async () => {} });
    expect(shelvedPage).toContain("Restore project</span>");
    const livePage = html({ selectedProjectId: "p1", onRestoreProject: async () => {} });
    expect(livePage).not.toContain("Restore project");
  });

  it("explains a project that is gone instead of listing nothing", () => {
    const out = html({ selectedProjectId: "missing" });
    expect(out).toContain("Project unavailable</h1>");
    expect(out).toContain("Show all projects</button>");
  });
});
