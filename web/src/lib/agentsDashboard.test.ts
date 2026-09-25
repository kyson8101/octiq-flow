import { describe, expect, it, vi } from "vitest";

vi.mock("./bridge", () => ({ bridge: { invoke: async () => [] } }));
import { orgChart, pendingPlan, workFor, type LeadRecord } from "./agentsDashboard";
import { EMPTY_ORCHESTRATION, type OrchestrationRun, type OrchestrationSnapshot, type OrchestrationTask } from "./orchestration";
import type { TeamAgent } from "./agentsMode";

const agent = (id: string, name: string, reportsTo?: string): TeamAgent => ({
  id, name, role: "", agent: "claude", model: "sonnet", access: "auto", reportsTo, createdAt: 1, updatedAt: 1,
});

const run = (over: Partial<OrchestrationRun> = {}): OrchestrationRun => ({
  id: "run_1", objective: "Ship", coordinatorChatKey: "chat:lead", workspaceId: "p1", rootPath: "/r",
  status: "running", maxConcurrent: 2, createdAt: 1, updatedAt: 1,
  planApproval: { status: "pending", requestedAt: 1 }, ...over,
});

const task = (id: string, status: OrchestrationTask["status"], assignee?: string, updatedAt = 1): OrchestrationTask => ({
  id, runId: "run_1", title: `Task ${id}`, spec: "", dependsOn: [], status, createdAt: 1, updatedAt,
  ...(assignee ? { assignee: { id: assignee, name: assignee } } : {}),
});

describe("agents dashboard", () => {
  it("draws the chart top-down with reports under their manager", () => {
    const rows = orgChart([
      agent("dev", "Dev", "cto"),
      agent("cto", "Cto", "ceo"),
      agent("ceo", "Ceo"),
      agent("ops", "Ops"),
      // A manager this project cannot see leaves its report at the top.
      agent("orphan", "Orphan", "elsewhere"),
    ]);
    expect(rows.map((row) => `${row.depth}:${row.agent.name}`)).toEqual([
      "0:Ceo", "1:Cto", "2:Dev", "0:Ops", "0:Orphan",
    ]);
  });

  it("counts an agent's own work", () => {
    const snapshot: OrchestrationSnapshot = {
      ...EMPTY_ORCHESTRATION,
      tasks: [task("a", "running", "ada", 3), task("b", "completed", "ada", 2), task("c", "failed", "ada"), task("d", "running", "bo")],
    };
    const leads: LeadRecord[] = [{ chatKey: "chat:x", leadId: "ada", leadName: "Ada", projectId: "p1", createdAt: 5 }];
    const work = workFor("ada", leads, snapshot);
    expect(work).toMatchObject({ open: 1, done: 1, stuck: 1 });
    expect(work.assigned.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(work.led).toHaveLength(1);
  });

  it("finds the plan waiting in this chat, and only a live one", () => {
    const snapshot: OrchestrationSnapshot = { ...EMPTY_ORCHESTRATION, runs: [run()], tasks: [task("a", "ready", "ada")] };
    expect(pendingPlan(snapshot, "chat:lead")?.tasks).toHaveLength(1);
    expect(pendingPlan(snapshot, "chat:other")).toBeNull();
    expect(pendingPlan({ ...snapshot, runs: [run({ status: "stopped" })] }, "chat:lead")).toBeNull();
    expect(pendingPlan({ ...snapshot, runs: [run({ planApproval: { status: "approved", requestedAt: 1 } })] }, "chat:lead")).toBeNull();
  });
});
