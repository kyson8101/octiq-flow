// An agent passing its task to another agent, in a new chat (the host's
// `handover.rs`). Pure: the cards and their wording read from these, and the
// store that holds the list (`useHandovers`) is the only part that talks to
// the server.
import { AGENT_NAME, accessLabel, claudeModelName, MODELS, type AccessLevel, type Provider } from "./agentProviders";

/** `starting`: confirmed, and its new chat is being started or waits for a
 *  retry. It may exist already, so it can no longer be declined.
 *  `abandoned`: its chat could not start, and the person gave up on it. */
export type HandoverStatus = "pending" | "starting" | "confirmed" | "declined" | "abandoned";
/** What the person can do on a card. */
export type HandoverAction = "confirm" | "decline" | "abandon";
export type HandoverNotice = "pending" | "tool" | "delivered" | "failed";

export type HandoverParty = { agentId?: string; name: string };

export type HandoverBrief = {
  objective: string;
  doneSoFar?: string;
  remaining?: string;
  state?: { branch?: string; worktree?: string; head?: string; uncommitted?: boolean };
  decisions?: string;
  openQuestions?: string;
  authorized?: string[];
  notAuthorized?: string[];
};

export type HandoverWorkspace = {
  /** `continue` an existing checkout, make a new `worktree`, or a plain `folder`. */
  mode: "continue" | "worktree" | "folder" | string;
  path: string;
  branch?: string;
  head?: string;
  uncommitted?: boolean;
  /** `source` (the asking chat's own checkout), `brief` or `new`. */
  chosen?: string;
  preparedCwd?: string;
  preparedBranch?: string;
};

export type Handover = {
  id: string;
  sourceChatKey: string;
  sourceTitle: string;
  sourceProject: string;
  from: HandoverParty;
  to: HandoverParty;
  settings: { agent: Provider; model?: string; effort?: string; access: AccessLevel };
  destination: { projectId: string; projectName: string; repository: string };
  workspace: HandoverWorkspace;
  brief: HandoverBrief;
  status: HandoverStatus;
  createdAt: number;
  decidedAt?: number;
  targetChatKey?: string;
  error?: string;
  /** A failed start the host made sure created no chat: it may be given up. */
  abandonable?: boolean;
  notice: HandoverNotice;
  noticeError?: string;
};

/** How far a handover has got; it only ever moves forward. */
const STAGE: Record<HandoverStatus, number> = { pending: 0, starting: 1, confirmed: 2, declined: 2, abandoned: 2 };

/** Upsert one record into a list, keeping creation order. A late event for an
 *  earlier state of the same record never wins over a later one. */
export function mergeHandover(list: readonly Handover[], next: Handover): Handover[] {
  const at = list.findIndex((item) => item.id === next.id);
  if (at < 0) return [...list, next].sort((a, b) => a.createdAt - b.createdAt);
  const current = list[at];
  if ((STAGE[next.status] ?? 0) < (STAGE[current.status] ?? 0)) return list as Handover[];
  const copy = list.slice();
  copy[at] = next;
  return copy;
}

/** What a chat shows: the handovers it asked for, and the one it came from. */
export function handoversFor(list: readonly Handover[], chatKey: string | null | undefined): {
  outgoing: Handover[];
  incoming: Handover | null;
} {
  if (!chatKey) return { outgoing: [], incoming: null };
  return {
    outgoing: list.filter((item) => item.sourceChatKey === chatKey),
    incoming: list.find((item) => item.targetChatKey === chatKey) ?? null,
  };
}

/** The chat id behind a `chat:` key. */
export function chatIdOf(key: string): string {
  return key.startsWith("chat:") ? key.slice(5) : key;
}

/** The new chat's model, as a person reads it. */
export function modelName(settings: Handover["settings"]): string {
  const flag = settings.model?.trim();
  if (!flag) return `${AGENT_NAME[settings.agent] ?? settings.agent} default`;
  return MODELS.find((m) => m.agent === settings.agent && m.flag === flag)?.model
    ?? (settings.agent === "claude" ? claudeModelName(flag) : undefined)
    ?? flag;
}

/** "Sonnet 5.5 · high · Edits", the new chat's settings on one line. */
export function settingsLine(settings: Handover["settings"]): string {
  return [
    modelName(settings),
    settings.effort,
    accessLabel(settings.agent, settings.access),
  ].filter(Boolean).join(" · ");
}

/** The last folder of a path, for a label; the full path stays in details. */
function leaf(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

/** Where the new chat works, in a few words. */
export function placeLine(handover: Handover): string {
  const ws = handover.workspace;
  const project = handover.destination.projectName;
  if (ws.mode === "continue") {
    const branch = ws.branch ? ` on ${ws.branch}` : "";
    return `${project} · continues in ${leaf(ws.path)}${branch}`;
  }
  if (ws.mode === "worktree") {
    const from = ws.preparedBranch ? `new worktree on ${ws.preparedBranch}` : `new worktree${ws.branch ? ` from ${ws.branch}` : ""}`;
    return `${project} · ${from}`;
  }
  return `${project} · ${leaf(ws.path)}`;
}

/** The headline of a card, from where it is drawn. */
export function handoverHeadline(handover: Handover, side: "source" | "target"): string {
  if (side === "target") return `Handed over from ${handover.from.name}`;
  switch (handover.status) {
    case "pending": return `Hand this task to ${handover.to.name}?`;
    case "starting": return handover.error
      ? `${handover.to.name}'s chat did not start`
      : `Starting ${handover.to.name}'s chat…`;
    case "confirmed": return `Handed over to ${handover.to.name}`;
    case "abandoned": return `Kept here: ${handover.to.name}'s chat could not start`;
    default: return `Kept here: handover to ${handover.to.name} declined`;
  }
}

/** One line about the asking agent being told, when it has not been, or the
 *  telling failed. Nothing for the ordinary case. */
export function noticeLine(handover: Handover): string | null {
  if (handover.status === "pending" || handover.status === "starting") return null;
  if (handover.notice === "failed") {
    return `${handover.from.name} could not be told${handover.noticeError ? `: ${handover.noticeError}` : "."}`;
  }
  return null;
}
