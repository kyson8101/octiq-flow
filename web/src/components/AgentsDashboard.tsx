// Agents mode's two surfaces beyond Settings:
//
//   - PlanApproval, above a lead's composer: the plan it made, waiting for the
//     person. No worker starts until Approve — the host refuses them, this card
//     only asks.
//   - AgentsDashboard, from the top bar: the org chart, and for each agent the
//     tasks it leads and the tasks it was given.
import { useEffect, useMemo, useState } from "react";
import "./AgentsSettings.css";
import { AGENT_NAME } from "../lib/agentProviders";
import { approvePlan, loadLeads, loadTeam, type TeamAgent } from "../lib/agentsMode";
import { orgChart, workFor, type LeadRecord } from "../lib/agentsDashboard";
import { TASK_LABELS } from "../lib/agentTaskBoard";
import type { OrchestrationRun, OrchestrationSnapshot, OrchestrationTask } from "../lib/orchestration";
import { AgentLogo } from "./AgentLogo";
import { TaskStatusIcon } from "./TaskMeter";

export function PlanApproval({ run, tasks, drafting, onApproved }: {
  run: OrchestrationRun;
  tasks: OrchestrationTask[];
  /** The lead is still in its turn: the plan may not be finished. */
  drafting: boolean;
  onApproved?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const approve = async () => {
    setBusy(true);
    setError("");
    try {
      await approvePlan(run.coordinatorChatKey, run.id);
      onApproved?.();
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="plan-approval" aria-label="Plan waiting for approval">
      <header className="plan-approval-head">
        <strong>{drafting ? "Plan in progress" : "Plan ready for your approval"}</strong>
        <span>{tasks.length} {tasks.length === 1 ? "task" : "tasks"} · no worker starts until you approve</span>
      </header>
      {tasks.length > 0 && (
        <ol className="plan-approval-list">
          {tasks.map((task) => (
            <li key={task.id}>
              <span className="plan-approval-title">{task.title}</span>
              <span className="plan-approval-who">{task.assignee?.name ?? "unassigned"}</span>
            </li>
          ))}
        </ol>
      )}
      {error && <p className="set-warn" role="alert">{error}</p>}
      <div className="plan-approval-actions">
        <span className="plan-approval-hint">To change it, reply below.</span>
        <button className="settings-primary" type="button" disabled={busy || drafting || tasks.length === 0} onClick={() => void approve()}>
          {busy ? "Approving…" : "Approve plan"}
        </button>
      </div>
    </section>
  );
}

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
    <>
      <div className="panel-scrim" onClick={onClose} />
      <aside className="panel agents-dashboard" role="dialog" aria-label="Agents">
        <header className="panel-head">
          <div className="panel-id">
            <div className="panel-name">Agents</div>
            <div className="shelf-sub">who is doing what</div>
          </div>
          <button className="panel-close" type="button" onClick={onClose} aria-label="Close">×</button>
        </header>

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
        <div className="agent-foot">
          <button className="agent-recheck" type="button" onClick={onManage}>Manage agents</button>
        </div>
      </aside>
    </>
  );
}
