import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { projectTaskCounts, projectTasks } from "../lib/projectTasks";
import type { Conversation } from "../lib/store";
import { ProjectsPage } from "./ProjectsPage";
import type { Project } from "./Sidebar";

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

  it("marks an agent's chat as one", () => {
    const out = html({ selectedProjectId: "p1", chatParents: new Map([["saved", "open"]]) });
    expect(out).toContain('aria-label="Task saved, Pinned, Agent"');
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

  it("explains a project that is gone instead of listing nothing", () => {
    const out = html({ selectedProjectId: "missing" });
    expect(out).toContain("Project unavailable</h1>");
    expect(out).toContain("Show all projects</button>");
  });
});
