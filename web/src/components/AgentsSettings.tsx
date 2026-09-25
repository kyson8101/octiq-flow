// Settings → Agents: the switch for agents mode, and the person's registered
// agents — each a name, a role, and the provider/model/effort/access it runs
// on, either global or belonging to one project.
import { useEffect, useMemo, useState } from "react";
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
    <li className="team-row" key={agent.id} style={{ paddingInlineStart: `${depth * 22}px` }}>
      {depth > 0 && <span className="team-row-branch" aria-hidden="true">└</span>}
      <AgentAvatar name={agent.name} avatar={agent.avatar} id={agent.id} size={28} decorative />
      <span className="team-row-copy">
        <span className="team-row-name">
          {agent.name}
          {leadOnly(agent) && <span className="team-tag" title="Fable and Astra can lead a task but cannot take one">lead only</span>}
        </span>
        <span className="team-row-meta">
          {AGENT_NAME[agent.agent]} {modelLabel(agent)}{agent.effort ? ` · ${agent.effort}` : ""}
          {" · "}{agent.projectId ? projectName.get(agent.projectId) ?? "Removed project" : "Every project"}
        </span>
        {agent.role && <span className="team-row-role">{agent.role}</span>}
      </span>
      <button className="vault-button" type="button" onClick={() => setDraft({ ...agent, projectId: agent.projectId ?? null, reportsTo: agent.reportsTo ?? null })}>Edit</button>
      <button className="vault-button" type="button" aria-label={`Remove ${agent.name}`} onClick={() => void remove(agent)}>Remove</button>
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
          <p>New chat becomes New task. You pick which agent gets it. Off, chats work as they always have.</p>
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
            <option key={agent.id} value={agent.id}>{agent.name}{agent.role ? ` · ${agent.role}` : ""}</option>
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

/** The new-task hero's "who gets this". Picking one sets the chat's model,
 *  effort and access to that agent's; the first message carries the brief. */
export function LeadPicker({ team, leadId, onPick, onManage }: {
  team: TeamAgent[];
  leadId: string | null;
  onPick: (agent: TeamAgent) => void;
  onManage: () => void;
}) {
  if (team.length === 0) {
    return (
      <div className="lead-picker">
        <p className="lead-picker-note">
          No agents registered yet. <button type="button" onClick={onManage}>Add one in Settings</button> to hand tasks out.
        </p>
      </div>
    );
  }
  return (
    <div className="lead-picker" role="radiogroup" aria-label="Hand this task to">
      <span className="lead-picker-label">Hand this task to</span>
      <div className="lead-picker-list">
        {team.map((agent) => (
          <button
            key={agent.id}
            className={`lead-chip${agent.id === leadId ? " is-on" : ""}`}
            type="button"
            role="radio"
            aria-checked={agent.id === leadId}
            title={[agent.role, `${AGENT_NAME[agent.agent]} ${modelLabel(agent)}`].filter(Boolean).join("\n")}
            onClick={() => onPick(agent)}
          >
            <AgentAvatar name={agent.name} avatar={agent.avatar} id={agent.id} size={20} decorative />
            <span className="lead-chip-name">{agent.name}</span>
          </button>
        ))}
      </div>
      <p className="lead-picker-note">
        It does the task itself, passes it on, or splits it across the team. <button type="button" onClick={onManage}>Manage agents</button>
      </p>
    </div>
  );
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
