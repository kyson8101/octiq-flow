// Settings → Agents: the switch for agents mode, and the person's registered
// agents — each a name, a role, and the provider/model/effort/access it runs
// on, either global or belonging to one project — and the peer-help teams they
// sit on, which group agents sideways and never change the org chart.
import { AgentPolicyBlock, TeamsBlock, FrontDeskBlock, agentDetailsPatch, RegisteredAgentsTable, AgentDetailsDialog } from "./AgentsSettingsBlocks";
export { RecipientPicker, CharCounter, AgentPolicyBlock, TeamsBlock, ModelFields, FrontDeskBlock, teamDraftFields, agentDetailsPatch, RegisteredAgentsTable, InlineAgentRow, AgentDetailsDialog, TeamForm } from "./AgentsSettingsBlocks";
import { ActionIcon } from "./ActionIcon";
import { useEffect, useMemo, useRef, useState } from "react";
import "./AgentsSettings.css";
import { type Effort, type Provider } from "../lib/agentProviders";
import { createFrontDesk, deleteAgentTeam, deleteTeamAgent, frontDeskDefaults, loadAgentPolicy, loadAgentTeams, loadFrontDesk, loadHead, loadHome, loadTeam, onTeamChanged, saveAgentPolicy, saveAgentTeam, saveFrontDesk, saveHead, saveHome, saveTeamAgent, type AgentTeam, type AgentTeamDraft, type TeamAgent, type TeamDraft } from "../lib/agentsMode";
import { SchedulingSettings } from "./SchedulingSettings";
import { rolePreview } from "./AgentRole";

export type ProjectRef = { id: string; name: string };

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
  // Edit bases remain fixed across team-changed refreshes until a refused save
  // re-reads the host. Never substitute a newer cache version for consent.
  const [rowBase, setRowBase] = useState<TeamAgent | null>(null);
  const [detailsBase, setDetailsBase] = useState<TeamAgent | null>(null);
  const [details, setDetails] = useState<TeamDraft | null>(null);
  const [detailsError, setDetailsError] = useState("");
  const [headId, setHeadId] = useState<string | null>(null);
  const [homeId, setHomeId] = useState<string | null>(null);
  const [teams, setTeams] = useState<AgentTeam[]>([]);
  const [teamDraft, setTeamDraft] = useState<AgentTeamDraft | null>(null);
  const [deskId, setDeskId] = useState<string | null>(null);
  const [deskBusy, setDeskBusy] = useState(false);
  // The saved policy, and what is in its box: they differ until Save.
  const [policy, setPolicy] = useState("");
  const [policyText, setPolicyText] = useState("");
  const [policyBusy, setPolicyBusy] = useState(false);
  // The host could not read the saved policy (its profile folder is away): a
  // blank box is not offered, because saving it would replace the real one.
  const [policyUnread, setPolicyUnread] = useState(false);
  const policyRef = useRef(policy);
  policyRef.current = policy;

  useEffect(() => {
    let alive = true;
    // An older backend has no teams or front desk: those sections show none.
    Promise.all([
      loadTeam(null, true), loadHead(), loadHome().catch(() => null), loadAgentTeams().catch(() => []),
      loadFrontDesk().catch(() => null), loadAgentPolicy(),
    ])
      .then(([agents, head, home, groups, desk, shared]) => {
        if (!alive) return;
        setTeam(agents);
        setHeadId(head?.id ?? null);
        setHomeId(home);
        setTeams(groups);
        setDeskId(desk?.id ?? null);
        setPolicy(shared.text);
        setPolicyText(shared.text);
      })
      .catch((reason) => {
        if (!alive) return;
        setPolicyUnread(true);
        setError(String((reason as Error).message ?? reason));
      })
      .finally(() => { if (alive) setLoading(false); });
    // An agent or the policy changed from a chat, once the person approved it.
    const off = onTeamChanged(() => {
      loadTeam(null, true).then((agents) => { if (alive) setTeam(agents); }).catch(() => {});
      loadAgentPolicy().then((shared) => {
        if (!alive) return;
        setPolicyUnread(false);
        // Text being typed is kept; an untouched box follows the new policy.
        setPolicyText((typed) => (typed === policyRef.current ? shared.text : typed));
        setPolicy(shared.text);
      }).catch(() => {});
    });
    return () => { alive = false; off(); };
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

  const writePolicy = async (text: string) => {
    setError("");
    setPolicyBusy(true);
    try {
      const saved = await saveAgentPolicy(text);
      setPolicy(saved.text);
      setPolicyText(saved.text);
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
    } finally {
      setPolicyBusy(false);
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
  const save = async () => {
    if (!draft || saving || !draft.name.trim() || !draft.model) return;
    setSaving(true);
    setError("");
    try {
      const saved = await saveTeamAgent({ ...draft, projectId: draft.projectId || null, reportsTo: draft.reportsTo || null }, draft.id ? rowBase?.updatedAt : undefined);
      if (saved.memoryError) setError(`${saved.name} was saved, but its memory note could not be created: ${saved.memoryError}`);
      // Re-read: a save can move nothing else today, but a delete moves
      // reports up, and one source of truth is simpler than two.
      setTeam(await loadTeam(null, true));
      setDraft(null);
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
      // Keep every typed field, but let an explicit retry target the version
      // the refreshed list now shows. A failed read retains the old base.
      try {
        const latest = await loadTeam(null, true);
        setTeam(latest);
        setRowBase(latest.find((agent) => agent.id === draft.id) ?? rowBase);
      } catch { /* The save error remains visible. */ }
    } finally {
      setSaving(false);
    }
  };

  const saveDetails = async () => {
    if (!details || saving) return;
    const patch = agentDetailsPatch(details);
    // An editing row owns its whole draft; the modal stages only its long
    // fields, and Cancel on the row still discards all of those changes.
    if (draft && draft.id === details.id) {
      setDraft({ ...draft, ...patch });
      setDetails(null);
      return;
    }
    const current = detailsBase;
    if (!current) { setDetailsError("This agent is no longer registered."); return; }
    setSaving(true);
    setError("");
    setDetailsError("");
    try {
      const saved = await saveTeamAgent({ ...current, ...patch }, current.updatedAt);
      if (saved.memoryError) setError(`${saved.name} was saved, but its memory note could not be created: ${saved.memoryError}`);
      setTeam(await loadTeam(null, true));
      setDetails(null);
    } catch (reason) {
      setDetailsError(String((reason as Error).message ?? reason));
      try {
        const latest = await loadTeam(null, true);
        setTeam(latest);
        setDetailsBase(latest.find((agent) => agent.id === details.id) ?? detailsBase);
      } catch { /* Keep the modal text and original save error. */ }
    } finally { setSaving(false); }
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

  return (
    <section className="settings-section team-settings" aria-labelledby="settings-agents-title">
      <header className="settings-section-head">
        <div>
          <h2 id="settings-agents-title">Agents</h2>
          <p>Register agents, then hand a task to one. It does the task, passes it on, or splits it across the others.</p>
        </div>
      </header>

      <SchedulingSettings agentsMode={on} />

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

      <AgentPolicyBlock
        saved={policy}
        text={policyText}
        loading={loading}
        busy={policyBusy}
        unread={policyUnread}
        onChange={setPolicyText}
        onSave={() => void writePolicy(policyText)}
        onClear={() => void writePolicy("")}
      />

      <div className="team-head">
        <h3>Registered agents</h3>
        <button className="settings-primary" type="button" onClick={() => setDraft(blank(null))} disabled={loading || !!draft || saving} data-icon-action aria-label="Add agent" title="Add agent"><ActionIcon name="new" label="Add agent" /></button>
      </div>

      {error && <p className="set-warn" role="alert">{error}</p>}

      {loading ? (
        <p role="status" className="settings-note">Loading agents…</p>
      ) : team.length === 0 && !draft ? (
        <div className="settings-empty">
          <strong>No agents yet</strong>
          <span>Add one with a name, a role and the model it runs on.</span>
        </div>
      ) : (
        <RegisteredAgentsTable team={team} teams={teams} projects={projects} draft={draft} saving={saving}
          onDraft={(next) => {
            if (!draft) setRowBase(team.find((agent) => agent.id === next?.id) ?? null);
            setDraft(next);
          }} onSave={() => void save()} onRemove={(agent) => void remove(agent)}
          onDetails={(agent) => {
            setDetailsError("");
            setDetailsBase(team.find((item) => item.id === agent.id) ?? null);
            setDetails({ ...agent });
          }} />
      )}

      {details && <AgentDetailsDialog draft={details} staged={!!draft && draft.id === details.id}
        saving={saving} error={detailsError} onChange={setDetails}
        onSave={() => void saveDetails()} onClose={() => { if (!saving) setDetails(null); }} />}

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

