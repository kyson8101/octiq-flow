// What the Agents dashboard shows: the org chart as rows, and each agent's
// work. Pure, so it is tested without a page.
import type { OrchestrationSnapshot, OrchestrationTask, TaskStatus } from "./orchestration";
import type { TeamAgent } from "./agentsMode";

/** A chat a task was handed to (team.rs `LeadRecord`). */
export type LeadRecord = {
  chatKey: string;
  leadId: string;
  leadName: string;
  projectId: string;
  /** The conversation with the configured head, across projects. */
  crossProject?: boolean;
  createdAt: number;
};

export type ChartRow = { agent: TeamAgent; depth: number };

/** The chart top-down: agents reporting to the person first, each followed by
 *  its reports. A manager missing from the list (another project's, say)
 *  leaves its reports at the top rather than hiding them. */
export function orgChart(team: TeamAgent[]): ChartRow[] {
  const ids = new Set(team.map((agent) => agent.id));
  const byName = (a: TeamAgent, b: TeamAgent) => a.name.localeCompare(b.name);
  const reportsOf = (id: string) => team.filter((agent) => agent.reportsTo === id).sort(byName);
  const rows: ChartRow[] = [];
  const seen = new Set<string>();
  const walk = (agent: TeamAgent, depth: number) => {
    if (seen.has(agent.id)) return;
    seen.add(agent.id);
    rows.push({ agent, depth });
    for (const report of reportsOf(agent.id)) walk(report, depth + 1);
  };
  for (const top of team.filter((agent) => !agent.reportsTo || !ids.has(agent.reportsTo)).sort(byName)) {
    walk(top, 0);
  }
  return rows;
}

export type AgentWork = {
  /** Tasks the person handed this agent to lead, newest first. */
  led: LeadRecord[];
  /** Tasks assigned to it in runs, newest first. */
  assigned: OrchestrationTask[];
  /** Assigned tasks not yet settled. */
  open: number;
  done: number;
  /** Assigned tasks that need a look: failed or blocked. */
  stuck: number;
};

const OPEN: TaskStatus[] = ["pending", "ready", "running"];

export function workFor(agentId: string, leads: LeadRecord[], snapshot: OrchestrationSnapshot): AgentWork {
  const led = leads.filter((record) => record.leadId === agentId).sort((a, b) => b.createdAt - a.createdAt);
  const assigned = snapshot.tasks
    .filter((task) => task.assignee?.id === agentId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return {
    led,
    assigned,
    open: assigned.filter((task) => OPEN.includes(task.status)).length,
    done: assigned.filter((task) => task.status === "completed").length,
    stuck: assigned.filter((task) => task.status === "failed" || task.status === "blocked").length,
  };
}

/** The run of a lead's chat that is waiting on the person's approval. */
export function pendingPlan(snapshot: OrchestrationSnapshot, chatKey: string | null) {
  if (!chatKey) return null;
  const run = snapshot.runs.find((item) =>
    item.coordinatorChatKey === chatKey
    && item.planApproval?.status === "pending"
    && !["stopped", "completed", "failed"].includes(item.status));
  if (!run) return null;
  return { run, tasks: snapshot.tasks.filter((task) => task.runId === run.id) };
}
