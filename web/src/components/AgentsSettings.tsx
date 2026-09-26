// Settings → Agents: the switch for agents mode, and the person's registered
// agents — each a name, a role, and the provider/model/effort/access it runs
// on, either global or belonging to one project.
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import "./AgentsSettings.css";
import {
  ACCESS, AGENT_NAME, EFFORTS,
  type AccessLevel, type Effort, type Provider,
} from "../lib/agentProviders";
import {
  deleteTeamAgent, leadOnly, loadHead, loadHome, loadTeam, saveHead, saveHome, saveTeamAgent, teamModels,
  type TeamAgent, type TeamDraft,
} from "../lib/agentsMode";
import { orgChart } from "../lib/agentsDashboard";
import { AgentAvatar } from "./AgentAvatar";
import { AgentAvatarEditor } from "./AgentAvatarEditor";
import { AgentRole, rolePreview } from "./AgentRole";

type ProjectRef = { id: string; name: string };

const PROVIDERS: Provider[] = ["claude", "codex"];

function blank(projectId: string | null): TeamDraft {
  return { name: "", role: "", agent: "claude", model: "sonnet", effort: "medium", access: "auto", projectId, reportsTo: null };
}

export function AgentsSettings({ on, onToggle, projects }: {
  on: boolean;
  onToggle: (on: boolean) => void;
  projects: ProjectRef[];
}) {
  const [team, setTeam] = useState<TeamAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<TeamDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [headId, setHeadId] = useState<string | null>(null);
  const [homeId, setHomeId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([loadTeam(null, true), loadHead(), loadHome().catch(() => null)])
      .then(([agents, head, home]) => {
        if (!alive) return;
        setTeam(agents);
        setHeadId(head?.id ?? null);
        setHomeId(home);
      })
      .catch((reason) => { if (alive) setError(String((reason as Error).message ?? reason)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  // Only a global agent can be talked to from every project.
  const globalAgents = useMemo(() => team.filter((agent) => !agent.projectId), [team]);
  const pickHead = async (id: string | null) => {
    setError("");
    try {
      const head = await saveHead(id);
      setHeadId(head?.id ?? null);
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
    }
  };

  const pickHome = async (id: string | null) => {
    setError("");
    try {
      setHomeId(await saveHome(id));
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
    }
  };
  // A configured home that was since removed reads as the default.
  const homeKnown = !!homeId && projects.some((p) => p.id === homeId);

  const projectName = useMemo(
    () => new Map(projects.map((p) => [p.id, p.name])),
    [projects],
  );
  const chart = useMemo(() => orgChart(team), [team]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError("");
    try {
      const saved = await saveTeamAgent({ ...draft, projectId: draft.projectId || null, reportsTo: draft.reportsTo || null });
      if (saved.memoryError) setError(`${saved.name} was saved, but its memory note could not be created: ${saved.memoryError}`);
      // Re-read: a save can move nothing else today, but a delete moves
      // reports up, and one source of truth is simpler than two.
      setTeam(await loadTeam(null, true));
      setDraft(null);
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (agent: TeamAgent) => {
    setError("");
    try {
      await deleteTeamAgent(agent.id);
      // Its reports now report to its manager, and a removed lead is no
      // longer the one you talk to.
      setTeam(await loadTeam(null, true));
      setHeadId((await loadHead())?.id ?? null);
      if (draft?.id === agent.id) setDraft(null);
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
    }
  };

  const row = ({ agent, depth }: { agent: TeamAgent; depth: number }) => (
    <li className="team-row" key={agent.id} style={{ "--team-depth": depth } as React.CSSProperties}>
      <div className="team-row-head">
        {depth > 0 && <span className="team-row-branch" aria-hidden="true">└</span>}
        <AgentAvatar name={agent.name} avatar={agent.avatar} id={agent.id} size={28} decorative />
        <span className="team-row-copy">
          <span className="team-row-name">
            <bdi>{agent.name}</bdi>
            {leadOnly(agent) && <span className="team-tag" title="Fable and Astra can lead a task but cannot take one">lead only</span>}
          </span>
          <span className="team-row-meta">
            {AGENT_NAME[agent.agent]} {modelLabel(agent)}{agent.effort ? ` · ${agent.effort}` : ""}
            {" · "}{agent.projectId ? projectName.get(agent.projectId) ?? "Removed project" : "Every project"}
          </span>
        </span>
        <span className="team-row-actions">
          <button className="vault-button team-row-action" type="button" aria-label={`Edit ${agent.name}`} title="Edit"
            onClick={() => setDraft({ ...agent, projectId: agent.projectId ?? null, reportsTo: agent.reportsTo ?? null })}>
            <EditIcon /><span className="team-row-action-text">Edit</span>
          </button>
          <button className="vault-button team-row-action" type="button" aria-label={`Remove ${agent.name}`} title="Remove"
            onClick={() => void remove(agent)}>
            <RemoveIcon /><span className="team-row-action-text">Remove</span>
          </button>
        </span>
      </div>
      {agent.role && <AgentRole className="team-row-role" text={agent.role} name={agent.name} />}
    </li>
  );

  return (
    <section className="settings-section team-settings" aria-labelledby="settings-agents-title">
      <header className="settings-section-head">
        <div>
          <h2 id="settings-agents-title">Agents</h2>
          <p>Register agents, then hand a task to one. It does the task, passes it on, or splits it across the others.</p>
        </div>
      </header>

      <div className="settings-control-row">
        <div className="settings-control-copy">
          <h3>Agents mode</h3>
          <p>Work starts in one conversation with your CTO, who routes it to the right project and agent. Off, chats work as they always have.</p>
        </div>
        <button
          className={`set-switch${on ? " is-on" : ""}`}
          type="button"
          role="switch"
          aria-checked={on}
          onClick={() => onToggle(!on)}
        >
          <span className="set-switch-track" aria-hidden="true" />
          <span className="set-switch-text">{on ? "On" : "Off"}</span>
        </button>
      </div>

      <div className="settings-control-row">
        <div className="settings-control-copy">
          <h3>Talk to</h3>
          <p>The lead you talk to from any project. It picks the project, repository and teammate for each part of the work, and you approve the plan first.</p>
        </div>
        <select
          className="team-head-select"
          aria-label="Lead you talk to across projects"
          value={headId ?? ""}
          disabled={loading || globalAgents.length === 0}
          onChange={(event) => void pickHead(event.target.value || null)}
        >
          <option value="">{globalAgents.length === 0 ? "Add an agent for every project first" : "No one"}</option>
          {globalAgents.map((agent) => (
            <option key={agent.id} value={agent.id}>{agent.name}{agent.role ? ` · ${rolePreview(agent.role)}` : ""}</option>
          ))}
        </select>
      </div>

      <div className="settings-control-row">
        <div className="settings-control-copy">
          <h3>Home workspace</h3>
          <p>Where conversations with your lead live. It needs no code project or Git setup; the lead routes each task to a registered project.</p>
        </div>
        <select
          className="team-head-select"
          aria-label="Home workspace for your lead"
          value={homeKnown ? homeId ?? "" : ""}
          disabled={loading}
          onChange={(event) => void pickHome(event.target.value || null)}
        >
          <option value="">General (default)</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>{project.name}</option>
          ))}
        </select>
      </div>

      <div className="team-head">
        <h3>Registered agents</h3>
        <button className="settings-primary" type="button" onClick={() => setDraft(blank(null))} disabled={!!draft && !draft.id}>
          Add agent
        </button>
      </div>

      {error && <p className="set-warn" role="alert">{error}</p>}

      {draft && (
        <TeamForm
          draft={draft}
          team={team}
          projects={projects}
          saving={saving}
          onChange={setDraft}
          onSave={() => void save()}
          onCancel={() => setDraft(null)}
        />
      )}

      {loading ? (
        <p role="status" className="settings-note">Loading agents…</p>
      ) : team.length === 0 ? (
        <div className="settings-empty">
          <strong>No agents yet</strong>
          <span>Add one with a name, a role and the model it runs on.</span>
        </div>
      ) : (
        <div className="team-group">
          <h4>Org chart · agents at the top report to you</h4>
          <ul className="team-list">{chart.map(row)}</ul>
        </div>
      )}
    </section>
  );
}

/** A new conversation's "who is this with": the agents reporting directly to
 *  the person (`conversationRecipients`), never anyone's report. Picking one
 *  sets the chat's model, effort and access to that agent's; the first message
 *  carries its brief. With a single choice already made there is nothing to
 *  pick, so it draws nothing. A radio group: arrow keys move the choice, Tab
 *  leaves it. */
export function RecipientPicker({ agents, selectedId, projectName, onPick, onManage }: {
  agents: readonly TeamAgent[];
  selectedId: string | null;
  /** A project agent's project, named on its chip. */
  projectName: (id: string) => string | undefined;
  onPick: (agent: TeamAgent) => void;
  onManage: () => void;
}) {
  if (agents.length === 0) {
    return (
      <div className="lead-picker">
        <p className="lead-picker-note">
          No agent reports to you yet. <button type="button" onClick={onManage}>Add one in Settings</button> to start a conversation.
        </p>
      </div>
    );
  }
  if (agents.length === 1 && agents[0].id === selectedId) return null;
  const focusable = agents.some((agent) => agent.id === selectedId) ? selectedId : agents[0].id;
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    const at = agents.findIndex((agent) => agent.id === focusable);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? agents.length - 1
      : step ? (at + step + agents.length) % agents.length
      : -1;
    if (next < 0) return;
    event.preventDefault();
    onPick(agents[next]);
    event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus();
  };
  return (
    <div className="lead-picker">
      <div className="lead-picker-list" role="radiogroup" aria-label="Talk to" onKeyDown={move}>
        {agents.map((agent) => {
          const project = agent.projectId ? projectName(agent.projectId) ?? "another project" : null;
          return (
            <button
              key={agent.id}
              className={`lead-chip${agent.id === selectedId ? " is-on" : ""}`}
              type="button"
              role="radio"
              aria-checked={agent.id === selectedId}
              tabIndex={agent.id === focusable ? 0 : -1}
              title={[agent.role, project ? `Works in ${project}` : "Works in any project", `${AGENT_NAME[agent.agent]} ${modelLabel(agent)}`]
                .filter(Boolean).join("\n")}
              onClick={() => onPick(agent)}
            >
              <AgentAvatar name={agent.name} avatar={agent.avatar} id={agent.id} size={20} decorative />
              <span className="lead-chip-name">{agent.name}</span>
              {project && <span className="lead-chip-meta">{project}</span>}
            </button>
          );
        })}
      </div>
      <p className="lead-picker-note">
        Agents who report to you. <button type="button" onClick={onManage}>Manage agents</button>
      </p>
    </div>
  );
}

function EditIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></svg>;
}

function RemoveIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13" /><path d="M9 7V4h6v3" /></svg>;
}

function modelLabel(agent: Pick<TeamAgent, "agent" | "model">): string {
  return teamModels(agent.agent).find((m) => m.flag === agent.model)?.model ?? agent.model;
}

function TeamForm({ draft, team, projects, saving, onChange, onSave, onCancel }: {
  draft: TeamDraft;
  team: TeamAgent[];
  projects: ProjectRef[];
  saving: boolean;
  onChange: (draft: TeamDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const models = teamModels(draft.agent);
  const efforts = EFFORTS[draft.agent];
  const access = ACCESS[draft.agent];
  const set = (patch: Partial<TeamDraft>) => onChange({ ...draft, ...patch });
  const pickProvider = (agent: Provider) => {
    const model = teamModels(agent)[0]?.flag ?? "";
    const effort = EFFORTS[agent].some((e) => e.id === draft.effort) ? draft.effort : EFFORTS[agent][0]?.id;
    const level = ACCESS[agent].some((a) => a.id === draft.access) ? draft.access : "auto";
    onChange({ ...draft, agent, model, effort, access: level });
  };
  const lead = leadOnly(draft);
  // A manager must be visible wherever this agent is, and must not already
  // report to it (a loop). The host checks both too.
  const below = new Set<string>();
  if (draft.id) {
    let grew = true;
    below.add(draft.id);
    while (grew) {
      grew = false;
      for (const agent of team) {
        if (agent.reportsTo && below.has(agent.reportsTo) && !below.has(agent.id)) {
          below.add(agent.id);
          grew = true;
        }
      }
    }
  }
  const managers = team.filter((agent) =>
    !below.has(agent.id) && (!agent.projectId || agent.projectId === (draft.projectId || undefined)));

  return (
    <form className="team-form" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
      <label>
        <span>Name</span>
        <input value={draft.name} maxLength={60} placeholder="e.g. Reviewer" autoFocus
          onChange={(event) => set({ name: event.target.value })} />
      </label>
      <AgentAvatarEditor
        key={draft.id ?? "new"}
        name={draft.name}
        role={draft.role}
        avatar={draft.avatar}
        agentId={draft.id}
        onChange={(avatar) => set({ avatar })}
      />
      <label className="team-form-wide">
        <span>Role</span>
        <textarea value={draft.role} maxLength={2000} rows={3}
          placeholder="What this agent is good at, and what it should take on"
          onChange={(event) => set({ role: event.target.value })} />
      </label>
      <label>
        <span>Provider</span>
        <select value={draft.agent} onChange={(event) => pickProvider(event.target.value as Provider)}>
          {PROVIDERS.map((p) => <option key={p} value={p}>{AGENT_NAME[p]}</option>)}
        </select>
      </label>
      <label>
        <span>Model</span>
        <select value={draft.model} onChange={(event) => set({ model: event.target.value })}>
          {models.map((m) => <option key={m.id} value={m.flag}>{m.model}</option>)}
        </select>
      </label>
      <label>
        <span>Effort</span>
        <select value={draft.effort ?? ""} onChange={(event) => set({ effort: event.target.value as Effort })}>
          {efforts.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
        </select>
      </label>
      <label>
        <span>Access</span>
        <select value={draft.access} onChange={(event) => set({ access: event.target.value as AccessLevel })}>
          {access.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
      </label>
      <label>
        <span>Reports to</span>
        <select value={draft.reportsTo ?? ""} onChange={(event) => set({ reportsTo: event.target.value || null })}>
          <option value="">You</option>
          {managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </label>
      <label>
        <span>Available in</span>
        <select value={draft.projectId ?? ""} onChange={(event) => set({ projectId: event.target.value || null })}>
          <option value="">Every project</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      {lead && (
        <p className="settings-note team-form-wide">
          Fable and Astra can lead a task, but they cannot be given one.
        </p>
      )}
      <div className="team-form-actions team-form-wide">
        <button className="vault-button" type="button" onClick={onCancel}>Cancel</button>
        <button className="settings-primary" type="submit" disabled={saving || !draft.name.trim() || !draft.model}>
          {saving ? "Saving…" : draft.id ? "Save" : "Add"}
        </button>
      </div>
    </form>
  );
}
