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
  MODELS, effortFor, accessFor,
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
  createdAt: number;
  updatedAt: number;
};

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
};

/** Global agents plus the project's own; every agent with `all`. */
export async function loadTeam(projectId: string | null, all = false): Promise<TeamAgent[]> {
  return await bridge.invoke<TeamAgent[]>("team_list", { projectId, all });
}

export async function saveTeamAgent(agent: TeamDraft): Promise<TeamAgent> {
  return await bridge.invoke<TeamAgent>("team_save", { agent });
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

/** The coordination home: the workspace the head's conversations live in.
 *  `null` means none is configured, and the project named General is used. */
export async function loadHome(): Promise<string | null> {
  return await bridge.invoke<string | null>("team_home", {});
}

export async function saveHome(id: string | null): Promise<string | null> {
  return await bridge.invoke<string | null>("team_home_set", { id });
}

/** The person approves a lead's plan; workers start on the next pass.
 *  `taskIds` is the plan they were shown: the host refuses the approval when
 *  the lead has changed it since. */
export async function approvePlan(chatKey: string, runId: string, taskIds: string[]): Promise<void> {
  await bridge.invoke("orchestration_plan_approve", { actorChatKey: chatKey, runId, taskIds });
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
