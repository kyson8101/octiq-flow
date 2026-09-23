export type WorkspaceMode = "auto" | "worktree" | "direct";
export type WorkerDefaults = { agent: "codex" | "claude"; access: string; model?: string; effort?: string };
export type TaskWorkspace = {
  plan: {
    mode: WorkspaceMode; cwd: string; checkoutRoot: string; repositoryRoot: string;
    branch: string; baseBranch: string; baseSha: string; managed: boolean; isRepo: boolean;
    warnings: string[]; initialStatus: string;
  };
  state: "preparing" | "ready" | "retained" | "cleaning" | "cleaned";
  leaseAttemptId?: string | null;
  abandoned: boolean;
  validationPaths: string[];
  delivery?: {
    headSha: string; dirty: boolean; hasCommits: boolean; pushed: boolean;
    remoteBranch?: string; pullRequest?: string; reviewState?: string;
    merged: boolean; checkedAt: number; notes: string[];
  } | null;
};

export const WORKSPACE_MODES: { value: WorkspaceMode; label: string; description: string }[] = [
  { value: "auto", label: "Auto", description: "Isolate writing tasks; let read-only workers use this checkout." },
  { value: "worktree", label: "New worktree", description: "Give each task an isolated branch and keep it through review." },
  { value: "direct", label: "Current checkout", description: "Modify this folder directly, one worker at a time." },
];

export function workspaceDeliveryLabel(workspace: TaskWorkspace): string {
  if (workspace.state === "cleaned") return workspace.abandoned ? "Abandoned · workspace removed" : "Merged · workspace removed";
  if (workspace.state === "cleaning") return "Cleaning workspace";
  const delivery = workspace.delivery;
  if (!delivery) return "Workspace retained · delivery not checked";
  if (delivery.dirty) return "Uncommitted changes";
  if (delivery.merged) return "Merge verified · ready for cleanup";
  if (delivery.reviewState) return `Review · ${delivery.reviewState.toLowerCase().replaceAll("_", " ")}`;
  if (delivery.pullRequest) return "Pull request open";
  if (delivery.pushed) return "Pushed · awaiting review";
  if (delivery.hasCommits) return "Committed · push pending";
  return "No new commits";
}

export type RunStatus = "planning" | "running" | "waiting" | "completed" | "failed" | "stopped";
type TaskStatus = "pending" | "ready" | "running" | "blocked" | "completed" | "failed" | "cancelled";
type AttemptStatus = "preparing" | "running" | "blocked" | "completed" | "failed" | "cancelled";

export type OrchestrationRun = {
  id: string;
  objective: string;
  coordinatorChatKey: string;
  workspaceId: string;
  rootPath: string;
  status: RunStatus;
  maxConcurrent: number;
  workspaceMode?: WorkspaceMode;
  workerDefaults?: WorkerDefaults | null;
  createdAt: number;
  updatedAt: number;
  stoppedReason?: string;
};

export type OrchestrationTask = {
  id: string;
  runId: string;
  title: string;
  spec: string;
  workspace?: TaskWorkspace;
  dependsOn: string[];
  parentTaskId?: string;
  status: TaskStatus;
  activeAttemptId?: string;
  result?: string;
  createdAt: number;
  updatedAt: number;
};

export type OrchestrationAttempt = {
  id: string;
  runId: string;
  taskId: string;
  number: number;
  workerChatKey: string;
  agent: "claude" | "codex" | "pi";
  model?: string;
  effort?: string;
  access: string;
  status: AttemptStatus;
  cwd: string;
  branch: string;
  isWorktree: boolean;
  summary?: string;
  filesModified: string[];
  createdAt: number;
  updatedAt: number;
};

export type OrchestrationGate = {
  id: string;
  runId: string;
  taskId?: string;
  createdByChatKey: string;
  targetChatKey: string;
  question: string;
  options: string[];
  status: "open" | "resolved" | "cancelled";
  resolution?: string;
  createdAt: number;
  updatedAt: number;
};

export type OrchestrationMessage = {
  id: string;
  runId: string;
  fromChatKey: string;
  toChatKey: string;
  kind: string;
  subject: string;
  body: string;
  createdAt: number;
};

export type OrchestrationNotification = {
  id: string; runId: string; fromChatKey: string; targetChatKey: string;
  source: string; kind: string; body: string;
  state: "pending" | "delivering" | "acknowledged" | "cancelled";
  attempts: number; coalesced: number; createdAt: number; updatedAt: number;
  nextAttemptAt: number; lastError?: string | null;
};

export type OrchestrationSnapshot = {
  runs: OrchestrationRun[];
  tasks: OrchestrationTask[];
  attempts: OrchestrationAttempt[];
  gates: OrchestrationGate[];
  messages: OrchestrationMessage[];
  notifications?: OrchestrationNotification[];
};

export const EMPTY_ORCHESTRATION: OrchestrationSnapshot = {
  runs: [], tasks: [], attempts: [], gates: [], messages: [],
};

/** The ledger is authoritative, including completed and retried workers. */
export function workerChatParents(snapshot: OrchestrationSnapshot): ReadonlyMap<string, string> {
  const coordinators = new Map(snapshot.runs.map((run) => [run.id, run.coordinatorChatKey]));
  const parents = new Map<string, string>();
  for (const attempt of snapshot.attempts) {
    const parent = coordinators.get(attempt.runId);
    if (!parent?.startsWith("chat:") || !attempt.workerChatKey.startsWith("chat:")) continue;
    const childId = attempt.workerChatKey.slice(5);
    const parentId = parent.slice(5);
    if (childId && parentId && childId !== parentId) parents.set(childId, parentId);
  }
  return parents;
}

/** Reserved worker IDs stay read-only while the ledger loads or is unavailable. */
export function isWorkerChat(id: string | null, parents: ReadonlyMap<string, string>): boolean {
  return !!id && (id.startsWith("orch-") || parents.has(id));
}

export function mainChatId(id: string | null, parents: ReadonlyMap<string, string>): string | null {
  if (!id || !parents.has(id)) return null;
  const seen = new Set([id]);
  let parent = parents.get(id)!;
  while (parents.has(parent)) {
    if (seen.has(parent)) return null;
    seen.add(parent);
    parent = parents.get(parent)!;
  }
  return seen.has(parent) ? null : parent;
}
