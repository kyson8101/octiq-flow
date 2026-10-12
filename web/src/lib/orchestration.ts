import type { TaskReport } from "./chatTask";
import type { TaskAcceptance, TaskSize } from "./agentLevels";

export type WorkspaceMode = "mission" | "auto" | "worktree" | "direct";
export type RecoveryPolicy = { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number; fallbackModel?: string | null; stallAfterMs?: number; toolStallAfterMs?: number };
export type WorkerSettings = { agent: "codex" | "claude" | "antigravity"; access: string; model?: string; effort?: string; recovery?: RecoveryPolicy | null };
/** Omitting agent lets the main agent select workers individually. */
export type WorkerDefaults = Omit<WorkerSettings, "agent"> & { agent?: WorkerSettings["agent"] };
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
    /** In what is running, by the project's release check; absent when
     *  unverified (not merged, or no release check). */
    released?: boolean; releaseNote?: string;
  } | null;
};

/** What the host WILL allocate for a task with no workspace yet: planned
 *  read-only when the task was created, and the only thing its first launch
 *  may allocate. Never evidence that the branch or directory exists. */
export type WorkspaceProposal = {
  plan?: TaskWorkspace["plan"];
  /** Launch creates this branch; nothing by that name exists yet. */
  newBranch: boolean;
  /** Something already holds the planned branch or path; launch refuses it. */
  conflict?: string;
  /** Why nothing could be planned. */
  error?: string;
  /** Planned before a worker was chosen; a read-only launch may differ. */
  provisional?: boolean;
  proposedAt: number;
};

export const WORKSPACE_MODES: { value: WorkspaceMode; label: string; description: string }[] = [
  { value: "auto", label: "Auto", description: "Isolate writing tasks; let read-only workers use this checkout." },
  { value: "mission", label: "Mission worktree", description: "One branch for the whole mission; tasks take turns writing and follow-ups stay on it." },
  { value: "worktree", label: "New worktree", description: "Give each task an isolated branch and keep it through review." },
  { value: "direct", label: "Current checkout", description: "Modify this folder directly, one worker at a time." },
];

/** Said in the words a person would use. These strings are read on a phone,
 *  in a row one line tall, by someone who wants to know whether the work
 *  landed — not by someone reading the state machine. */
export function workspaceDeliveryLabel(workspace: TaskWorkspace): string {
  if (workspace.state === "cleaned") return workspace.abandoned ? "Abandoned · workspace removed" : "Merged · workspace removed";
  if (workspace.state === "cleaning") return "Removing workspace";
  const delivery = workspace.delivery;
  if (!delivery) return "Not checked yet";
  if (delivery.dirty) return "Uncommitted changes";
  if (delivery.merged) return "Merged";
  if (delivery.reviewState) return `Review · ${delivery.reviewState.toLowerCase().replaceAll("_", " ")}`;
  if (delivery.pullRequest) return "Pull request open";
  if (delivery.pushed) return "Pushed · awaiting review";
  if (delivery.hasCommits) return "Committed, not pushed";
  return "No new commits";
}

/** Colour follows meaning, never emphasis: green for work that landed, amber
 *  for work that still owes something, and nothing at all for the rest. A row
 *  merely waiting its turn stays quiet. */
export function deliveryTone(workspace: TaskWorkspace): "ok" | "warn" | "quiet" {
  if (workspace.state === "cleaned") return workspace.abandoned ? "quiet" : "ok";
  const delivery = workspace.delivery;
  if (!delivery) return "quiet";
  if (delivery.merged) return "ok";
  if (delivery.dirty || (delivery.hasCommits && !delivery.pushed)) return "warn";
  return "quiet";
}

export type RunStatus = "planning" | "running" | "waiting" | "completed" | "failed" | "stopped" | "closed";
export type TaskStatus = "pending" | "ready" | "running" | "blocked" | "completed" | "failed" | "cancelled";
type AttemptStatus = "preparing" | "running" | "blocked" | "completed" | "failed" | "cancelled";

/** Agents mode: the lead's plan and the person's answer to it. `revision`
 *  moves on every change to what an approval would cover; an approval names
 *  the revision it saw and the host refuses any other. */
export type PlanApproval = {
  status: "pending" | "approved" | "rejected";
  requestedAt: number;
  decidedAt?: number;
  revision?: number;
  revisedAt?: number;
  /** How the last approval was given. `words` is the person's own message
   *  when they approved in chat. */
  consent?: {
    via: "button" | "conversation"; revision: number; at: number; turnId?: string; words?: string;
    /** A button approval: which card, and how long it had shown the revision. */
    surface?: "chat" | "panel" | "unknown"; shownMs?: number;
  };
  rejection?: {
    by: "person"; revision: number; at: number; reason?: string; taskIds: string[];
    restoredTaskIds?: string[];
    surface: "chat" | "panel" | "unknown"; shownMs?: number;
  };
};

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
  /** Agents mode: the lead's plan waits for the person before workers start. */
  planApproval?: PlanApproval;
  createdAt: number;
  updatedAt: number;
  stoppedReason?: string;
  /** Hidden from the run list by the person; every record is kept, and
   *  restoring clears it. Only a finished run is archived. */
  archivedAt?: number;
  /** When the person closed this mission (`mission.rs`). */
  closedAt?: number;
  /** Closed without its work merged; the branch is kept. */
  abandoned?: boolean;
  /** What git last said about each of the mission's worktrees. */
  missionDelivery?: MissionDelivery[];
};

/** Where one of a mission's worktrees stands, as git last said. */
export type MissionDelivery = {
  repositoryRoot: string;
  checkoutRoot: string;
  branch: string;
  baseBranch: string;
  evidence: NonNullable<TaskWorkspace["delivery"]>;
  merged: boolean;
  /** `null` until merged, and whenever the project has no release check. */
  released?: boolean | null;
  releaseNote?: string;
  removed?: boolean;
  branchDeleted?: boolean;
};

/** A registered project and one repository registered on it
 *  (`orchestration/destination.rs`). */
export type TaskDestination = {
  projectId: string;
  projectName: string;
  /** Absolute path of the repository. */
  repository: string;
};

export type OrchestrationTask = {
  id: string;
  runId: string;
  title: string;
  spec: string;
  worker?: WorkerSettings;
  /** Agents mode: the registered agent this task was handed to. */
  assignee?: { id: string; name: string };
  /** Where the task runs. Absent: the run's own checkout. */
  destination?: TaskDestination;
  /** Agents mode: when the person approved it. Absent: not yet approved. */
  approvedAt?: number;
  /** The standard plan card: one line of problem, one of goal, and a few
   *  checkable acceptance criteria. Fixed once the task is created. Absent on
   *  tasks from leads that did not give one. */
  card?: { problem: string; goal: string; acceptance: string[] };
  /** What the task pays when accepted. Chosen before it starts, locked after.
   *  Absent on a task that started before sizes existed. */
  size?: TaskSize;
  /** Who accepted the current result, and which attempt it was. */
  acceptance?: TaskAcceptance;
  workspace?: TaskWorkspace;
  /** The branch and directory planned for it before it starts. Kept after
   *  launch as the record of what was approved; `workspace` is what exists. */
  workspaceProposal?: WorkspaceProposal;
  dependsOn: string[];
  parentTaskId?: string;
  /** Set by the host on a subtask its parent's own manager split off: the
   *  attempt that split it. Only such a subtask goes by its parent's
   *  approval. A task the coordinator made under a parent has none, and is
   *  ordinary new work: on the plan card and approved on its own. */
  splitBy?: string;
  status: TaskStatus;
  activeAttemptId?: string;
  result?: string;
  /** A review or check's own answer, apart from finishing: "fail" holds
   *  whatever depends on it. */
  verdict?: "pass" | "fail";
  /** What the task is for. "check", "review" and "acceptance" judge
   *  something: they settle only with a pass or fail verdict, and only a pass
   *  releases their dependants. Absent: "work" (every task made before
   *  kinds existed, which never has a verdict invented for it). */
  kind?: "work" | "check" | "review" | "acceptance";
  /** "sandbox": the worker waits for its runnable test environment. */
  environment?: "none" | "sandbox";
  /** Every change of hands before the work finished, oldest first. */
  handoffs?: { from?: { id: string; name: string }; to: { id: string; name: string }; reason: string; at: number }[];
  /** The task the coordinator created to replace this blocked or failed one. */
  supersededBy?: string;
  /** A start of it would be refused because the person has not approved
   *  it. The host says `true` or `false` of every task of a run that has a
   *  plan approval, finished ones included, and leaves the key out only for
   *  a run with none. Absent on a host that does not say at all: the run's
   *  own approval is then all the page has (`taskHeldByPlan`). */
  heldByPlan?: boolean;
  /** A start of it would be refused because it was reopened and the notice
   *  of that is not confirmed on disk in the coordinator's chat. The host
   *  sends the key only while it holds, and only as `true`. */
  heldByReopen?: boolean;
  /** Every reopen of the task, oldest first (the newest twelve). Absent on a
   *  task that never was reopened. */
  reopens?: TaskReopenRecord[];
  /** The person stopped this task's worker from the page
   *  (`orchestration_task_stop`). While it is set only the person starts the
   *  task again: their Start, or their approval of a plan it is put back on. */
  stopped?: { at: number; attemptId: string; reason?: string };
  /** Set on a task a teammate asked for (orchestration/peer_request.rs): who
   *  asked, the result they expect back, and `maxMinutes` of working time
   *  (waiting for a decision does not count, and it is not extended). */
  peerRequest?: {
    requestedBy: { id: string; name: string };
    requesterChatKey: string;
    requesterAttemptId?: string;
    output: string;
    maxMinutes: number;
    requestedAt: number;
  };
  createdAt: number;
  updatedAt: number;
};

/** One reopen of a completed task, as the ledger keeps it. `attempt` is the
 *  number of the attempt the instructions are for. `noticeDelivered` is
 *  false until the notice of it is in the coordinator's chat and confirmed
 *  on disk; a record that does not say reads as false too. */
export type TaskReopenRecord = {
  byChatKey: string;
  at: number;
  attempt: number;
  previousSpec: string;
  spec: string;
  noticeDelivered?: boolean;
};

/** Blocked or failed and not replaced: something someone still has to deal
 *  with. A task the coordinator replaced keeps its history but is owed
 *  nothing, so it never counts as blocked (feedback 6b0870f9). */
/** Whether a gate belongs to a peer request. The host takes that gate's
 *  answer from the person's page and from no agent, so the page sends it to
 *  the host instead of through the main chat. */
export function isPeerRequestGate(
  gate: Pick<OrchestrationGate, "taskId">,
  tasks: readonly Pick<OrchestrationTask, "id" | "peerRequest">[],
): boolean {
  return !!gate.taskId && tasks.some((task) => task.id === gate.taskId && !!task.peerRequest);
}

/** Whether a start of this task would be refused because the person has not
 *  approved it. The task's own `heldByPlan` says, when the host sends it; a
 *  task that carries none, in a run where another task does, is not held.
 *  Only when no task of the run carries it (a host that does not say) is the
 *  run's own approval read instead, which is what the page did before and
 *  calls every unstarted task of a run with a pending plan held. */
export function taskHeldByPlan(
  task: Pick<OrchestrationTask, "runId" | "heldByPlan">,
  run: Pick<OrchestrationRun, "planApproval"> | undefined,
  tasks: readonly Pick<OrchestrationTask, "runId" | "heldByPlan">[],
): boolean {
  if (typeof task.heldByPlan === "boolean") return task.heldByPlan;
  if (tasks.some((other) => other.runId === task.runId && typeof other.heldByPlan === "boolean")) return false;
  return run?.planApproval?.status === "pending";
}

/** Whether a plan waiting for the person holds everything the run still has
 *  to do. A plan back in front of them holds only what they have not
 *  approved: a task they approved before keeps starting and running beside
 *  it. While the plan holds every task still open, the plan is the run and
 *  nothing starts; once one is not held, saying "nothing starts until you
 *  approve" would be false, and its row has to be on the page. A host that
 *  does not say reads as before: a pending plan holds the run. */
export function planHoldsRun(
  run: Pick<OrchestrationRun, "id" | "planApproval">,
  tasks: readonly Pick<OrchestrationTask, "runId" | "status" | "heldByPlan">[],
): boolean {
  if (run.planApproval?.status !== "pending") return false;
  const mine = tasks.filter((task) => task.runId === run.id);
  if (!mine.some((task) => typeof task.heldByPlan === "boolean")) return true;
  // What is in flight is not held, whatever a later change did to its plan.
  return mine.every((task) => task.status === "pending" || task.status === "ready" ? task.heldByPlan === true
    : task.status !== "running" && task.status !== "blocked");
}

export function isStuck(task: Pick<OrchestrationTask, "status" | "supersededBy" | "stopped">): boolean {
  // A task the person stopped is left failed by the host and did not fail:
  // they held it themselves, and its row says so (`lib/taskHold`).
  return (task.status === "blocked" || task.status === "failed") && !task.supersededBy && !task.stopped;
}

export type OrchestrationAttempt = {
  id: string;
  runId: string;
  taskId: string;
  number: number;
  workerChatKey: string;
  agent: "claude" | "codex" | "pi" | "antigravity";
  model?: string;
  effort?: string;
  access: string;
  status: AttemptStatus;
  execution?: WorkerExecution;
  cwd: string;
  branch: string;
  isWorktree: boolean;
  summary?: string;
  filesModified: string[];
  finishedAt?: number;
  archivedAt?: number | null;
  /** A read-only worker's closing words, held when its turn ended without a
   *  report. Not a settlement until the coordinator confirms this id. */
  proposedReport?: ProposedReport | null;
  /** An attempt of a peer-request task: what its limit of working time
   *  needs beyond the stamps here. `carriedMs` is what earlier attempts used;
   *  each of `waits` is a stretch the host saw it waiting with nothing
   *  running, which is not counted; `usedMs` is the most it was ever found
   *  to have used, and never goes down. */
  peerClock?: { carriedMs: number; usedMs: number; waits?: { from: number; to: number }[] };
  /** Tokens this attempt's worker chat has used, as the host counted them
   *  (`agent_usage.rs`). The key is absent until the provider has reported
   *  any, and for a chat that runs as no registered agent: never a row of
   *  zeros. A row and the run's Tokens tile leave the figure out then
   *  (`lib/runProgress`), and nothing is worked out in its place. */
  usage?: AttemptUsage | null;
  /** What the worker's session holds of its model's context window, both as
   *  the provider last said. There only once both are known: a count
   *  without a window is not sent, so an Antigravity attempt never has it.
   *  It describes a live session and is gone after a server restart. */
  context?: { tokens: number; window: number } | null;
  createdAt: number;
  updatedAt: number;
};

/** `agent_usage::TokenUsage`: `input` and `output` are the whole of each, and
 *  the other three are parts already inside them. */
export type AttemptUsage = { input: number; cachedInput?: number; cacheWrite?: number; output: number; reasoning?: number };

export type ProposedReport = {
  id: string;
  text: string;
  capturedAt: number;
  truncated?: boolean;
  confirmedAt?: number | null;
  confirmedBy?: string | null;
};

export type ExecutionState = "queued" | "executing" | "waiting_tool" | "retrying" | "capacity_blocked" | "stalled" | "disconnected" | "awaiting_report" | "blocked" | "failed" | "completed" | "cancelled";
export type WorkerExecution = {
  state: ExecutionState;
  lastActivityAt?: number | null;
  lastProgressAt?: number | null;
  lastProgress?: string | null;
  currentOperation?: string | null;
  /** Operations in flight, by id. `octiq:environment` is the host's own:
   *  building the task's test environment, or waiting for a slot for it. */
  pendingTools?: Record<string, string>;
  latestError?: { kind: string; message: string; at: number; retryable: boolean } | null;
  retryCount: number;
  nextRetryAt?: number | null;
  retryModel?: string | null;
  stalledAt?: number | null;
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
  /** When it was resolved or cancelled. Absent while open, and on a gate
   *  closed before this was recorded. */
  closedAt?: number;
  /** Who an open gate waits on, as the host says. Absent on a host that does
   *  not say, and then the page does not guess (`lib/runWaits`). */
  awaits?: Awaits;
};

/** Who a decision waits on: the person, the run's coordinator, or nobody at
 *  all (a refusal no one can approve). */
export type Awaits = "person" | "coordinator" | "nobody";

export type OrchestrationMessage = {
  id: string;
  runId: string;
  fromChatKey: string;
  toChatKey: string;
  kind: string;
  subject: string;
  body: string;
  createdAt: number;
  /** A notice relayed from another run: of the same coordinator, or over a
   *  bridge the person opened. */
  relay?: RelayOrigin | null;
};

export type RelayOrigin = {
  fromRunId: string;
  originAttemptId?: string | null;
  originTaskId?: string | null;
  originChatKey?: string | null;
  /** The person's bridge it went over, between different coordinators. */
  bridgeId?: string | null;
  digest: string;
  pairedMessageId?: string | null;
};

/** A one-way bridge the person opened from one run's coordinator to
 *  another's (`orchestration/bridge.rs`). */
export type RunBridge = {
  id: string;
  fromRunId: string;
  toRunId: string;
  fromCoordinatorChatKey: string;
  toCoordinatorChatKey: string;
  openedAt: number;
  closedAt?: number | null;
  closedReason?: string | null;
  sends: { digest: string; messageId: string; sentAt: number }[];
};

export type OrchestrationNotification = {
  id: string; runId: string; fromChatKey: string; targetChatKey: string;
  source: string; kind: string; body: string;
  state: "pending" | "delivering" | "acknowledged" | "cancelled";
  attempts: number; coalesced: number; createdAt: number; updatedAt: number;
  nextAttemptAt: number; lastError?: string | null;
};

export type OrchestrationSnapshot = {
  nativeDecisions?: NativeDecision[];
  services?: RuntimeService[];
  reports?: Record<string, TaskReport>;
  runs: OrchestrationRun[];
  tasks: OrchestrationTask[];
  attempts: OrchestrationAttempt[];
  gates: OrchestrationGate[];
  messages: OrchestrationMessage[];
  notifications?: OrchestrationNotification[];
  /** Absent from servers older than bridges. */
  bridges?: RunBridge[];
  /** Questions workers asked teammates, oldest first. Absent from servers
   *  older than peer help. */
  peerAsks?: PeerAsk[];
  /** Finished runs whose task specs and results, attempt summaries and
   *  message and notification bodies this read left out (`brief.rs`). The
   *  feed fills them in for a run the panel shows (`orchestrationFeed.detail`). */
  briefRuns?: string[];
};

/** One question to a teammate and the answer (orchestration/peer.rs). Advice:
 *  it hands nothing over and needs no gate. A worker's names its run, task
 *  and attempt. A lead's own chat has no attempt: its ask names the chat
 *  (`askerChatKey`) and, when the chat coordinates a live run, that run. */
export type PeerAsk = {
  id: string;
  runId?: string;
  taskId?: string;
  attemptId?: string;
  askerChatKey?: string;
  asker: { id: string; name: string };
  helper: { id: string; name: string };
  helperAgent: "claude" | "codex" | "pi" | "antigravity";
  helperModel: string;
  helperEffort?: string;
  question: string;
  contextPaths?: string[];
  status: "asking" | "answered" | "failed";
  answer?: string;
  truncated?: boolean;
  error?: string;
  usage?: { inputTokens: number; outputTokens: number };
  askedAt: number;
  answeredAt?: number;
};

/** A task's peer asks, oldest first. */
export function taskPeerAsks(snapshot: Pick<OrchestrationSnapshot, "peerAsks">, taskId: string): PeerAsk[] {
  return (snapshot.peerAsks ?? [])
    .filter((ask) => ask.taskId === taskId)
    .sort((a, b) => a.askedAt - b.askedAt || a.id.localeCompare(b.id));
}

export type NativeDecision = {
  id: string; runId: string; taskId: string; attemptId: string; chatKey: string;
  reason: string; blockedAction: string | null; status: string;
  continuation: string; recovery: string; observedAt: number;
  /** "outage": Claude's classifier gave no verdict. Absent from older
   * servers and older records, which are safety refusals. */
  kind?: "safety" | "outage";
  /** The outage card this refusal was grouped on. */
  groupId?: string | null;
  /** Who a pending one waits on, as the host says. Absent on a host that
   *  does not say (`lib/runWaits`). */
  awaits?: Awaits;
};

export type RuntimeService = {
  id: string; runId: string; taskId: string; attemptId: string; name: string;
  host: string; port: number; state: "unverified" | "listening" | "stopped";
  checkedAt: number | null; recovery: string;
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

/** The chats a person lists, searches and browses by project: every chat but
 *  a run's workers. A worker is reached through its run's Tasks view in the
 *  main chat, and its transcript is kept; listed on its own it was a
 *  "Worker: …" row nobody had started. Identity is the ledger's mapping plus
 *  the reserved `orch-` prefix, so a worker stays out while the ledger loads,
 *  after its parent is filtered away, and when it is the chat on screen. */
export function ordinaryChats<T extends { id: string }>(chats: readonly T[], parents: ReadonlyMap<string, string>): T[] {
  return chats.filter((chat) => !isWorkerChat(chat.id, parents));
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
