import { useState } from "react";
import { label, type Agent, type Task, type World } from "./types";

const closed = (task: Task) => ["done", "cancelled"].includes(task.status);
const priority = ["needs_input", "verifying", "paused", "working", "planning", "queued", "done", "cancelled"];

export function tasksForAgent(world: World, agent: Agent): Task[] {
  const participated = new Set(world.runs
    .filter((run) => run.agentId === agent.id && ["plan", "task"].includes(run.kind))
    .map((run) => run.targetId));
  return world.tasks.filter((task) => task.orgId === agent.orgId && (
    task.agentId === agent.id || task.steps.some((step) => step.agentId === agent.id)
    || participated.has(task.id)
  )).sort((a, b) => priority.indexOf(a.status) - priority.indexOf(b.status) || b.createdAt - a.createdAt);
}

export function AgentTasks({ agent, world, openTask }: {
  agent: Agent;
  world: World;
  openTask: (taskId: string) => void;
}) {
  const [filter, setFilter] = useState<"active" | "closed" | "all">("active");
  const tasks = tasksForAgent(world, agent);
  const active = tasks.filter((task) => !closed(task));
  const visible = tasks.filter((task) => filter === "all" || closed(task) === (filter === "closed"));
  return (
    <section className="ow-agent-tasks" aria-label={`${agent.name}'s tasks`}>
      <h4>Tasks</h4>
      <p className="ow-muted">Pick a task to continue its conversation and view the plan.</p>
      <nav className="ow-task-filters" aria-label="Filter agent tasks">
        <button type="button" aria-pressed={filter === "active"} onClick={() => setFilter("active")}>Active · {active.length}</button>
        <button type="button" aria-pressed={filter === "closed"} onClick={() => setFilter("closed")}>Closed · {tasks.length - active.length}</button>
        <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All · {tasks.length}</button>
      </nav>
      <div className="ow-agent-task-list">
        {visible.map((task) => {
          const current = world.agents.find((member) => member.id === task.agentId);
          const last = task.messages.at(-1);
          return <button type="button" key={task.id} className="ow-agent-task" onClick={() => openTask(task.id)}>
            <span className={`ow-status ${task.status}`}>{label(task.status)}</span>
            <strong>{task.title}</strong>
            <span className="ow-muted">{world.projects.find((project) => project.id === task.projectId)?.name ?? "Project"}
              {current && current.id !== agent.id ? ` · Now with ${current.name}` : ""}</span>
            <p>{last?.body || task.detail || "Open the task to see its conversation."}</p>
            <small>{task.steps.length ? `${Math.min(task.step + 1, task.steps.length)} / ${task.steps.length} steps · ` : ""}Open conversation →</small>
          </button>;
        })}
        {!visible.length && <p className="ow-empty">{!tasks.length
          ? "No tasks yet. Give this agent a task to start a conversation."
          : filter === "active" ? "No active tasks. Closed conversations are still available above."
          : "No closed tasks yet."}</p>}
      </div>
    </section>
  );
}
