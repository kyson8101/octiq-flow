// Agents mode: "New chat" becomes "New task", and a task is handed to one of
// the person's registered agents, who does it, passes it on, or splits it.
//
// Off, the app is exactly what it was. The registered agents live on the
// server (team.rs) so the lead's brief and the host's task assignment read one
// list; the on/off switch is this browser's own preference.
import { bridge } from "./bridge";
import type { LeadRecord } from "./agentsDashboard";
import { recall, remember } from "./remember";
import {
  MODELS, claudeModelName, effortFor, effortSteps, accessFor,
  type AccessLevel, type Effort, type ModelChoice, type Provider,
} from "./agentProviders";

export const AGENTS_MODE_KEY = "octiq.agentsMode";

export function recallAgentsMode(): boolean {
  return recall(AGENTS_MODE_KEY) === "on";
}

export function rememberAgentsMode(on: boolean): void {
  remember(AGENTS_MODE_KEY, on ? "on" : "off");
}

/** One registered agent, as the backend stores it. */
export type TeamAgent = {
  id: string;
  name: string;
  role: string;
  agent: Provider;
  /** Provider-native model id — a `ModelChoice.flag`. */
  model: string;
  effort?: Effort;
  access: AccessLevel;
  /** Absent for a global agent. */
  projectId?: string;
  /** The agent this one reports to; absent reports to the person. */
  reportsTo?: string;
  /** Its memory note, relative to the Memory Vault. */
  memoryNote?: string;
  /** Set on a save whose memory note could not be created. */
  memoryError?: string;
  /** Its picture: a checked PNG/JPEG/WebP data URL. Absent draws initials. */
  avatar?: string;
  /** The peer-help team it is on (`AgentTeam`); absent when on none. */
  teamId?: string;
  createdAt: number;
  updatedAt: number;
};

/** A peer-help team (team.rs `AgentTeam`): agents on one may ask each other
 *  questions while they work. Beside the org chart, never part of it. */
export type AgentTeam = {
  id: string;
  name: string;
  /** Absent for a global team. */
  projectId?: string;
  createdAt: number;
  updatedAt: number;
};

export type AgentTeamDraft = { id?: string; name: string; projectId?: string | null };

export type TeamDraft = {
  id?: string;
  name: string;
  role: string;
  agent: Provider;
  model: string;
  effort?: Effort;
  access: AccessLevel;
  projectId?: string | null;
  reportsTo?: string | null;
  /** Absent keeps the avatar, "" removes it, a data URL sets it. */
  avatar?: string;
  /** Absent keeps the team, "" or null takes it off, an id puts it on one. */
  teamId?: string | null;
};

/** Global agents plus the project's own; every agent with `all`. */
export async function loadTeam(projectId: string | null, all = false): Promise<TeamAgent[]> {
  return await bridge.invoke<TeamAgent[]>("team_list", { projectId, all });
}

/** The host saved an agent: one the person approved an agent's
 *  `agent_register` / `agent_update` for, or one saved on another device.
 *  Whatever holds the roster reads it again. Returns the unsubscribe. */
export function onTeamChanged(listener: () => void): () => void {
  return bridge.on("team-changed", () => listener());
}

export async function saveTeamAgent(agent: TeamDraft): Promise<TeamAgent> {
  // The host reads a missing team as "keep"; the form always says which.
  const teamId = agent.teamId === undefined ? undefined : agent.teamId ?? "";
  return await bridge.invoke<TeamAgent>("team_save", { agent: { ...agent, teamId } });
}

export async function loadAgentTeams(): Promise<AgentTeam[]> {
  return await bridge.invoke<AgentTeam[]>("agent_team_list");
}

export async function saveAgentTeam(team: AgentTeamDraft): Promise<AgentTeam> {
  return await bridge.invoke<AgentTeam>("agent_team_save", { team: { ...team, projectId: team.projectId || null } });
}

export async function deleteAgentTeam(id: string): Promise<void> {
  await bridge.invoke("agent_team_delete", { id });
}

/** The teams an agent may be put on: every global team, and its own
 *  project's. A global agent may join any team. The host checks it too. */
export function joinableTeams(teams: readonly AgentTeam[], projectId: string | null | undefined): AgentTeam[] {
  return teams.filter((team) => !projectId || !team.projectId || team.projectId === projectId);
}

/** The team an agent is on, when that team still exists. */
export function teamOf(agent: Pick<TeamAgent, "teamId">, teams: readonly AgentTeam[]): AgentTeam | null {
  return agent.teamId ? teams.find((team) => team.id === agent.teamId) ?? null : null;
}

export async function deleteTeamAgent(id: string): Promise<void> {
  await bridge.invoke("team_delete", { id });
}

/** The first message of a task: the task, then the lead's brief. Also records
 *  the chat as this lead's, which is what holds its plan for approval.
 *  `crossProject` is the conversation with the configured head: its brief
 *  spans every project and each task it creates names its destination. */
export async function taskBrief(
  chatKey: string, projectId: string, leadId: string, task: string, crossProject = false,
): Promise<string> {
  return await bridge.invoke<string>("team_brief", { chatKey, projectId, leadId, task, crossProject });
}

export async function loadLeads(): Promise<LeadRecord[]> {
  return await bridge.invoke<LeadRecord[]>("team_leads", {});
}

/** The lead the person talks to across projects, or null when none is
 *  configured (or the configured one was removed). */
export async function loadHead(): Promise<TeamAgent | null> {
  return await bridge.invoke<TeamAgent | null>("team_head", {});
}

export async function saveHead(id: string | null): Promise<TeamAgent | null> {
  return await bridge.invoke<TeamAgent | null>("team_head_set", { id });
}

/** The front desk every new conversation opens on, or null when none is
 *  designated (the plain "Talk to" picker then stays). */
export async function loadFrontDesk(): Promise<TeamAgent | null> {
  return await bridge.invoke<TeamAgent | null>("team_front_desk", {});
}

/** A front-desk chat the person left before it routed them anywhere
 *  (`handover::route::unfinished`). */
export type UnfinishedDeskChat = {
  chatKey: string;
  agentId: string;
  createdAt: number;
  /** The start of what the person first said, on one line. */
  opening?: string;
};

/** The front-desk chats there is still a way back to, newest first. An older
 *  server has no such command: then there are none. */
export async function loadUnfinishedDeskChats(): Promise<UnfinishedDeskChat[]> {
  try {
    return (await bridge.invoke<UnfinishedDeskChat[]>("front_desk_unfinished", {})) ?? [];
  } catch {
    return [];
  }
}

export async function saveFrontDesk(id: string | null): Promise<TeamAgent | null> {
  return await bridge.invoke<TeamAgent | null>("team_front_desk_set", { id });
}

/** Register a front desk with the router role and designate it, in one step. */
export async function createFrontDesk(draft: { name?: string; agent: Provider; model: string; effort: Effort }): Promise<TeamAgent> {
  return await bridge.invoke<TeamAgent>("team_front_desk_create", { draft });
}

/** What a front desk runs on unless the person picks otherwise: the
 *  provider's smallest model at its lowest effort. Routing reads a roster and
 *  writes a paragraph; it needs speed, not depth. */
export function frontDeskDefaults(provider: Provider): { model: string; effort: Effort } {
  const smallest: Record<Provider, string> = { claude: "haiku", codex: "gpt-5.6-luna", pi: "gpt-5.6-luna" };
  const efforts = effortSteps(provider);
  return { model: smallest[provider], effort: efforts[0]?.id ?? "low" };
}

/** Why an agent cannot be the front desk, as the host says it too
 *  (`team::front_desk_refusal`): its chats would be hidden and stripped of
 *  every tool but routing. `null` when it can. */
export function frontDeskRefusal(agent: TeamAgent, roster: readonly TeamAgent[], headId: string | null | undefined): string | null {
  if (agent.projectId) return `${agent.name} belongs to one project; the front desk routes from every project.`;
  if (agent.id === headId) return `${agent.name} is the lead you talk to across projects.`;
  if (roster.some((other) => other.reportsTo === agent.id)) return `${agent.name} manages other agents.`;
  return null;
}

/** The coordination home: the workspace the head's conversations live in.
 *  `null` means none is configured, and the project named General is used. */
export async function loadHome(): Promise<string | null> {
  return await bridge.invoke<string | null>("team_home", {});
}

export async function saveHome(id: string | null): Promise<string | null> {
  return await bridge.invoke<string | null>("team_home_set", { id });
}

/** The person approves a lead's plan; workers start on the next pass.
 *  `taskIds` and `revision` are the plan they were shown: the host refuses the
 *  approval when the lead has changed anything in it since. */
export async function approvePlan(
  chatKey: string, runId: string, taskIds: string[], revision?: number,
  view?: { surface: "chat" | "panel"; shownMs: number; updatedMs: number | null },
): Promise<void> {
  await bridge.invoke("orchestration_plan_approve", { actorChatKey: chatKey, runId, taskIds, revision, ...view });
}

/** The person rejects exactly the pending revision drawn on a plan card. */
export async function rejectPlan(
  chatKey: string, runId: string, taskIds: string[], revision: number | undefined, reason: string,
  view?: { surface: "chat" | "panel"; shownMs: number; updatedMs: number | null },
): Promise<void> {
  await bridge.invoke("orchestration_plan_reject", {
    actorChatKey: chatKey, runId, taskIds, revision, reason: reason.trim() || undefined, ...view,
  });
}

/** The conversation to reopen for "Talk to <head>": the newest one handed to
 *  THIS head that still exists. A conversation handed to an earlier head is
 *  never offered under a new one's name. */
export function headConversation(
  leads: readonly LeadRecord[],
  headId: string | null | undefined,
  exists: (chatKey: string) => boolean,
): LeadRecord | null {
  if (!headId) return null;
  return leads
    .filter((record) => record.crossProject && record.leadId === headId && exists(record.chatKey))
    .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

/** Who the person can start a conversation with: every agent reporting
 *  directly to them, in any project. That is an agent with no manager, or one
 *  whose manager is no longer registered (the org chart draws those at the
 *  top too). Global or project scope plays no part, except that an agent
 *  whose project is no longer `registered` has nowhere to work. The configured
 *  head comes first, then the rest by name. The host checks the same rule
 *  (`team::reports_to_person`). */
export function conversationRecipients(
  roster: readonly TeamAgent[],
  headId: string | null | undefined,
  registered: (projectId: string) => boolean = () => true,
): TeamAgent[] {
  const ids = new Set(roster.map((agent) => agent.id));
  return roster
    .filter((agent) => !agent.reportsTo || !ids.has(agent.reportsTo))
    .filter((agent) => !agent.projectId || registered(agent.projectId))
    .sort((a, b) => Number(b.id === headId) - Number(a.id === headId) || a.name.localeCompare(b.name));
}

/** Who a new conversation goes to. The agent picked for this draft, while the
 *  project on screen is one it works in (picking a project agent moves the
 *  draft to its project, so this only lapses when the person moves it
 *  elsewhere). Otherwise the default: the configured head, else the first
 *  global agent at the top, else one that works in the project on screen.
 *  `null` when no one fits; the person then picks. */
export function conversationRecipient(input: {
  recipients: readonly TeamAgent[];
  pickedId: string | null | undefined;
  headId: string | null | undefined;
  projectId: string | null | undefined;
}): TeamAgent | null {
  const { recipients, pickedId, headId, projectId } = input;
  const worksHere = (agent: TeamAgent) => !agent.projectId || agent.projectId === projectId;
  const picked = recipients.find((agent) => agent.id === pickedId);
  if (picked && worksHere(picked)) return picked;
  return recipients.find((agent) => agent.id === headId)
    ?? recipients.find((agent) => !agent.projectId)
    ?? recipients.find(worksHere)
    ?? null;
}

/** What the composer shows in place of the model controls for an agents-mode
 *  conversation: who you are talking to, not which model to pick. */
export type AgentIdentity = {
  /** The registration, so the face stays the same across renames. */
  id?: string;
  name: string;
  /** Its checked picture; absent draws initials. */
  avatar?: string;
  role: string;
  provider: Provider;
  /** The model's display name. */
  model: string;
  /** The registered agent is gone; the conversation keeps its last settings. */
  removed?: boolean;
};

/** `current` is the model the conversation actually runs on: the agent's
 *  registered one for a new conversation, the recorded one for an existing
 *  conversation (reopening never moves its history to another model). */
export function agentIdentity(
  agent: TeamAgent | null | undefined,
  fallbackName: string,
  current: Pick<ModelChoice, "agent" | "model">,
): AgentIdentity {
  return {
    ...(agent ? { id: agent.id } : {}),
    ...(agent?.avatar ? { avatar: agent.avatar } : {}),
    name: agent?.name ?? fallbackName,
    role: agent?.role ?? "",
    provider: current.agent,
    model: current.model,
    ...(agent ? {} : { removed: true }),
  };
}

/** Fable and Astra only lead; the host refuses them as workers. */
export function leadOnly(agent: Pick<TeamAgent, "model">): boolean {
  const model = agent.model.toLowerCase();
  return model.includes("fable") || model.includes("astra");
}

/** Models a registered agent can use: explicit ones only, never "Default". */
export function teamModels(provider: Provider): ModelChoice[] {
  return MODELS.filter((m) => m.agent === provider && m.flag);
}

/** A registered agent's model as a person reads it: the picker's own name
 *  for it, else a Claude id spelled out ("claude-sonnet-5-5" → "Sonnet 5.5"),
 *  else the id as stored. */
export function teamModelLabel(agent: Pick<TeamAgent, "agent" | "model">): string {
  return teamModels(agent.agent).find((m) => m.flag === agent.model)?.model
    ?? (agent.agent === "claude" ? claudeModelName(agent.model) : undefined)
    ?? agent.model;
}

/** The chat settings a lead starts with. */
export function leadSettings(agent: TeamAgent): { choice: ModelChoice; effort: Effort; access: AccessLevel } | null {
  const choice = MODELS.find((m) => m.agent === agent.agent && m.flag === agent.model);
  if (!choice) return null;
  return {
    choice,
    effort: effortFor(agent.agent, agent.effort ?? "medium"),
    access: accessFor(agent.agent, agent.access),
  };
}

export { readTaskBrief } from "./taskBrief";
