export type Org = { id: string; name: string; description: string };
export type Project = {
  id: string;
  orgId: string;
  name: string;
  context: string;
  workspacePath: string;
  runnerImage?: string;
};
export type Profession = {
  id: string;
  orgId: string;
  name: string;
  kind: string;
  guidance: string;
};
export type Agent = {
  id: string;
  orgId: string;
  name: string;
  professionId: string;
  provider: string;
  model: string;
  kind: string;
  allProjects: boolean;
  projectIds: string[];
  avatar: string | null;
  avatarGeneration?: {
    requestId: string;
    provider: string;
    status: string;
    error: string | null;
    startedAt: number;
  } | null;
  rolePrompt?: string;
  roleDescription?: string;
  appearance: string;
  desk: number;
};
export type Workflow = {
  id: string;
  orgId: string;
  name: string;
  professionIds: string[];
};
export type Message = {
  id: string;
  actor: string;
  body: string;
  createdAt: number;
};
export type Step = {
  professionId: string;
  instruction: string;
  agentId: string | null;
  evidence: string;
};
export type Task = {
  id: string;
  orgId: string;
  projectId: string;
  title: string;
  detail: string;
  route: string;
  agentId: string | null;
  workflowId: string | null;
  status: string;
  steps: Step[];
  step: number;
  messages: Message[];
  evidence: string;
  generation: number;
  createdAt: number;
};
export type Meeting = {
  id: string;
  orgId: string;
  projectId: string;
  title: string;
  participantIds: string[];
  messages: Message[];
  status: string;
  generation: number;
  cursor: number;
  convertedTaskIds: string[];
};
export type Memory = {
  id: string;
  agentId: string;
  projectId: string;
  body: string;
  confirmed: boolean;
  source: string;
  createdAt: number;
};
export type Run = {
  id: string;
  agentId: string;
  projectId: string;
  targetId: string;
  kind: string;
  generation: number;
  status: string;
  result: string;
  startedAt: number;
  finishedAt: number | null;
};
export type Usage = {
  id: string;
  runId: string;
  agentId: string;
  input: number | null;
  output: number | null;
  cached: number | null;
};
export type Xp = {
  id: string;
  agentId: string;
  taskId: string;
  points: number;
  reason: string;
};
export type RecruitmentDraft = {
  id: string;
  orgId: string;
  recruiterId: string;
  professionId: string;
  targetAgentId: string | null;
  brief: string;
  professionName: string;
  professionGuidance: string;
  status: string;
  prompt: string;
  error: string | null;
  createdAt: number;
};
export type SecretaryBlueprint = {
  summary: string;
  projects: { name: string; context: string }[];
  professions: { name: string; kind: string; guidance: string }[];
  agents: {
    name: string;
    profession: string;
    provider?: string;
    model?: string;
    memberType?: "worker" | "consultant";
    allProjects?: boolean;
    projects?: string[];
    appearance?: string;
    rolePrompt?: string;
    roleDescription?: string;
  }[];
  workflows: { name: string; professions: string[] }[];
  questions: string[];
  warnings: string[];
};
export type SecretaryDraft = {
  id: string;
  orgId: string;
  secretaryId: string;
  message: string;
  status: "queued" | "generating" | "ready" | "applied" | "cancelled" | "failed";
  blueprint: SecretaryBlueprint | null;
  error: string | null;
  baseSignature: number;
  createdAt: number;
};
export type World = {
  revision: number;
  orgs: Org[];
  projects: Project[];
  professions: Profession[];
  agents: Agent[];
  workflows: Workflow[];
  tasks: Task[];
  meetings: Meeting[];
  recruitmentDrafts?: RecruitmentDraft[];
  secretaryDrafts?: SecretaryDraft[];
  roleRequests?: RoleRequest[];
  memories: Memory[];
  runs: Run[];
  usage: Usage[];
  xp: Xp[];
};
export type RoleRequest = {
  id: string;
  agentId: string;
  authorId: string;
  body: string;
  mode: "discuss" | "update";
  reply: string;
  prompt: string;
  description: string;
  status: string;
  error: string | null;
  createdAt: number;
};
export type Stats = {
  agentId: string;
  active: number;
  discussing?: number;
  recruiting?: number;
  roleSetup?: number;
  secretaryConfig?: number;
  stopping: number;
  queued: number;
  inputTokens: number;
  outputTokens: number;
  unavailableUsage: number;
  usageSamples: number;
  xp: number;
  level: number;
  progress: number;
  next: number;
};
export type Snapshot = {
  world: World;
  stats: Stats[];
  providers: Record<string, boolean>;
};
export type Mutate = (
  action: string,
  args: Record<string, unknown>,
) => Promise<{ id: string }>;

export const stages = [
  ["queued", "Queued"],
  ["planning", "Planning"],
  ["working", "Working"],
  ["needs_input", "Needs your input"],
  ["paused", "Paused"],
  ["verifying", "Verify"],
  ["done", "Done"],
  ["cancelled", "Cancelled"],
] as const;
export const label = (status: string) =>
  stages.find(([id]) => id === status)?.[1] ?? status;
export const allowed = (agent: Agent, project: Project) =>
  agent.orgId === project.orgId &&
  (agent.allProjects || agent.projectIds.includes(project.id));
export const formatTokens = (value: number) =>
  new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
export function acceptSnapshot(
  previous: Snapshot | null,
  incoming: Snapshot,
): Snapshot {
  return previous && previous.world.revision > incoming.world.revision
    ? previous
    : incoming;
}
