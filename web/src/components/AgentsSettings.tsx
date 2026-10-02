// Settings → Agents: the switch for agents mode, and the person's registered
// agents — each a name, a role, and the provider/model/effort/access it runs
// on, either global or belonging to one project — and the peer-help teams they
// sit on, which group agents sideways and never change the org chart.
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import "./AgentsSettings.css";
import {
  ACCESS, AGENT_NAME, EFFORTS,
  type AccessLevel, type Effort, type Provider,
} from "../lib/agentProviders";
import {
  createFrontDesk, deleteAgentTeam, deleteTeamAgent, frontDeskDefaults, frontDeskRefusal, joinableTeams, leadOnly,
  loadAgentTeams, loadFrontDesk, loadHead, loadHome, loadTeam,
  saveAgentTeam, saveFrontDesk, saveHead, saveHome, saveTeamAgent, teamModelLabel, teamModels,
  type AgentTeam, type AgentTeamDraft, type TeamAgent, type TeamDraft,
} from "../lib/agentsMode";
import { orgChart, teamBadge } from "../lib/agentsDashboard";
import { AgentAvatar } from "./AgentAvatar";
import { AgentAvatarEditor } from "./AgentAvatarEditor";
import { AgentRole, rolePreview } from "./AgentRole";
import { sharedProject } from "../lib/frontDesk";

type ProjectRef = { id: string; name: string };

const PROVIDERS: Provider[] = ["claude", "codex"];

function blank(projectId: string | null): TeamDraft {
  return { name: "", role: "", agent: "claude", model: "sonnet", effort: "medium", access: "auto", projectId, reportsTo: null, teamId: null };
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
  const [teams, setTeams] = useState<AgentTeam[]>([]);
  const [teamDraft, setTeamDraft] = useState<AgentTeamDraft | null>(null);
  const [deskId, setDeskId] = useState<string | null>(null);
  const [deskBusy, setDeskBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    // An older backend has no teams or front desk: those sections show none.
    Promise.all([
      loadTeam(null, true), loadHead(), loadHome().catch(() => null), loadAgentTeams().catch(() => []),
      loadFrontDesk().catch(() => null),
    ])
      .then(([agents, head, home, groups, desk]) => {
        if (!alive) return;
        setTeam(agents);
        setHeadId(head?.id ?? null);
        setHomeId(home);
        setTeams(groups);
        setDeskId(desk?.id ?? null);
      })
      .catch((reason) => { if (alive) setError(String((reason as Error).message ?? reason)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  // Only a global agent can be talked to from every project.
  // The front desk only routes, so it is not offered as the lead either.
  const globalAgents = useMemo(() => team.filter((agent) => !agent.projectId && agent.id !== deskId), [team, deskId]);
  const pickHead = async (id: string | null) => {
    setError("");
    try {
      const head = await saveHead(id);
      setHeadId(head?.id ?? null);
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
    }
  };

  const desk = useMemo(() => team.find((agent) => agent.id === deskId) ?? null, [team, deskId]);
  const deskAction = async (act: () => Promise<void>) => {
    setError("");
    setDeskBusy(true);
    try {
      await act();
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
    } finally {
      setDeskBusy(false);
    }
  };
  const pickDesk = (id: string | null) => deskAction(async () => {
    setDeskId((await saveFrontDesk(id))?.id ?? null);
  });
  const createDesk = () => deskAction(async () => {
    const created = await createFrontDesk({ agent: "claude", ...frontDeskDefaults("claude") });
    setTeam(await loadTeam(null, true));
    setDeskId(created.id);
  });
  const changeDesk = (settings: { agent: Provider; model: string; effort?: Effort }) => deskAction(async () => {
    if (!desk) return;
    await saveTeamAgent({
      id: desk.id, name: desk.name, role: desk.role, agent: settings.agent, model: settings.model,
      effort: settings.effort, access: desk.access, projectId: null, reportsTo: null, teamId: desk.teamId ?? null,
    });
    setTeam(await loadTeam(null, true));
  });

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

  const saveTeam = async () => {
    if (!teamDraft) return;
    setError("");
    try {
      await saveAgentTeam(teamDraft);
      setTeams(await loadAgentTeams());
      setTeamDraft(null);
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
    }
  };

  const removeTeam = async (group: AgentTeam) => {
    setError("");
    try {
      await deleteAgentTeam(group.id);
      // Its members stay registered, on no team.
      setTeams(await loadAgentTeams());
      setTeam(await loadTeam(null, true));
      if (teamDraft?.id === group.id) setTeamDraft(null);
      if (draft?.teamId === group.id) setDraft({ ...draft, teamId: null });
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
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
      setDeskId((await loadFrontDesk().catch(() => null))?.id ?? null);
      if (draft?.id === agent.id) setDraft(null);
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
    }
  };

  const row = ({ agent, depth }: { agent: TeamAgent; depth: number }) => {
    const badge = teamBadge(agent, teams);
    return (
    <li className="team-row" key={agent.id} style={{ "--team-depth": depth } as React.CSSProperties}>
      <div className="team-row-head">
        {depth > 0 && <span className="team-row-branch" aria-hidden="true">└</span>}
        <AgentAvatar name={agent.name} avatar={agent.avatar} id={agent.id} size={28} decorative />
        <span className="team-row-copy">
          <span className="team-row-name">
            <bdi>{agent.name}</bdi>
            {leadOnly(agent) && <span className="team-tag" title="Fable and Astra can lead a task but cannot take one">lead only</span>}
            {badge && <span className="team-tag team-badge" title={`On the team ${badge.name}: may ask its teammates for help`}><bdi>{badge.name}</bdi></span>}
          </span>
          <span className="team-row-meta">
            {AGENT_NAME[agent.agent]} {teamModelLabel(agent)}{agent.effort ? ` · ${agent.effort}` : ""}
            {" · "}{agent.projectId ? projectName.get(agent.projectId) ?? "Removed project" : "Every project"}
          </span>
        </span>
        <span className="team-row-actions">
          <button className="vault-button team-row-action" type="button" aria-label={`Edit ${agent.name}`} title="Edit"
            onClick={() => setDraft({ ...agent, projectId: agent.projectId ?? null, reportsTo: agent.reportsTo ?? null, teamId: agent.teamId ?? null })}>
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
  };

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

      <div className="settings-control-row team-choice-row">
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

      <FrontDeskBlock
        desk={desk}
        roster={team}
        headId={headId}
        loading={loading}
        busy={deskBusy}
        onPick={(id) => void pickDesk(id)}
        onCreate={() => void createDesk()}
        onSettings={(settings) => void changeDesk(settings)}
      />

      <div className="settings-control-row team-choice-row">
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
          teams={teams}
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

      <TeamsBlock
        teams={teams}
        agents={team}
        draft={teamDraft}
        projects={projects}
        projectName={(id) => projectName.get(id)}
        onDraft={setTeamDraft}
        onSave={() => void saveTeam()}
        onRemove={(group) => void removeTeam(group)}
      />
    </section>
  );
}

/** A new conversation's "who is this with": the agents reporting directly to
 *  the person (`conversationRecipients`), never anyone's report. Picking one
 *  sets the chat's model, effort and access to that agent's; the first message
 *  carries its brief. With a single choice already made there is nothing to
 *  pick, so it draws nothing. A radio group: arrow keys move the choice, Tab
 *  leaves it. */
export function RecipientPicker({ agents, selectedId, projectName, onPick, onManage, showManage = true, label = "Talk to" }: {
  agents: readonly TeamAgent[];
  selectedId: string | null;
  /** A project agent's project, named on its chip. */
  projectName: (id: string) => string | undefined;
  onPick: (agent: TeamAgent) => void;
  onManage: () => void;
  /** Off where the page draws "Manage agents" itself, beside its other links. */
  showManage?: boolean;
  label?: string;
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
  // Every row in one project: say it once, not on every row.
  const shared = sharedProject(agents);
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
      {shared && (
        <p className="lead-picker-scope">All in {projectName(shared) ?? "another project"}</p>
      )}
      <div className="lead-picker-list" role="radiogroup" aria-label={label} onKeyDown={move}>
        {agents.map((agent) => {
          const project = agent.projectId ? projectName(agent.projectId) ?? "another project" : null;
          const meta = shared ? null : project;
          return (
            <button
              key={agent.id}
              className={`lead-chip${agent.id === selectedId ? " is-on" : ""}`}
              type="button"
              role="radio"
              aria-checked={agent.id === selectedId}
              tabIndex={agent.id === focusable ? 0 : -1}
              title={[agent.role, project ? `Works in ${project}` : "Works in any project", `${AGENT_NAME[agent.agent]} ${teamModelLabel(agent)}`]
                .filter(Boolean).join("\n")}
              onClick={() => onPick(agent)}
            >
              <AgentAvatar name={agent.name} avatar={agent.avatar} id={agent.id} size={20} decorative />
              <span className="lead-chip-name">{agent.name}</span>
              {meta && <span className="lead-chip-meta">{meta}</span>}
            </button>
          );
        })}
      </div>
      {/* Who is offered is the org chart's top row; the chips say who, so
          only the way to change it is left under them. */}
      {showManage && (
        <p className="lead-picker-note">
          <button type="button" onClick={onManage}>Manage agents</button>
        </p>
      )}
    </div>
  );
}

function EditIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></svg>;
}

function RemoveIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13" /><path d="M9 7V4h6v3" /></svg>;
}

/** The peer-help teams: add, rename, move between global and one project,
 *  remove. One line each, with how many agents are on it; the members are
 *  picked on each agent's own form. */
export function TeamsBlock({ teams, agents, draft, projects, projectName, onDraft, onSave, onRemove }: {
  teams: AgentTeam[];
  agents: TeamAgent[];
  draft: AgentTeamDraft | null;
  projects: ProjectRef[];
  projectName: (id: string) => string | undefined;
  onDraft: (draft: AgentTeamDraft | null) => void;
  onSave: () => void;
  onRemove: (team: AgentTeam) => void;
}) {
  const editor = (
    <form className="team-group-form" aria-label={draft?.id ? "Rename team" : "New team"}
      onSubmit={(event) => { event.preventDefault(); onSave(); }}>
      <input value={draft?.name ?? ""} maxLength={60} placeholder="Team name" aria-label="Team name" autoFocus
        onChange={(event) => draft && onDraft({ ...draft, name: event.target.value })} />
      <select aria-label="Team available in" value={draft?.projectId ?? ""}
        onChange={(event) => draft && onDraft({ ...draft, projectId: event.target.value || null })}>
        <option value="">Every project</option>
        {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <button className="vault-button" type="button" onClick={() => onDraft(null)}>Cancel</button>
      <button className="settings-primary" type="submit" disabled={!draft?.name.trim()}>{draft?.id ? "Save" : "Add"}</button>
    </form>
  );
  return (
    <div className="team-groups">
      <div className="team-head">
        <h3>Teams</h3>
        <button className="vault-button" type="button" disabled={!!draft && !draft.id}
          onClick={() => onDraft({ name: "", projectId: null })}>Add team</button>
      </div>
      <p className="settings-note">Agents on one team may ask each other questions while they work. Teammates answer; they never take the work, and a team changes no one's manager.</p>
      {draft && !draft.id && editor}
      {teams.length > 0 && (
        <ul className="team-group-list" aria-label="Teams">
          {teams.map((group) => {
            const members = agents.filter((agent) => agent.teamId === group.id).length;
            if (draft?.id === group.id) return <li key={group.id}>{editor}</li>;
            return (
              <li key={group.id} className="team-group-row">
                <span className="team-group-copy">
                  <span className="team-row-name"><bdi>{group.name}</bdi></span>
                  <span className="team-row-meta">
                    {members} {members === 1 ? "agent" : "agents"} · {group.projectId ? projectName(group.projectId) ?? "Removed project" : "Every project"}
                  </span>
                </span>
                <span className="team-row-actions">
                  <button className="vault-button team-row-action" type="button" aria-label={`Rename ${group.name}`} title="Rename"
                    onClick={() => onDraft({ id: group.id, name: group.name, projectId: group.projectId ?? null })}>
                    <EditIcon /><span className="team-row-action-text">Rename</span>
                  </button>
                  <button className="vault-button team-row-action" type="button" aria-label={`Remove team ${group.name}`} title="Remove team"
                    onClick={() => onRemove(group)}>
                    <RemoveIcon /><span className="team-row-action-text">Remove</span>
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Provider, model and effort: the same three selects wherever an agent's
 *  model is chosen (the agent form, the front desk). */
export function ModelFields({ agent, model, effort, onProvider, onModel, onEffort, disabled }: {
  agent: Provider;
  model: string;
  effort?: Effort;
  onProvider: (agent: Provider) => void;
  onModel: (model: string) => void;
  onEffort: (effort: Effort) => void;
  disabled?: boolean;
}) {
  return (
    <>
      <label>
        <span>Provider</span>
        <select value={agent} disabled={disabled} onChange={(event) => onProvider(event.target.value as Provider)}>
          {PROVIDERS.map((p) => <option key={p} value={p}>{AGENT_NAME[p]}</option>)}
        </select>
      </label>
      <label>
        <span>Model</span>
        <select value={model} disabled={disabled} onChange={(event) => onModel(event.target.value)}>
          {teamModels(agent).map((m) => <option key={m.id} value={m.flag}>{m.model}</option>)}
        </select>
      </label>
      <label>
        <span>Effort</span>
        <select value={effort ?? ""} disabled={disabled} onChange={(event) => onEffort(event.target.value as Effort)}>
          {EFFORTS[agent].map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
        </select>
      </label>
    </>
  );
}

/** Settings → Agents: the front desk every new chat opens on. Pick one, or
 *  create one in a step on the smallest model at its lowest effort, and
 *  change what it runs on here; it is read for every new chat, so a change
 *  needs no restart. The head and any agent who manages others are not
 *  offered: a front desk's chats are hidden and it only routes. */
export function FrontDeskBlock({ desk, roster, headId, loading, busy, onPick, onCreate, onSettings }: {
  desk: TeamAgent | null;
  roster: readonly TeamAgent[];
  headId: string | null;
  loading: boolean;
  busy: boolean;
  onPick: (id: string | null) => void;
  onCreate: () => void;
  onSettings: (settings: { agent: Provider; model: string; effort?: Effort }) => void;
}) {
  const globals = roster.filter((agent) => !agent.projectId);
  const unavailable = globals.filter((agent) => agent.id !== desk?.id && frontDeskRefusal(agent, roster, headId));
  return (
    <div className="front-desk-block">
      <div className="settings-control-row team-choice-row">
        <div className="settings-control-copy">
          <h3>Front desk</h3>
          <p>Every new chat opens on it. It works out who should handle what you ask and opens that agent's chat once you confirm on a card. Its own chats are never listed.</p>
        </div>
        <select
          className="team-head-select"
          aria-label="Front desk"
          value={desk?.id ?? ""}
          disabled={loading || busy}
          onChange={(event) => onPick(event.target.value || null)}
        >
          <option value="">No front desk</option>
          {globals.map((agent) => {
            const refused = agent.id === desk?.id ? null : frontDeskRefusal(agent, roster, headId);
            return (
              <option key={agent.id} value={agent.id} disabled={!!refused}>
                {agent.name}{refused ? " · not available" : ""}
              </option>
            );
          })}
        </select>
      </div>
      {unavailable.length > 0 && (
        <p className="settings-note front-desk-unavailable">
          Not available: {unavailable.map((agent) => agent.name).join(", ")}. The lead you talk to across projects
          and agents who manage others keep their own chats; a front desk's chats are hidden and it only routes.
        </p>
      )}
      {desk ? (
        <div className="front-desk-model" role="group" aria-label={`What ${desk.name} runs on`}>
          <ModelFields
            agent={desk.agent}
            model={desk.model}
            effort={desk.effort}
            disabled={busy}
            onProvider={(agent) => onSettings({ agent, ...frontDeskDefaults(agent) })}
            onModel={(model) => onSettings({ agent: desk.agent, model, effort: desk.effort })}
            onEffort={(effort) => onSettings({ agent: desk.agent, model: desk.model, effort })}
          />
          <p className="settings-note">Now {AGENT_NAME[desk.agent]} {teamModelLabel(desk)}{desk.effort ? ` · ${desk.effort}` : ""}. Used from the next new chat.</p>
        </div>
      ) : (
        <div className="front-desk-create">
          <button className="settings-primary" type="button" disabled={loading || busy} onClick={onCreate}>
            Create front desk
          </button>
          <span className="settings-note">
            A router on {AGENT_NAME.claude} {teamModelLabel({ agent: "claude", model: frontDeskDefaults("claude").model })}, {frontDeskDefaults("claude").effort} effort. You can change what it runs on here after.
          </span>
        </div>
      )}
    </div>
  );
}

export function TeamForm({ draft, team, teams, projects, saving, onChange, onSave, onCancel }: {
  draft: TeamDraft;
  team: TeamAgent[];
  teams: AgentTeam[];
  projects: ProjectRef[];
  saving: boolean;
  onChange: (draft: TeamDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
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
  // A project agent joins a global team or its own project's; the host
  // refuses anything else.
  const joinable = joinableTeams(teams, draft.projectId);
  const pickProject = (projectId: string | null) => {
    const keeps = !draft.teamId || joinableTeams(teams, projectId).some((group) => group.id === draft.teamId);
    set({ projectId, ...(keeps ? {} : { teamId: null }) });
  };

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
      <ModelFields
        agent={draft.agent}
        model={draft.model}
        effort={draft.effort}
        onProvider={pickProvider}
        onModel={(model) => set({ model })}
        onEffort={(effort) => set({ effort })}
      />
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
        <select value={draft.projectId ?? ""} onChange={(event) => pickProject(event.target.value || null)}>
          <option value="">Every project</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <label>
        <span>Team</span>
        <select value={draft.teamId ?? ""} onChange={(event) => set({ teamId: event.target.value || null })}>
          <option value="">None</option>
          {joinable.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
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
