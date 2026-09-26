// Agents mode's dashboard, a main-area page opened from the sidebar: every
// registered agent across every project, and what each is doing right now.
// Registering and editing agents stays in Settings (Manage agents). A lead's
// plan waiting for approval is reviewed in its Run panel (`PlanReview`); this
// page only says it is waiting and opens it.
import { useEffect, useMemo, useState } from "react";
import "./AgentsSettings.css";
import "./AgentsDashboard.css";
import "./ProjectsPage.css";
import { WorkspaceHeader } from "./WorkspaceHeader";
import { AGENT_NAME } from "../lib/agentProviders";
import { loadLeads, loadTeam, type TeamAgent } from "../lib/agentsMode";
import {
  AGENT_STATE_LABELS, agentRoster, rosterSummary,
  type AgentActivity, type AgentRow, type ChatActivity, type LeadRecord,
} from "../lib/agentsDashboard";
import type { OrchestrationSnapshot } from "../lib/orchestration";
import { bridge } from "../lib/bridge";
import { AgentAvatar } from "./AgentAvatar";
import { AgentRole } from "./AgentRole";
import { ProjectAvatar, type ProjectAppearance } from "./ProjectAvatar";

/** How many of an agent's current items show before "Show all". */
const SHOWN = 3;

type Activity = { key: string; busy: boolean };

export function AgentsDashboard({
  snapshot, ledgerError, connected, projects, running, busy, waitingOn, chatTitle, chatExists,
  onOpenChat, onOpenRun, onManage, onClose,
}: {
  /** Null until the ledger's first read lands. */
  snapshot: OrchestrationSnapshot | null;
  /** Why the last ledger read failed; the last good snapshot is still shown. */
  ledgerError: string | null;
  connected: boolean;
  projects: readonly ProjectAppearance[];
  /** Chat ids with a live process, and those mid-turn, as this page has seen. */
  running: ReadonlySet<string>;
  busy: ReadonlySet<string>;
  /** Cards on this chat only the person can answer. */
  waitingOn: (chatKey: string) => number;
  /** A chat's title by key, when this browser knows it. */
  chatTitle: (chatKey: string) => string | undefined;
  chatExists: (chatKey: string) => boolean;
  onOpenChat: (chatKey: string) => void;
  /** A lead's run panel, for a task nobody has started yet. */
  onOpenRun: (coordinatorChatKey: string, runId: string) => void;
  onManage: () => void;
  onClose: () => void;
}) {
  const [team, setTeam] = useState<TeamAgent[] | null>(null);
  const [leads, setLeads] = useState<LeadRecord[]>([]);
  const [error, setError] = useState("");
  const [serverActivity, setServerActivity] = useState<ReadonlyMap<string, boolean> | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [openError, setOpenError] = useState("");

  // Every registered agent, not the current chat's project's: this page is
  // the whole roster. Read again on every reconnect, since agents may have
  // been added or renamed from another device meanwhile.
  useEffect(() => {
    if (!connected) return;
    let alive = true;
    Promise.all([loadTeam(null, true), loadLeads()])
      .then(([agents, records]) => {
        if (!alive) return;
        setTeam(agents);
        setLeads(records);
        setError("");
      })
      .catch((reason) => { if (alive) setError(String((reason as Error).message ?? reason)); });
    return () => { alive = false; };
  }, [connected]);

  // Which lead conversations are mid-turn. A page that has just loaded has
  // seen no events from them, so it asks the host; asked again whenever a
  // chat starts, stops or changes turn, never on a timer.
  const liveSignature = useMemo(() => [...running].sort().join(",") + "|" + [...busy].sort().join(","), [running, busy]);
  useEffect(() => {
    if (!connected) return;
    let alive = true;
    bridge.invoke<Activity[]>("chat_activity")
      .then((list) => { if (alive) setServerActivity(new Map((list ?? []).map((item) => [item.key, item.busy]))); })
      // An older backend: this page's own evidence is all there is.
      .catch(() => { if (alive) setServerActivity(null); });
    return () => { alive = false; };
  }, [connected, liveSignature]);

  const leadActivity = (chatKey: string): ChatActivity => {
    const id = chatKey.replace(/^chat:/, "");
    if (busy.has(id)) return "busy";
    const known = serverActivity?.get(chatKey);
    if (known !== undefined) return known ? "busy" : "idle";
    if (serverActivity) return "ended";
    return running.has(id) ? "unknown" : "ended";
  };

  const projectList = useMemo(() => projects.map(({ id, name }) => ({ id, name })), [projects]);
  const rows = agentRoster({
    team, leads, snapshot, projects: projectList,
    providerLabel: (agent) => `${AGENT_NAME[agent.agent]} ${agent.model}`,
    chatTitle, chatExists, leadActivity, waitingOn,
  });
  const summary = rosterSummary(rows);
  const stale = !connected || !!ledgerError;
  const appearance = (id: string) => projects.find((project) => project.id === id);

  const open = (activity: AgentActivity) => {
    setOpenError("");
    try {
      if (activity.chatKey) onOpenChat(activity.chatKey);
      else if (activity.runId) {
        const run = snapshot?.runs.find((item) => item.id === activity.runId);
        if (run) onOpenRun(run.coordinatorChatKey, run.id);
      }
    } catch (problem) {
      setOpenError(String((problem as Error).message ?? problem));
    }
  };
  const canOpen = (activity: AgentActivity) => !!activity.chatKey
    || (!!activity.runId && !!snapshot?.runs.some((run) => run.id === activity.runId));

  const toggle = (id: string) => setExpanded((before) => {
    const next = new Set(before);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <section className="projects-page agents-dashboard" aria-label="Agents">
      <WorkspaceHeader root back={{ label: "Chat", ariaLabel: "Back to chat", onClick: onClose }}
        title={<h1>Agents</h1>}
        actions={<button type="button" className="projects-page-secondary" onClick={onManage}>Manage agents</button>} />
      <div className="projects-page-body">
        <p className="projects-page-meta dash-summary" aria-live="polite">
          {team === null && !error ? "Loading agents…"
            : summary.length === 0 ? "Who is doing what"
            : summary.map(({ state, count }) => `${count} ${AGENT_STATE_LABELS[state].toLowerCase()}`).join(" · ")}
        </p>

        {stale && team !== null && (
          <p className="dash-stale" role="status">
            {!connected ? "Disconnected. Showing the last known state." : "Could not refresh work. Showing the last known state."}
          </p>
        )}
        {error && <p className="set-warn" role="alert">{error}</p>}
        {openError && <p className="set-warn" role="alert">{openError}</p>}

        {team !== null && rows.length === 0 ? (
          <div className="settings-empty">
            <strong>No agents yet</strong>
            <button className="vault-button" type="button" onClick={onManage}>Add agents in Settings</button>
          </div>
        ) : (
          <ul className="team-list agents-dashboard-list">
            {rows.map((row) => (
              <AgentRowItem key={row.id} row={row} stale={stale}
                expanded={expanded.has(row.id)} onToggle={() => toggle(row.id)}
                appearance={appearance} canOpen={canOpen} onOpen={open}
                onOpenRecent={(chatKey) => {
                  setOpenError("");
                  try { onOpenChat(chatKey); } catch (problem) { setOpenError(String((problem as Error).message ?? problem)); }
                }} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function AgentRowItem({ row, stale, expanded, onToggle, appearance, canOpen, onOpen, onOpenRecent }: {
  row: AgentRow;
  stale: boolean;
  expanded: boolean;
  onToggle: () => void;
  appearance: (id: string) => ProjectAppearance | undefined;
  canOpen: (activity: AgentActivity) => boolean;
  onOpen: (activity: AgentActivity) => void;
  onOpenRecent: (chatKey: string) => void;
}) {
  const working = row.state === "working" && !stale;
  const shown = expanded ? row.activities : row.activities.slice(0, SHOWN);
  const others = (Object.entries(row.counts) as [AgentRow["state"], number][])
    .filter(([state]) => state !== row.state);
  const stateText = AGENT_STATE_LABELS[row.state];
  return (
    <li className="dash-agent" data-state={row.state} style={{ "--team-depth": row.depth } as React.CSSProperties}>
      <div className="dash-agent-head">
        {row.depth > 0 && <span className="team-row-branch" aria-hidden="true">└</span>}
        <AgentAvatar name={row.name} avatar={row.avatar} id={row.id} size={28} removed={row.removed}
          className={working ? "dash-avatar is-working" : "dash-avatar"}
          label={`${row.name}, ${stateText.toLowerCase()}`} />
        <span className="team-row-copy">
          <span className="team-row-name"><bdi>{row.name}</bdi></span>
          <span className="team-row-meta">
            <bdi>{row.detail}</bdi>
            <span aria-hidden="true"> · </span>
            {row.removed ? "Removed" : row.scope ? <bdi>{row.scope.name}</bdi> : "All projects"}
          </span>
        </span>
        <span className="dash-agent-status">
          <span className={`dash-state is-${row.state}${stale ? " is-stale" : ""}`}
            title={stale ? `Last known: ${row.stateLabel}` : row.stateLabel}>
            {stale ? `${stateText} (last known)` : stateText}
          </span>
          {others.map(([state, count]) => (
            <span key={state} className={`dash-count is-${state}`}>{count} {AGENT_STATE_LABELS[state].toLowerCase()}</span>
          ))}
        </span>
      </div>
      {row.role && <AgentRole className="dash-agent-role" text={row.role} name={row.name} />}

      {row.activities.length > 0 ? (
        <div className="dash-agent-work">
          {shown.map((activity) => (
            <button key={activity.key} className="dash-item" type="button" data-state={activity.state}
              disabled={!canOpen(activity)} onClick={() => onOpen(activity)}
              aria-label={`${activity.label}: ${activity.title}${activity.project ? `, in ${activity.project.name}` : ""}. Open ${activity.kind === "lead" ? "conversation" : "task"}`}>
              <span className={`dash-dot is-${activity.state}`} aria-hidden="true" />
              <span className="dash-item-copy">
                <span className="dash-item-title">{activity.title}</span>
                <span className="dash-item-meta">
                  <span className="dash-item-state">{activity.label}</span>
                  {activity.project ? <span className="dash-item-project">
                    {appearance(activity.project.id) && <ProjectAvatar project={appearance(activity.project.id)!} size="tiny" />}
                    <bdi>{activity.project.name}</bdi>
                  </span> : activity.crossProject ? <span className="dash-item-project">Across projects</span> : null}
                </span>
              </span>
              <span className="dash-item-open" aria-hidden="true">Open</span>
            </button>
          ))}
          {row.activities.length > SHOWN && (
            <button className="dash-more" type="button" aria-expanded={expanded} onClick={onToggle}>
              {expanded ? "Show fewer" : `Show all ${row.activities.length}`}
            </button>
          )}
        </div>
      ) : row.recent ? (
        <div className="dash-agent-work">
          <button className="dash-recent" type="button" onClick={() => onOpenRecent(row.recent!.chatKey)}
            aria-label={`Open last: ${row.recent.title}`}>
            Last: <span className="dash-item-title">{row.recent.title}</span>
          </button>
        </div>
      ) : null}
    </li>
  );
}
