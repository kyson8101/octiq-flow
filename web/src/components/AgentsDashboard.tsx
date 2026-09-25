// Agents mode's dashboard, a main-area page opened from the sidebar: the org chart, and for each agent
// the tasks it leads and the tasks it was given. A lead's plan waiting for
// approval is reviewed in its Run panel (`PlanReview`), not here.
import { useEffect, useMemo, useState } from "react";
import "./AgentsSettings.css";
import "./ProjectsPage.css";
import { WorkspaceHeader } from "./WorkspaceHeader";
import { AGENT_NAME } from "../lib/agentProviders";
import { loadLeads, loadTeam, type TeamAgent } from "../lib/agentsMode";
import { orgChart, workFor, type LeadRecord } from "../lib/agentsDashboard";
import { TASK_LABELS } from "../lib/agentTaskBoard";
import type { OrchestrationSnapshot, OrchestrationTask } from "../lib/orchestration";
import { AgentLogo } from "./AgentLogo";
import { TaskStatusIcon } from "./TaskMeter";

export function AgentsDashboard({ projectId, snapshot, chatTitle, onOpenChat, onManage, onClose }: {
  projectId: string | null;
  snapshot: OrchestrationSnapshot;
  /** A chat's title by key, when this browser knows it. */
  chatTitle: (chatKey: string) => string | undefined;
  onOpenChat: (chatKey: string) => void;
  onManage: () => void;
  onClose: () => void;
}) {
  const [team, setTeam] = useState<TeamAgent[]>([]);
  const [leads, setLeads] = useState<LeadRecord[]>([]);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([loadTeam(projectId), loadLeads()])
      .then(([agents, records]) => {
        if (!alive) return;
        setTeam(agents);
        setLeads(projectId ? records.filter((r) => r.projectId === projectId) : records);
      })
      .catch((reason) => { if (alive) setError(String((reason as Error).message ?? reason)); });
    return () => { alive = false; };
  }, [projectId]);

  const chart = useMemo(() => orgChart(team), [team]);
  const attemptFor = (task: OrchestrationTask) =>
    snapshot.attempts.find((attempt) => attempt.id === task.activeAttemptId);

  return (
    <section className="projects-page agents-dashboard" aria-label="Agents">
      <WorkspaceHeader root back={{ label: "Chat", ariaLabel: "Back to chat", onClick: onClose }}
        title={<h1>Agents</h1>}
        actions={<button type="button" className="projects-page-secondary" onClick={onManage}>Manage agents</button>} />
      <div className="projects-page-body">
        <p className="projects-page-meta">Who is doing what</p>

        {error && <p className="set-warn" role="alert">{error}</p>}

        {chart.length === 0 ? (
          <div className="settings-empty">
            <strong>No agents yet</strong>
            <button className="vault-button" type="button" onClick={onManage}>Add agents in Settings</button>
          </div>
        ) : (
          <ul className="team-list agents-dashboard-list">
            {chart.map(({ agent, depth }) => {
              const work = workFor(agent.id, leads, snapshot);
              const expanded = open === agent.id;
              const busy = work.open > 0;
              return (
                <li key={agent.id} className="dash-agent" style={{ paddingInlineStart: `${depth * 22}px` }}>
                  <button
                    className="dash-agent-row"
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : agent.id)}
                  >
                    {depth > 0 && <span className="team-row-branch" aria-hidden="true">└</span>}
                    <AgentLogo agent={agent.agent === "codex" ? "codex" : "claude"} size={16} />
                    <span className="team-row-copy">
                      <span className="team-row-name">{agent.name}</span>
                      <span className="team-row-meta">{agent.role || `${AGENT_NAME[agent.agent]} ${agent.model}`}</span>
                    </span>
                    <span className="dash-agent-counts">
                      {busy && <span className="dash-count is-open" title="Tasks in progress">{work.open} active</span>}
                      {work.stuck > 0 && <span className="dash-count is-stuck" title="Failed or blocked">{work.stuck} stuck</span>}
                      {work.done > 0 && <span className="dash-count" title="Completed tasks">{work.done} done</span>}
                      {work.led.length > 0 && <span className="dash-count" title="Tasks it was handed to lead">{work.led.length} led</span>}
                    </span>
                  </button>
                  {expanded && (
                    <div className="dash-agent-work">
                      {agent.memoryNote && (
                        <p className="dash-memory" title="This agent's working memory in the Memory Vault">
                          Memory · <bdi>{agent.memoryNote}</bdi>
                        </p>
                      )}
                      {work.led.length === 0 && work.assigned.length === 0 && (
                        <p className="settings-note">Nothing yet.</p>
                      )}
                      {work.led.slice(0, 8).map((record) => (
                        <button key={record.chatKey} className="dash-item" type="button" onClick={() => onOpenChat(record.chatKey)}>
                          <span className="dash-item-kind">Leads</span>
                          <span className="dash-item-title">{chatTitle(record.chatKey) ?? "Task chat"}</span>
                        </button>
                      ))}
                      {work.assigned.slice(0, 12).map((task) => {
                        const attempt = attemptFor(task);
                        return (
                          <button key={task.id} className="dash-item" type="button" disabled={!attempt}
                            onClick={() => attempt && onOpenChat(attempt.workerChatKey)}>
                            <span className="dash-item-kind" aria-label={TASK_LABELS[task.status]}><TaskStatusIcon status={task.status} /></span>
                            <span className="dash-item-title">{task.title}</span>
                            <span className="dash-item-state">{TASK_LABELS[task.status]}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
