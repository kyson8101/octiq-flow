// Agents mode: "New chat" becomes "New task", and a task is handed to one of
// the person's registered agents, who does it, passes it on, or splits it.
//
// Off, the app is exactly what it was. The registered agents live on the
// server (team.rs) so the lead's brief and the host's task assignment read one
// list; the on/off switch is this browser's own preference.
import { bridge } from "./bridge";
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

/** The first message of a task: the task, then the lead's brief. */
export async function taskBrief(projectId: string, leadId: string, task: string): Promise<string> {
  return await bridge.invoke<string>("team_brief", { projectId, leadId, task });
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
