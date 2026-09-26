// Agent levels, as the host keeps them (`orchestration/levels.rs`,
// `agent_usage.rs`). The host decides every number: XP, level, thresholds and
// token totals arrive computed, and this file only words them. The rules are
// repeated here only to explain them, never to score anything.
import { bridge } from "./bridge";
import type { OrchestrationTask } from "./orchestration";

export type TaskSize = "small" | "medium" | "large";

export const TASK_SIZES: TaskSize[] = ["small", "medium", "large"];
export const SIZE_LABEL: Record<TaskSize, string> = { small: "Small", medium: "Medium", large: "Large" };
/** For wording a size before the host has paid it; the award itself carries
 *  what was paid. */
export const SIZE_XP: Record<TaskSize, number> = { small: 25, medium: 75, large: 150 };

export type LevelProgress = {
  xp: number;
  level: number;
  /** XP at which the current level started. */
  levelXp: number;
  /** XP at which the next level starts. */
  nextLevelXp: number;
};

export type LevelSummary = LevelProgress & { agentId: string; acceptedTasks: number };

export type Acceptor = { kind: "person" | "lead"; agentId?: string; agentName?: string };

export type XpAward = {
  taskId: string;
  runId: string;
  agentId: string;
  agentName: string;
  title: string;
  size: TaskSize;
  xp: number;
  attemptId: string;
  acceptedAt: number;
  acceptedBy: Acceptor;
  /** The run's main chat, while the run is still in the ledger. */
  coordinatorChatKey?: string;
};

export type AwaitingAcceptance = {
  taskId: string;
  runId: string;
  coordinatorChatKey: string;
  title: string;
  size?: TaskSize;
  attemptId: string;
  finishedAt: number;
  /** Accepting it pays nothing: already paid, or no size was recorded. */
  unscored: boolean;
};

export type TokenUsage = { input: number; cachedInput: number; cacheWrite: number; output: number; reasoning: number };

export type AgentUsage = {
  agentId: string;
  usage: TokenUsage;
  total: number;
  chats: number;
  leadChats: number;
  workerChats: number;
  since: number;
  lastAt?: number;
  reasoningReported: boolean;
};

export type LevelProfile = LevelProgress & {
  agentId: string;
  acceptedTasks: number;
  history: XpAward[];
  historyTotal: number;
  historyOffset: number;
  awaiting: AwaitingAcceptance[];
  scoringSince: number;
  rules: { sizes: [TaskSize, number][]; levelStep: number };
  usage?: AgentUsage;
  usageError?: string;
};

export type TaskAcceptance = { attemptId: string; at: number; by: Acceptor };

export async function loadLevels(): Promise<LevelSummary[]> {
  return await bridge.invoke<LevelSummary[]>("agent_levels", {});
}

export async function loadLevelProfile(agentId: string, offset = 0): Promise<LevelProfile> {
  return await bridge.invoke<LevelProfile>("agent_level_profile", { agentId, offset });
}

export type Accepted = { awarded: boolean; award?: XpAward; note?: string };

/** The person accepts the result of `attemptId`. The host refuses when that
 *  is no longer the task's current result. */
export async function acceptTask(taskId: string, attemptId: string): Promise<Accepted> {
  return await bridge.invoke<Accepted>("orchestration_task_accept", { taskId, attemptId });
}

export async function setTaskSize(taskId: string, size: TaskSize): Promise<void> {
  await bridge.invoke("orchestration_task_size", { taskId, size });
}

/** How far through the current level, 0–1. */
export function levelFraction(progress: LevelProgress): number {
  const span = progress.nextLevelXp - progress.levelXp;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (progress.xp - progress.levelXp) / span));
}

/** "125 XP to level 3". */
export function toNextLevel(progress: LevelProgress): string {
  return `${Math.max(0, progress.nextLevelXp - progress.xp).toLocaleString("en-US")} XP to level ${progress.level + 1}`;
}

/** 950 · 12.4K · 3.2M: token counts read at a glance, exact in a tooltip. */
export function compactTokens(n: number): string {
  if (n < 1000) return String(n);
  const units: [number, string][] = [[1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [size, unit] of units) {
    if (n >= size) {
      const value = n / size;
      return `${value >= 100 ? Math.round(value) : Number(value.toFixed(1))}${unit}`;
    }
  }
  return String(n);
}

/** What a task's size is and whether it can still change.
 *
 *  Before the first attempt, a task with no size recorded takes the default
 *  (medium) when it starts, so that is what it reads. After it has started,
 *  a missing size means it began before sizes existed and earns nothing. */
export function taskSizeState(task: Pick<OrchestrationTask, "size" | "activeAttemptId" | "status">): {
  size?: TaskSize;
  editable: boolean;
  label: string;
} {
  const started = !!task.activeAttemptId;
  const editable = !started && (task.status === "pending" || task.status === "ready");
  const size = task.size ?? (started ? undefined : "medium");
  if (!size) return { editable: false, label: "Not recorded · earns no XP" };
  return { size, editable, label: `${SIZE_LABEL[size]} · ${SIZE_XP[size]} XP` };
}

/** Who accepted, in a few words. */
export function acceptorLabel(by: Acceptor): string {
  return by.kind === "person" ? "you" : by.agentName ?? "the lead";
}

/** A completed task of a registered agent whose current result nobody has
 *  accepted: the only state that offers Accept. */
export function canAccept(task: Pick<OrchestrationTask, "status" | "assignee" | "activeAttemptId" | "acceptance">): boolean {
  if (task.status !== "completed" || !task.assignee || !task.activeAttemptId) return false;
  return task.acceptance?.attemptId !== task.activeAttemptId;
}

export function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
