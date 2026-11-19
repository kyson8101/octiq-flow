import { useMemo, useSyncExternalStore } from "react";
import type { Project } from "../components/Sidebar";
import { readChatRoute, replaceChatRoute, type ChatRoute } from "./chatRoute";
import { callCommands, jobCalls, runningJobs, runningSignature } from "./jobs";
import { jobFeed } from "./jobFeed";
import type { Message } from "./chat";
import type { Conversation } from "./store";
import type { LeadRecord } from "./agentsDashboard";
import type { TeamAgent } from "./agentsMode";
import { personaFor, type Assignees, type Persona } from "./agentPersona";
import { EMPTY_ORCHESTRATION } from "./orchestration";
import { providerFor, type ModelChoice } from "./agentProviders";
export type Workspace = Project & {
  paths?: string[];
  shelved?: boolean;
  description?: string;
  /** The project's saved commands, straight from the store. Read through
   *  `parseCommands` where they are drawn — see the terminal drawer. */
  actions?: unknown;
};

export type BranchList = {
  is_repo: boolean;
  current: string;
  branches: string[];
  is_worktree: boolean;
};

/** The process key for a conversation. Derived from the conversation id rather
 *  than random, so an event coming back from the server says which conversation
 *  it belongs to without a lookup table, and so one conversation can never end
 *  up with two processes. */
export const keyFor = (conversationId: string) => `chat:${conversationId}`;
export const convOf = (key: string) => (key.startsWith("chat:") ? key.slice(5) : null);

/** One send's identity across the optimistic browser bubble and the durable
 *  Codex prompt event the backend emits after accepting it. */
export function userTurnId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `user-${crypto.randomUUID()}`;
  }
  return `user-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** What the address bar says you are looking at.
 *
 *  The hash rather than the path: every path is served the same page, and
 *  `?token=…` already owns the query string (it is read once and stripped).
 *  A hash needs no server route and survives a reload.
 *
 *  Shape: #/p/<projectSlug>/c/<chatId> — the project half is the label's slug
 *  (see `lib/projectSlug`), so the link says where it goes rather than a UUID
 *  that says nothing. Older saved links carry the raw workspace id instead —
 *  both forms are resolved against the workspace list once it arrives (the
 *  `list_workspaces` handler below), never here: this function only returns
 *  the raw decoded token. The chat half is dropped for a project with nothing
 *  open yet. */
export function readLocation(): ChatRoute { return readChatRoute(location.hash); }

export function writeLocation(project: string | null, chat: string | null, beside: string | null = null): void {
  replaceChatRoute(location, history, { project: project ?? undefined, chat: chat ?? undefined, beside: beside ?? undefined });
}

const NO_JOB_CALLS: ReadonlyMap<string, string> = new Map();

/** Which card of a chat started which of its running jobs, by call id → job
 *  id (`lib/jobs.jobCalls`). Matched again only when a job of the chat starts
 *  or ends, or the transcript changes while one runs: a job's progress moves
 *  nothing here, and a chat with no running job costs one string compare. */
export function useJobCalls(chatKey: string | null, messages: readonly Message[]): ReadonlyMap<string, string> {
  const signature = useSyncExternalStore(jobFeed.subscribe, () => runningSignature(jobFeed.snapshot()));
  const live = !!chatKey && signature.includes(`\u0000${chatKey}\u0000`);
  return useMemo(() => {
    if (!live || !chatKey) return NO_JOB_CALLS;
    const matched = jobCalls(callCommands(messages), runningJobs(jobFeed.snapshot(), chatKey));
    if (matched.size === 0) return NO_JOB_CALLS;
    return new Map([...matched].map(([call, held]) => [call, held.job.id]));
  }, [live, chatKey, signature, live ? messages : null]);
}

/** The running calls with the job cards among them. */
export function withJobCalls(calls: Set<string>, jobs: ReadonlyMap<string, string>): Set<string> {
  if (jobs.size === 0) return calls;
  const out = new Set(calls);
  for (const id of jobs.keys()) out.add(id);
  return out;
}

// Render-time readers need the current render (event callbacks use the
// committed cell). Build them outside App so they cannot retain App's scope.
export function personaReader(agentsMode: boolean, leads: LeadRecord[], roster: TeamAgent[], assignees: Assignees) {
  return (chatKey: string) => agentsMode ? personaFor(chatKey, leads, roster, assignees) : null;
}
export function projectNameReader(workspaces: Workspace[], shelved: Workspace[]) {
  const names = new Map([...workspaces, ...shelved].map(item => [item.id, item.name]));
  return (id: string) => names.get(id);
}
export function taskContextReader(orchestration: typeof EMPTY_ORCHESTRATION, conversations: Conversation[], workspaces: Workspace[], shelved: Workspace[]) {
  return (id: string, chatPersona: Persona | null, model: ModelChoice) => {
    const key = keyFor(id);
    const attempt = orchestration.attempts
      .filter((candidate) => candidate.workerChatKey === key)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    const task = attempt ? orchestration.tasks.find((candidate) => candidate.id === attempt.taskId) : undefined;
    const held = conversations.find((conversation) => conversation.id === id);
    const names = new Map([...workspaces, ...shelved].map((workspace) => [workspace.id, workspace.name]));
    return {
      launch: held?.launch ?? null,
      worker: task ? { task, attempt } : null,
      projectName: (projectId: string) => names.get(projectId),
      persona: chatPersona,
      runsOn: chatPersona ? `${providerFor(model.agent).name} ${model.model}` : undefined,
    };
  };
}
