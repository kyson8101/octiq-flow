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
  deleteTeamAgent, leadOnly, loadTeam, saveTeamAgent, teamModels,
  type TeamAgent, type TeamDraft,
} from "../lib/agentsMode";
import { AgentLogo } from "./AgentLogo";

type ProjectRef = { id: string; name: string };

const PROVIDERS: Provider[] = ["claude", "codex"];

function blank(projectId: string | null): TeamDraft {
  return { name: "", role: "", agent: "claude", model: "sonnet", effort: "medium", access: "auto", projectId };
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

  useEffect(() => {
    let alive = true;
    loadTeam(null, true)
      .then((agents) => { if (alive) setTeam(agents); })
      .catch((reason) => { if (alive) setError(String((reason as Error).message ?? reason)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const projectName = useMemo(
    () => new Map(projects.map((p) => [p.id, p.name])),
    [projects],
  );
  const groups = useMemo(() => {
    const global = team.filter((a) => !a.projectId);
    const byProject = new Map<string, TeamAgent[]>();
    for (const agent of team) {
      if (!agent.projectId) continue;
      byProject.set(agent.projectId, [...(byProject.get(agent.projectId) ?? []), agent]);
    }
    return { global, byProject };
  }, [team]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError("");
    try {
      const saved = await saveTeamAgent({ ...draft, projectId: draft.projectId || null });
      setTeam((before) => before.some((a) => a.id === saved.id)
        ? before.map((a) => (a.id === saved.id ? saved : a))
        : [...before, saved]);
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
      setTeam((before) => before.filter((a) => a.id !== agent.id));
      if (draft?.id === agent.id) setDraft(null);
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
    }
  };

  const row = (agent: TeamAgent) => (
    <li className="team-row" key={agent.id}>
      <AgentLogo agent={agent.agent === "codex" ? "codex" : "claude"} size={16} />
      <span className="team-row-copy">
        <span className="team-row-name">
          {agent.name}
          {leadOnly(agent) && <span className="team-tag" title="Fable and Astra can lead a task but cannot take one">lead only</span>}
        </span>
        <span className="team-row-meta">
          {AGENT_NAME[agent.agent]} {modelLabel(agent)}{agent.effort ? ` · ${agent.effort}` : ""}
        </span>
        {agent.role && <span className="team-row-role">{agent.role}</span>}
      </span>
      <button className="vault-button" type="button" onClick={() => setDraft({ ...agent, projectId: agent.projectId ?? null })}>Edit</button>
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
        <>
          {groups.global.length > 0 && (
            <div className="team-group">
              <h4>Global · every project</h4>
              <ul className="team-list">{groups.global.map(row)}</ul>
            </div>
          )}
          {[...groups.byProject].map(([projectId, agents]) => (
            <div className="team-group" key={projectId}>
              <h4>{projectName.get(projectId) ?? "Removed project"}</h4>
              <ul className="team-list">{agents.map(row)}</ul>
            </div>
          ))}
        </>
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
            title={agent.role || undefined}
            onClick={() => onPick(agent)}
          >
            <AgentLogo agent={agent.agent === "codex" ? "codex" : "claude"} size={13} />
            <span className="lead-chip-name">{agent.name}</span>
            <span className="lead-chip-meta">{modelLabel(agent)}</span>
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

function TeamForm({ draft, projects, saving, onChange, onSave, onCancel }: {
  draft: TeamDraft;
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

  return (
    <form className="team-form" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
      <label>
        <span>Name</span>
        <input value={draft.name} maxLength={60} placeholder="e.g. Reviewer" autoFocus
          onChange={(event) => set({ name: event.target.value })} />
      </label>
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
