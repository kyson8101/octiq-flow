// An agent asking the person to raise its chat's access level.
//
// Two things put this card up, and it is the same card either way:
//
// - the agent's own `request_access` call, which the host keeps
//   (`access_request.rs`) and announces as `access-request`. The agent's call
//   may be waiting on the answer;
// - an Antigravity turn that ended on a refusal. Headless Antigravity cannot
//   ask, so the turn's `result` is the request: the page draws it from the
//   chat's own state, and no agent waits on it.
//
// Upgrade changes the level through the same `chat_set_access` the access
// picker sends. The card only says what the agent asked for; the click is
// the change.
import { accessLabel, providerFor, type AccessLevel, type Provider } from "./agentProviders";
import type { AntigravityDenial } from "./antigravityEvents";

export type AccessTakes = "now" | "next-turn" | "between-turns";

export type AccessRequest = {
  id: string;
  chatKey?: string;
  agent: Provider;
  current: AccessLevel;
  requested: AccessLevel;
  reason: string;
  takes: AccessTakes;
  /** The agent's call is held open for the answer. */
  wait: boolean;
  answerWithinSecs?: number;
  /** Drawn by this page from an Antigravity refusal: there is no host record
   *  to answer, only the level to change. */
  local?: boolean;
};

const RANK: Record<AccessLevel, number> = { read: 0, manual: 1, edits: 2, auto: 3, full: 4 };

export function accessRank(level: AccessLevel): number {
  return RANK[level] ?? 0;
}

/** Whether `current` already lets through what `requested` would. */
export function accessCovers(current: AccessLevel, requested: AccessLevel): boolean {
  return accessRank(current) >= accessRank(requested);
}

/** The least level this provider's picker offers that covers `wanted`. */
export function leastOffered(provider: Provider, wanted: AccessLevel): AccessLevel {
  const levels = providerFor(provider).access.map((option) => option.id);
  return levels.find((level) => accessRank(level) >= accessRank(wanted)) ?? levels[levels.length - 1];
}

/** The card's title line. */
export function accessRequestTitle(request: AccessRequest): string {
  return `Raise this chat's access to ${accessLabel(request.agent, request.requested)}?`;
}

/** The line under the buttons: when a raise takes hold, and what holds the
 *  agent meanwhile. */
export function accessRequestNote(request: AccessRequest): string {
  const when =
    request.takes === "now"
      ? "It applies at once, to the work the agent is doing now."
      : request.takes === "next-turn"
        ? "It applies from the agent's next turn; the one running now keeps its level."
        : "It applies from your next message: the agent takes a new level only between turns.";
  if (!request.wait) return `${when} Not now leaves the level as it is.`;
  const secs = request.answerWithinSecs;
  const within = secs && secs < 180 ? `${secs} seconds` : "three minutes";
  return `${when} The agent is waiting for your answer; none within ${within} leaves the level as it is.`;
}

/** Claude's Bypass permissions cannot be switched to in a running process,
 *  so it restarts the agent, and the turn in flight ends with it. */
export function raiseRestarts(request: AccessRequest): boolean {
  return request.agent === "claude" && request.requested === "full";
}

const ANTIGRAVITY_ACTION_WORDS: Record<string, string> = {
  command: "a shell command",
  mcp: "an MCP tool call",
  write_file: "a file change",
  read_file: "a file read",
  read_url: "a web page read",
  execute_url: "opening a web address",
  unsandboxed: "a command outside its sandbox",
};

/** `WriteToFile` → `write to file`. */
function antigravityToolWords(displayName: string): string {
  return displayName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();
}

/** What an Antigravity turn that ended on a refusal asks for: the least level
 *  that lets it through, and why, in the person's words. Accept edits writes
 *  files inside the project without asking (agy 1.2.16); a read or a write
 *  outside the project, a command or anything else needs Auto or more. Which
 *  side of the project a refused write fell on is not in the refusal, so a
 *  write refused below Accept edits says that a file outside needs more. */
export function antigravityAccessNeed(
  denied: readonly AntigravityDenial[],
  access: string | undefined,
): { requested: AccessLevel; reason: string } {
  const seen = new Map<string, AntigravityDenial>();
  for (const denial of denied) {
    const key = denial.action || denial.displayName || "";
    if (key && !seen.has(key)) seen.set(key, denial);
  }
  const what = [...seen.values()].map(({ action, displayName }) => {
    const words = ANTIGRAVITY_ACTION_WORDS[action];
    const tool = displayName ? antigravityToolWords(displayName) : "";
    if (words) return tool && action !== "command" && action !== "mcp" ? `${words} (${tool})` : words;
    return tool || action;
  });
  const label = (id: AccessLevel) => accessLabel("antigravity", id);
  const level = access ? `at ${label(access as AccessLevel)} access` : "at this access level";
  const writesOnly = [...seen.values()].every((denial) => denial.action === "write_file");
  const belowEdits = access === undefined || access === "read" || access === "manual";
  const requested: AccessLevel = writesOnly && belowEdits ? "edits" : "auto";
  const beyond = requested === "edits"
    ? ` A file outside the project needs ${label("auto")} or ${label("full")}.`
    : writesOnly && access === "edits"
      ? ` ${label("edits")} covers only files inside this project.`
      : "";
  return {
    requested,
    reason: `Antigravity refused ${what.join(" and ")} ${level} and ended the turn: it cannot ask anyone while it works.${beyond}`,
  };
}
