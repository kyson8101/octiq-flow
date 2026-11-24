// The blocks of the agents settings page (moved verbatim from AgentsSettings.tsx).
import type { ProjectRef } from "./AgentsSettings";
import { ActionIcon } from "./ActionIcon";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  ACCESS, AGENT_NAME, EFFORTS, providerFor,
  type AccessLevel, type Effort, type Provider,
} from "../lib/agentProviders";
import { AGENT_POLICY_MAX, PERSISTENT_PROMPT_MAX, ROLE_MAX, charCount, frontDeskDefaults, frontDeskRefusal, joinableTeams, leadOnly, serverNames, teamModelLabel, teamModels, type AgentTeam, type AgentTeamDraft, type TeamAgent, type TeamDraft } from "../lib/agentsMode";
import { orgChart, teamBadge } from "../lib/agentsDashboard";
import { AgentAvatar } from "./AgentAvatar";
import { AgentAvatarEditor } from "./AgentAvatarEditor";
import { rolePreview } from "./AgentRole";
import { sharedProject } from "../lib/frontDesk";
import { useTeamModels } from "../lib/useTeamModels";
import { modelOptions, selectedModel } from "./modelOptions";

const PROVIDERS: Provider[] = ["claude", "codex", "pi", "antigravity"];

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

/** "1,234 / 8,000", the way the host counts. Over the cap it says so, and the
 *  host refuses the save. */
export function CharCounter({ text, max }: { text: string; max: number }) {
  const count = charCount(text);
  const over = count > max;
  return (
    <small className={`team-field-count${over ? " is-over" : ""}`}>
      {count.toLocaleString("en-US")} / {max.toLocaleString("en-US")}
      {over ? " · too long" : ""}
    </small>
  );
}

/** Settings → Agents: the person's shared rules for every registered agent,
 *  put ahead of each one's own standing instructions and role in every brief
 *  it is launched with. Above the roster, because it applies to all of it. */
export function AgentPolicyBlock({ saved, text, loading, busy, unread = false, onChange, onSave, onClear }: {
  saved: string;
  text: string;
  loading: boolean;
  busy: boolean;
  /** The saved policy could not be read: nothing can be typed or saved over it. */
  unread?: boolean;
  onChange: (text: string) => void;
  onSave: () => void;
  onClear: () => void;
}) {
  const changed = text.trim() !== saved.trim();
  const over = charCount(text) > AGENT_POLICY_MAX;
  loading = loading || unread;
  return (
    <form className="agent-policy" aria-labelledby="agent-policy-title"
      onSubmit={(event) => { event.preventDefault(); if (changed && !over && !unread) onSave(); }}>
      <div className="team-field-head">
        <h3 id="agent-policy-title">Agent policy</h3>
        <CharCounter text={text} max={AGENT_POLICY_MAX} />
      </div>
      <p className="settings-note" id="agent-policy-hint">
        Shared rules for every agent. Prepended to every agent's brief, ahead of its persistent prompt and role, so rules everyone follows need not be copied into each role. Applies to new chats and tasks.
      </p>
      <textarea
        className="agent-policy-text"
        aria-labelledby="agent-policy-title"
        aria-describedby="agent-policy-hint"
        value={text}
        maxLength={AGENT_POLICY_MAX}
        rows={5}
        disabled={loading || busy}
        placeholder="e.g. Work in a git worktree. Never push or release without asking."
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="agent-policy-actions">
        <button className="vault-button" type="button" disabled={loading || busy || !saved}
          onClick={onClear} data-icon-action title="Clear" aria-label="Clear">
          <ActionIcon name="dismiss" label="Clear" />
        </button>
        <button className="settings-primary" type="submit" disabled={loading || busy || !changed || over} data-icon-action title={busy ? "Saving…" : "Save policy"} aria-label={busy ? "Saving…" : "Save policy"}>
          <ActionIcon name="save" label="Save" />
        </button>
      </div>
    </form>
  );
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
      <button className="vault-button" type="button" onClick={() => onDraft(null)} data-icon-action title="Cancel" aria-label="Cancel">
        <ActionIcon name="cancel" label="Cancel" />
      </button>
      <button className="settings-primary" type="submit" disabled={!draft?.name.trim()} data-icon-action title={draft?.id ? "Save" : "Add"} aria-label={draft?.id ? "Save" : "Add"}>
        <ActionIcon name="save" label={draft?.id ? "Save" : "Add"} />
      </button>
    </form>
  );
  return (
    <div className="team-groups">
      <div className="team-head">
        <h3>Teams</h3>
        <button className="vault-button" type="button" disabled={!!draft && !draft.id}
          onClick={() => onDraft({ name: "", projectId: null })} data-icon-action aria-label="Add team" title="Add team"><ActionIcon name="new" label="Add team" /></button>
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
                  <button className="vault-button team-row-action" type="button" aria-label={`Rename ${group.name}`} title={`Rename ${group.name}`}
                    onClick={() => onDraft({ id: group.id, name: group.name, projectId: group.projectId ?? null })} data-icon-action aria-description="Rename">
                    <ActionIcon name="edit" />
                  </button>
                  <button className="vault-button team-row-action" type="button" aria-label={`Remove team ${group.name}`} title={`Remove team ${group.name}`}
                    onClick={() => onRemove(group)} data-icon-action aria-description="Remove team">
                    <ActionIcon name="delete" />
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
  const models = useTeamModels(agent);
  return (
    <>
      <label>
        <span>Provider</span>
        <select aria-label="Provider" value={agent} disabled={disabled} onChange={(event) => onProvider(event.target.value as Provider)}>
          {PROVIDERS.map((p) => <option key={p} value={p}>{AGENT_NAME[p]}</option>)}
        </select>
      </label>
      <label>
        <span>Model</span>
        <select aria-label="Model" value={selectedModel(agent, model, models)} disabled={disabled} onChange={(event) => onModel(event.target.value)}>
          {modelOptions(agent, model, models)}
        </select>
      </label>
      <label>
        <span>Effort</span>
        <select aria-label="Effort" value={effort ?? ""} disabled={disabled} onChange={(event) => onEffort(event.target.value as Effort)}>
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

/** Shared by the compact row and the full form: provider resets, reporting
 * visibility/loop protection and project/team compatibility stay together. */
export function teamDraftFields(draft: TeamDraft, team: TeamAgent[], teams: AgentTeam[], onChange: (draft: TeamDraft) => void) {
  const access = ACCESS[draft.agent];
  const set = (patch: Partial<TeamDraft>) => onChange({ ...draft, ...patch });
  const pickProvider = (agent: Provider) => {
    const model = teamModels(agent)[0]?.flag ?? "";
    const effort = EFFORTS[agent].some((e) => e.id === draft.effort) ? draft.effort : EFFORTS[agent][0]?.id;
    // A level the provider does not offer (Pi has no Auto) moves to the
    // nearest one it does: Auto if it has it, else Accept edits.
    const level = ACCESS[agent].some((a) => a.id === draft.access) ? draft.access
      : ACCESS[agent].some((a) => a.id === "auto") ? "auto" : "edits";
    // Browser and computer use for workers is Codex's, and extra MCP servers
    // for workers are Claude's and Codex's; leaving them ends each.
    onChange({ ...draft, agent, model, effort, access: level, ...(agent === "codex" ? {} : { desktopTools: false }),
      ...(agent === "claude" || agent === "codex" ? {} : { workerServers: [] }) });
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

  return { access, set, pickProvider, lead, managers, joinable, pickProject };
}

/** Only these fields belong to the details modal. Other fields come
 * from the row draft, or the modal edit base checked by the host on Save. */
export function agentDetailsPatch(draft: TeamDraft) {
  return { role: draft.role, persistentPrompt: draft.persistentPrompt, avatar: draft.avatar };
}

export function RegisteredAgentsTable({ team, teams, projects, draft, saving, onDraft, onSave, onRemove, onDetails }: {
  team: TeamAgent[]; teams: AgentTeam[]; projects: ProjectRef[]; draft: TeamDraft | null; saving: boolean;
  onDraft: (draft: TeamDraft | null) => void; onSave: () => void;
  onRemove: (agent: TeamAgent) => void; onDetails: (draft: TeamDraft) => void;
}) {
  // A host refresh updates the roster, never the in-flight row's values.
  // Keep its row visible even if the agent was removed on another device.
  const roster = draft?.id && !team.some((agent) => agent.id === draft.id)
    ? [...team, { ...draft, id: draft.id, createdAt: 0, updatedAt: 0 } as TeamAgent] : team;
  const rowProps = { team, teams, projects, saving, onChange: onDraft, onSave, onCancel: () => onDraft(null), onDetails };
  return <div className="registered-agents">
    <p className="settings-note">Agents at the top report to you. Edit one row at a time.</p>
    <table className="agents-table" aria-label="Registered agents">
      <colgroup><col className="agents-col-agent" /><col className="agents-col-model" /><col className="agents-col-access" />
        <col className="agents-col-manager" /><col className="agents-col-project" /><col className="agents-col-team" /><col className="agents-col-actions" /></colgroup>
      <thead><tr>{["Agent", "Model", "Access", "Reports to", "Available in", "Team", "Actions"].map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
      <tbody>
        {draft && !draft.id && <InlineAgentRow {...rowProps} key="new" draft={draft} depth={0} />}
        {orgChart(roster).map(({ agent, depth }) => draft?.id === agent.id
          ? <InlineAgentRow {...rowProps} key={agent.id} draft={draft} depth={depth} />
          : <tr key={agent.id}>
            <td data-label="Agent"><AgentIdentity agent={agent} teams={teams} depth={depth}
              roleButton={<button type="button" className="agent-role-button" aria-label={`Edit role, prompt and avatar for ${agent.name}`}
                disabled={saving || !!draft} onClick={() => onDetails(agent)} title={agent.role || "Add role"}>
                {agent.role ? rolePreview(agent.role) : "Add role"}</button>} /></td>
            <AgentValue label="Model" text={`${AGENT_NAME[agent.agent]} · ${teamModelLabel(agent)}${agent.effort ? ` · ${agent.effort}` : ""}`} />
            <AgentValue label="Access" text={ACCESS[agent.agent].find((level) => level.id === agent.access)?.label ?? agent.access} />
            <AgentValue label="Reports to" text={agent.reportsTo ? team.find((manager) => manager.id === agent.reportsTo)?.name ?? "Removed agent" : "You"} />
            <AgentValue label="Available in" text={agent.projectId ? projects.find((project) => project.id === agent.projectId)?.name ?? "Removed project" : "Every project"} />
            <AgentValue label="Team" text={teams.find((group) => group.id === agent.teamId)?.name ?? "None"} />
            <td data-label="Actions"><div className="agents-row-actions">
              <button type="button" className="vault-button agents-icon-action" disabled={saving || !!draft} aria-label={`Edit ${agent.name}`} title={`Edit ${agent.name}`}
                onClick={() => onDraft({ ...agent, projectId: agent.projectId ?? null, reportsTo: agent.reportsTo ?? null, teamId: agent.teamId ?? null })} data-icon-action>
                <ActionIcon name="edit" />
              </button>
              <button type="button" className="vault-button agents-icon-action" disabled={saving || !!draft} aria-label={`Remove ${agent.name}`} title={`Remove ${agent.name}`} onClick={() => onRemove(agent)} data-icon-action>
                <ActionIcon name="delete" />
              </button>
            </div></td>
          </tr>)}
      </tbody>
    </table>
  </div>;
}

/** Keep each whitespace-delimited word together; an oversized word gets its
 * own ellipsis while the enclosing value's title keeps the full text. */
function AgentWords({ text }: { text: string }) {
  return text.split(/(\s+)/).map((part, index) => /\S/.test(part)
    ? <span className="agents-word" key={index}>{part}</span> : part);
}

function AgentValue({ label, text }: { label: string; text: string }) {
  return <td data-label={label}><span className="agents-cell-text" title={text}><AgentWords text={text} /></span></td>;
}

function AgentIdentity({ agent, teams, depth, roleButton }: { agent: TeamDraft; teams: AgentTeam[]; depth: number; roleButton?: React.ReactNode }) {
  const badge = teamBadge({ teamId: agent.teamId ?? undefined }, teams);
  return <div className="agents-identity" style={{ "--team-depth": depth } as React.CSSProperties}>
    {depth > 0 && <span aria-hidden="true" className="agents-branch">└</span>}
    <AgentAvatar name={agent.name} avatar={agent.avatar} id={agent.id} size={28} decorative />
    <div className="agents-identity-copy"><span className="team-row-name"><bdi title={agent.name || "New agent"}><AgentWords text={agent.name || "New agent"} /></bdi>
      {leadOnly(agent) && <span className="team-tag" title="Astra can lead a task but cannot take one">lead only</span>}
      {badge && <span className="team-tag team-badge" title={`On the team ${badge.name}: may ask its teammates for help`}><bdi>{badge.name}</bdi></span>}
    </span>{roleButton}</div>
  </div>;
}

/** Codex agents only. Off by default: it lets this agent's orchestration
 *  workers drive the person's own browser and apps, so the host shows it on
 *  the card too (team.rs `desktop_tools`). */
function DesktopToolsField({ draft, saving, set }: { draft: TeamDraft; saving: boolean; set: (patch: Partial<TeamDraft>) => void }) {
  if (draft.agent !== "codex") return null;
  return <label className="team-form-wide team-check"><span>Browser and computer use</span>
    <input type="checkbox" aria-label="Keep my browser and computer use" disabled={saving} checked={!!draft.desktopTools}
      onChange={(event) => set({ desktopTools: event.target.checked })} />
    <small className="team-field-note">Its workers keep your own browser (your logged-in Brave or Chrome) and computer use instead of starting without them. Off by default; it widens what a worker can do.</small>
  </label>;
}

const WORKER_SERVERS_LABEL = "Extra MCP servers for this agent's workers";

/** Claude and Codex agents only. The person's own MCP servers, by name, that
 *  this agent's orchestration workers get beside OctiqFlow's tools and
 *  Playwright; the host shows the list on the card too (team.rs
 *  `worker_servers`). Typed as one comma-separated line; the draft holds the
 *  list it says. */
export function WorkerServersField({ draft, saving, set }: { draft: TeamDraft; saving: boolean; set: (patch: Partial<TeamDraft>) => void }) {
  const listed = draft.workerServers ?? [];
  const [text, setText] = useState(() => listed.join(", "));
  if (draft.agent !== "claude" && draft.agent !== "codex") return null;
  // What was typed stands while it still says the draft's list (a trailing
  // comma, a space before the next name); a list changed elsewhere is drawn
  // from the draft.
  const typed = serverNames(text);
  const shown = typed.length === listed.length && typed.every((name, i) => name === listed[i]) ? text : listed.join(", ");
  return <label className="team-form-wide"><span>{WORKER_SERVERS_LABEL}</span>
    <input type="text" aria-label={WORKER_SERVERS_LABEL} disabled={saving} value={shown} placeholder="e.g. higgsfield, sume" spellCheck={false}
      onChange={(event) => { setText(event.target.value); set({ workerServers: serverNames(event.target.value) }); }} />
    <small className="team-field-note">Names from your Claude/Codex MCP config. Workers otherwise get OctiqFlow's tools and Playwright only.</small>
  </label>;
}

export function InlineAgentRow({ draft, depth, team, teams, projects, saving, onChange, onSave, onCancel, onDetails }: {
  draft: TeamDraft; depth: number; team: TeamAgent[]; teams: AgentTeam[]; projects: ProjectRef[]; saving: boolean;
  onChange: (draft: TeamDraft) => void; onSave: () => void; onCancel: () => void; onDetails: (draft: TeamDraft) => void;
}) {
  const { access, set, pickProvider, managers, joinable, pickProject } = teamDraftFields(draft, team, teams, onChange);
  const valid = !!draft.name.trim() && !!draft.model;
  return <tr className="agents-edit-row" aria-label={draft.id ? `Editing ${draft.name}` : "New agent"}
    onKeyDown={(event) => {
      if (event.nativeEvent.isComposing || saving) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); }
      // Only text inputs save; selects, buttons and textareas keep native keys.
      if (event.key === "Enter" && event.target instanceof HTMLInputElement && event.target.type === "text") {
        event.preventDefault();
        if (valid && !event.repeat) onSave();
      }
    }}>
    <td colSpan={7}>
      <AgentIdentity agent={draft} teams={teams} depth={depth} />
      <div className="agents-edit-grid">
        <label><span>Name</span><input autoFocus maxLength={60} value={draft.name} disabled={saving}
          placeholder="e.g. Reviewer" onChange={(event) => set({ name: event.target.value })} /></label>
        <ModelFields agent={draft.agent} model={draft.model} effort={draft.effort} disabled={saving}
          onProvider={pickProvider} onModel={(model) => set({ model })} onEffort={(effort) => set({ effort })} />
        <label><span>Access</span><select aria-label="Access" disabled={saving} value={draft.access} onChange={(event) => set({ access: event.target.value as AccessLevel })}>
          {access.map((level) => <option key={level.id} value={level.id}>{level.label}</option>)}</select>
          {providerFor(draft.agent).accessNote && <small className="team-field-note">{access.find((level) => level.id === draft.access)?.hint}</small>}</label>
        <label><span>Reports to</span><select aria-label="Reports to" disabled={saving} value={draft.reportsTo ?? ""} onChange={(event) => set({ reportsTo: event.target.value || null })}>
          <option value="">You</option>{managers.map((manager) => <option key={manager.id} value={manager.id}>{manager.name}</option>)}</select></label>
        <label><span>Available in</span><select aria-label="Available in" disabled={saving} value={draft.projectId ?? ""} onChange={(event) => pickProject(event.target.value || null)}>
          <option value="">Every project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        <label><span>Team</span><select aria-label="Team" disabled={saving} value={draft.teamId ?? ""} onChange={(event) => set({ teamId: event.target.value || null })}>
          <option value="">None</option>{joinable.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
        <DesktopToolsField draft={draft} saving={saving} set={set} />
        <WorkerServersField draft={draft} saving={saving} set={set} />
      </div>
      {leadOnly(draft) && <small className="team-field-note">Astra can lead a task, but it cannot be given one.</small>}
      <div className="agents-edit-footer">
        <button type="button" className="vault-button" disabled={saving} onClick={() => onDetails(draft)} data-icon-action title="Edit role, prompt & avatar" aria-label="Edit role, prompt & avatar">
          <ActionIcon name="edit" label="Edit details" />
        </button>
        <div className="agents-row-actions">
          <button type="button" className="settings-primary" disabled={saving || !valid} onClick={onSave} data-icon-action title={saving ? "Saving…" : "Save"} aria-label={saving ? "Saving…" : "Save"}>
            <ActionIcon name="save" label="Save" />
          </button>
          <button type="button" className="vault-button" disabled={saving} onClick={onCancel} data-icon-action title="Cancel" aria-label="Cancel">
            <ActionIcon name="cancel" label="Cancel" />
          </button>
        </div>
      </div>
    </td>
  </tr>;
}

/** Native modal pattern shared with FeedbackInbox. Loop Tab explicitly so
 * keyboard focus stays in the form rather than moving to browser chrome. */
export function AgentDetailsDialog({ draft, staged, saving, error, onChange, onSave, onClose }: {
  draft: TeamDraft; staged: boolean; saving: boolean; error: string;
  onChange: (draft: TeamDraft) => void; onSave: () => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const element = dialog.current!;
    element.showModal();
    return () => { element.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={dialog} className="agent-details-dialog" aria-labelledby="agent-details-title" tabIndex={-1}
    onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}
    onKeyDown={(event) => {
      if (event.key === "Escape") event.stopPropagation();
      if (event.key !== "Tab") return;
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:enabled, input:enabled, select:enabled, textarea:enabled, [tabindex]:not([tabindex='-1'])")]
        .filter((element) => element.getClientRects().length > 0);
      const first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); event.currentTarget.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    }}>
    <form className="team-form agent-details-form" onSubmit={(event) => { event.preventDefault(); if (!saving) onSave(); }}>
      <header><h2 id="agent-details-title">{draft.name || "New agent"} · Details</h2>
        <p className="settings-note">{staged ? "Changes stay in this row until you save the row." : "Save updates this agent’s role, prompt and avatar."}</p></header>
      {error && <p role="alert" className="set-warn">{error}</p>}
      <fieldset disabled={saving} className="agent-details-fields"><AgentLongFields draft={draft} onChange={onChange} /></fieldset>
      <div className="team-form-actions">
        <button type="button" className="vault-button" disabled={saving} onClick={onClose} data-icon-action title="Cancel" aria-label="Cancel">
          <ActionIcon name="cancel" label="Cancel" />
        </button>
        <button type="submit" className="settings-primary" disabled={saving} data-icon-action title={saving ? "Saving…" : "Save details"} aria-label={saving ? "Saving…" : "Save details"}>
          <ActionIcon name="save" label="Save details" />
        </button>
      </div>
    </form>
  </dialog>;
}

function AgentLongFields({ draft, onChange }: { draft: TeamDraft; onChange: (draft: TeamDraft) => void }) {
  const set = (patch: Partial<TeamDraft>) => onChange({ ...draft, ...patch });
  return <>
    <AgentAvatarEditor key={draft.id ?? "new"} name={draft.name} role={draft.role} avatar={draft.avatar}
      agentId={draft.id} onChange={(avatar) => set({ avatar })} />
    <label className="team-form-wide"><span>Role</span>
      <textarea aria-label="Role" value={draft.role} maxLength={ROLE_MAX} rows={4} placeholder="What this agent is good at, and what it should take on"
        onChange={(event) => set({ role: event.target.value })} /></label>
    <label className="team-form-wide"><span className="team-field-head"><span>Persistent prompt</span>
      <CharCounter text={draft.persistentPrompt ?? ""} max={PERSISTENT_PROMPT_MAX} /></span>
      <textarea aria-label="Persistent prompt" value={draft.persistentPrompt ?? ""} maxLength={PERSISTENT_PROMPT_MAX} rows={6} aria-describedby="team-persistent-prompt-hint"
        placeholder="Runbooks, tool rules, how this agent builds and checks its work" onChange={(event) => set({ persistentPrompt: event.target.value })} />
      <small className="team-field-note" id="team-persistent-prompt-hint">This agent's standing instructions. Sent ahead of its role in every brief it starts with, after the agent policy; never shown in the roster or to other agents. Applies to new chats and tasks.</small>
    </label>
  </>;
}

export function TeamForm({ draft, team, teams, projects, saving, onChange, onSave, onCancel }: {
  draft: TeamDraft; team: TeamAgent[]; teams: AgentTeam[]; projects: ProjectRef[]; saving: boolean;
  onChange: (draft: TeamDraft) => void; onSave: () => void; onCancel: () => void;
}) {
  const { access, set, pickProvider, lead, managers, joinable, pickProject } = teamDraftFields(draft, team, teams, onChange);

  return (
    <form className="team-form" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
      <label>
        <span>Name</span>
        <input value={draft.name} maxLength={60} placeholder="e.g. Reviewer" autoFocus
          onChange={(event) => set({ name: event.target.value })} />
      </label>
      <AgentLongFields draft={draft} onChange={onChange} />
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
        {/* A provider that cannot be asked (Antigravity) says what each level
            refuses or runs unasked, since no card will. */}
        {providerFor(draft.agent).accessNote && (
          <small className="team-field-note">
            {access.find((a) => a.id === draft.access)?.hint}
          </small>
        )}
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
      <DesktopToolsField draft={draft} saving={saving} set={set} />
      <WorkerServersField draft={draft} saving={saving} set={set} />
      {lead && (
        <p className="settings-note team-form-wide">
          Astra can lead a task, but it cannot be given one.
        </p>
      )}
      <div className="team-form-actions team-form-wide">
        <button className="vault-button" type="button" onClick={onCancel} data-icon-action title="Cancel" aria-label="Cancel">
          <ActionIcon name="cancel" label="Cancel" />
        </button>
        <button className="settings-primary" type="submit" disabled={saving || !draft.name.trim() || !draft.model} data-icon-action title={saving ? "Saving…" : draft.id ? "Save" : "Add"} aria-label={saving ? "Saving…" : draft.id ? "Save" : "Add"}>
          <ActionIcon name="save" label={draft.id ? "Save" : "Add"} />
        </button>
      </div>
    </form>
  );
}
