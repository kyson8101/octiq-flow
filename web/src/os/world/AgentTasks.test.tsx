import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AgentTasks, tasksForAgent } from "./AgentTasks";
import { AgentInspector } from "./Inspectors";
import { TaskWorkspace } from "./TaskWorkspace";
import type { Agent, Snapshot, Task, World } from "./types";

vi.mock("../../lib/bridge", () => ({ bridge: { invoke: vi.fn() } }));

const agent: Agent = { id: "dev", orgId: "org", name: "Alex", professionId: "dev-role", provider: "codex", model: "default", kind: "worker", allProjects: true, projectIds: [], avatar: null, appearance: "Owl", desk: 0 };
const task = (id: string, overrides: Partial<Task> = {}): Task => ({ id, orgId: "org", projectId: "project", title: id, detail: "Build a login form", route: "direct", agentId: agent.id, workflowId: null, status: "queued", steps: [], step: 0, messages: [], evidence: "", generation: 0, createdAt: 1, ...overrides });
const world = (...tasks: Task[]): World => ({ revision: 1, orgs: [], projects: [{ id: "project", orgId: "org", name: "Portal", context: "", workspacePath: "" }], professions: [{ id: "dev-role", orgId: "org", name: "Developer", kind: "dev", guidance: "Build" }], agents: [agent], workflows: [], tasks, meetings: [], memories: [], runs: [], usage: [], xp: [] });

describe("agent task entry", () => {
  it("lists actual assignments and past participation, never just a matching profession", () => {
    const data = world(
      task("direct"),
      task("handoff", { agentId: "qa", steps: [{ professionId: "dev-role", instruction: "Build", agentId: agent.id, evidence: "Built" }] }),
      task("pm-history", { agentId: "qa" }),
      task("same-profession", { agentId: "other", steps: [{ professionId: "dev-role", instruction: "Other work", agentId: null, evidence: "" }] }),
      task("other-org", { orgId: "foreign" }),
      task("meeting-only", { agentId: "other" }),
    );
    data.runs = ["pm-history", "meeting-only"].map((id) => ({ id, agentId: agent.id, targetId: id, projectId: "project", kind: id === "pm-history" ? "plan" : "meeting", generation: 0, status: "completed", result: "", startedAt: 0, finishedAt: 1 }));
    expect(tasksForAgent(data, agent).map((item) => item.id)).toEqual(["direct", "handoff", "pm-history"]);
  });

  it("orders attention before active work and keeps closed work accessible through filters", () => {
    const data = world(task("old", { status: "done" }), task("working", { status: "working" }), task("question", { status: "needs_input" }));
    expect(tasksForAgent(data, agent).map((item) => item.id)).toEqual(["question", "working", "old"]);
    const openTask = vi.fn();
    const html = renderToStaticMarkup(<AgentTasks agent={agent} world={data} openTask={openTask} />);
    expect(html).toContain("Active · 2");
    expect(html).toContain("Closed · 1");
    expect(html).not.toContain("<strong>old</strong>");
    expect(openTask).not.toHaveBeenCalled();
  });

  it("opens agent details on tasks without launching work or opening profile settings", () => {
    const snapshot: Snapshot = { world: world(task("Review the login flow")), stats: [], providers: {} };
    const mutate = vi.fn();
    const html = renderToStaticMarkup(<AgentInspector agent={agent} snapshot={snapshot} mutate={mutate} busy={false} task={vi.fn()} meeting={vi.fn()} openTask={vi.fn()} />);
    expect(html).toContain("Review the login flow");
    expect(html).toContain("Pick a task");
    expect(html).not.toContain("Role description");
    expect(html).not.toContain("Generate avatar");
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe("task conversation and plan", () => {
  it("keeps only the selected task's messages beside its real execution steps", () => {
    const selected = task("Login", { status: "needs_input", route: "auto", steps: [{ professionId: "dev-role", agentId: agent.id, instruction: "Implement accessible login", evidence: "" }], messages: [{ id: "question", actor: agent.id, body: "Which sign-in methods should I support?", createdAt: 1 }] });
    const other = task("Other", { messages: [{ id: "secret", actor: "other", body: "UNRELATED TASK CONTEXT", createdAt: 1 }] });
    const mutate = vi.fn();
    const html = renderToStaticMarkup(<TaskWorkspace task={selected} world={world(selected, other)} mutate={mutate} busy={false} back={vi.fn()} />);
    const [conversation, plan] = html.split('aria-label="Task plan"');
    expect(conversation).toContain("Which sign-in methods should I support?");
    expect(plan).toContain("Implement accessible login");
    expect(plan).not.toContain("Which sign-in methods should I support?");
    expect(html).not.toContain("UNRELATED TASK CONTEXT");
    expect(html).toContain("Back to tasks");
    expect(mutate).not.toHaveBeenCalled();
  });

  it.each(["done", "cancelled"])("keeps a %s task readable without allowing messages or controls", (status) => {
    const selected = task("Closed", { status, evidence: "Reviewed the result" });
    const html = renderToStaticMarkup(<TaskWorkspace task={selected} world={world(selected)} mutate={vi.fn()} busy={false} />);
    expect(html).toContain("Reviewed the result");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("Cancel task");
  });

  it("requires evidence to verify and does not invent a plan for direct tasks", () => {
    const selected = task("Direct", { status: "verifying" });
    const html = renderToStaticMarkup(<TaskWorkspace task={selected} world={world(selected)} mutate={vi.fn()} busy={false} />);
    expect(html).toContain("Direct task");
    expect(html).not.toContain("ow-task-plan-steps");
    expect(html).toMatch(/disabled=""[^>]*>Verify and complete/);
  });
});
