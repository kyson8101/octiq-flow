// Completing a chat, as the page sees it.
//
// Complete is the person saying "I am finished with this one". The host asks
// the agent to wrap up in its own words, and when that turn ends cleanly it
// ticks the chat done and stops the process (`agent_chat.rs`, "Completing a
// chat" in AGENTS.md). The page's half is small and all of it is here: who may
// be offered the action, what the confirm says, which chats are completing,
// and how one ended.
//
// The host owns the state. This page only mirrors it: `chat-completing` and
// `chat-completed` while it is watching, `chat_activity` and
// `chat_queue_state` after a reload. Nothing here decides that a chat is done;
// the tick arrives through the chat index like any other.
import type { Message } from "./chat";
import { locationOf, type TaskDelivery, type TaskWorkspace } from "./chatTask";

/** The wrap-up is an ordinary recorded user turn; this prefix is how the host
 *  marks it (`COMPLETION_TURN_PREFIX`). No person's turn id starts with it. */
export const WRAP_UP_PREFIX = "octiq-complete-";

export function isWrapUpTurn(turnId?: string | null): boolean {
  return typeof turnId === "string" && turnId.startsWith(WRAP_UP_PREFIX);
}

// ---- The host's preview ---------------------------------------------------

/** One run the chat coordinates: still going, or a mission not yet closed. */
export type CoordinatedRun = {
  runId: string;
  status: string;
  live: boolean;
  mission: boolean;
  workersRunning: number;
  closeEligible: boolean;
  closeBlocker?: string;
};

/** `chat_complete_preview`: what the host knows without asking the agent. */
export type CompletePreview = {
  chatKey: string;
  refusal?: string;
  completingTurnId?: string;
  running: boolean;
  registeredAgent: boolean;
  workspace?: TaskWorkspace;
  delivery?: TaskDelivery;
  runs: CoordinatedRun[];
};

// ---- Who is offered the action --------------------------------------------

/** What the chat on screen is. A worker's chat ends with its task, a front
 *  desk only routes, and a second voice in a room is not the chat's own
 *  agent; the host refuses all three, so none of them is offered the action. */
export type ChatKind = "main" | "worker" | "front-desk" | "seat";

/** A process key that is not the chat's own voice. The page only ever opens a
 *  chat under `chat:<id>`, so anything after the id is someone else's seat. */
export function chatKindOf(chat: { key: string; worker: boolean; frontDesk: boolean }): ChatKind {
  if (chat.worker) return "worker";
  if (chat.frontDesk) return "front-desk";
  return /^chat:[^#/:]+$/.test(chat.key) ? "main" : "seat";
}

export const NOT_OFFERED: Record<Exclude<ChatKind, "main">, string> = {
  worker: "A worker's chat ends with its task. Complete the main chat that coordinates it.",
  "front-desk": "A front desk only routes. There is nothing in it to complete.",
  seat: "Only a chat's own agent can be completed.",
};

export type CompleteAction = {
  /** Drawn at all. False for the chats the host would refuse outright. */
  shown: boolean;
  disabled: boolean;
  /** The tooltip and the accessible name: what it does, or why it cannot. */
  label: string;
};

export function completeAction(input: {
  kind: ChatKind;
  completing: boolean;
  connected: boolean;
}): CompleteAction {
  if (input.kind !== "main") return { shown: false, disabled: true, label: NOT_OFFERED[input.kind] };
  if (input.completing) return { shown: true, disabled: true, label: "This chat is completing" };
  if (!input.connected) return { shown: true, disabled: true, label: "Complete this chat (not connected)" };
  return { shown: true, disabled: false, label: "Complete this chat" };
}

// ---- What the confirm says ------------------------------------------------

export type ConfirmFact = { label: string; value: string };
export type ConfirmStep = { label: string; line: string };

export type ConfirmContent = {
  title: string;
  /** The one line of what will happen. */
  lead: string;
  /** Set when the wrap-up will not start at once. */
  waits?: string;
  /** What the host verified, label and value. Zero counts and facts it does
   *  not have are left out rather than shown empty. */
  facts: ConfirmFact[];
  /** What the agent is asked, in order. Behind a disclosure. */
  steps: ConfirmStep[];
  /** Why the host will not complete this chat. No confirm button then. */
  refusal?: string;
};

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Merged, in three answers. Absent delivery is "unverified", never "no". */
function mergedFact(delivery?: TaskDelivery): string {
  if (!delivery) return "Unverified";
  if (delivery.onTarget) return `On ${delivery.target}`;
  if (delivery.mergedRemote || delivery.merged) return `Yes, in ${delivery.target}`;
  return `No, not in ${delivery.target}`;
}

function runFact(run: CoordinatedRun): ConfirmFact {
  const bits: string[] = [];
  if (run.live) bits.push("Running");
  else if (run.mission) bits.push("Open");
  if (run.workersRunning > 0) bits.push(count(run.workersRunning, "worker") + " running");
  return { label: run.mission ? "Mission" : "Run", value: bits.join(" · ") || run.status };
}

export function confirmContent(
  preview: CompletePreview | undefined,
  live: { busy: boolean } = { busy: false },
): ConfirmContent {
  const workspace = preview?.workspace;
  const delivery = preview?.delivery;
  const repo = !!workspace?.isRepo;
  const facts: ConfirmFact[] = [];
  if (repo && workspace?.branch) facts.push({ label: "Branch", value: workspace.branch });
  if (workspace && (repo || !workspace.exists)) facts.push({ label: "Folder", value: locationOf(workspace) });
  const uncommitted = delivery?.uncommitted ?? workspace?.changed ?? 0;
  if (uncommitted > 0) facts.push({ label: "Uncommitted", value: count(uncommitted, "file") });
  if (repo) facts.push({ label: "Merged", value: mergedFact(delivery) });
  for (const run of preview?.runs ?? []) facts.push(runFact(run));

  const steps: ConfirmStep[] = [
    { label: "Work", line: "Commits uncommitted work, or says why it stays." },
    { label: "Clean up", line: "Removes temporary files. A worktree and its branch go only if merged." },
  ];
  // The host leaves these two out of the wrap-up when they cannot apply.
  if (preview?.registeredAgent) steps.push({ label: "Memory", line: "Saves what is worth keeping." });
  if (preview?.runs.some((run) => run.live)) steps.push({ label: "Run", line: "Stops the run it coordinates. The mission stays yours to close." });
  steps.push({ label: "Report", line: "Done, not done, remaining risks." });

  return {
    title: "Complete this chat?",
    lead: "The agent wraps up, then the chat is marked done and its process stops. A new message reopens it.",
    ...(live.busy ? { waits: "A reply is running. The wrap-up waits behind it." } : {}),
    facts,
    steps,
    ...(preview?.refusal ? { refusal: preview.refusal } : {}),
  };
}

/** The missions Close would go through for, by the host's own check. Asked
 *  again AFTER the completion: the wrap-up is what stops the run. */
export function closeOffer(preview?: CompletePreview): CoordinatedRun[] {
  return (preview?.runs ?? []).filter((run) => run.mission && run.closeEligible);
}

/** The missions worth asking git about once the chat has completed. */
export function missionsOf(preview?: CompletePreview): string[] {
  return (preview?.runs ?? []).filter((run) => run.mission).map((run) => run.runId);
}

// ---- Which chats are completing, and how one ended --------------------------

export type EndReason = "cancelled" | "stopped" | "failed" | "superseded" | "ended";

export type Completing = {
  /** Unknown for a chat only `chat_activity` has named. */
  turnId?: string;
  /** `asked` is this page's own request, not yet answered by the host. */
  state: "asked" | "started" | "queued";
};

export type Ended = { ok: boolean; reason?: string; doneAt?: number };

export type Completions = {
  completing: Record<string, Completing>;
  ended: Record<string, Ended>;
  /** Bumped by every event about a chat, so a read that was in the air when
   *  the event arrived cannot put the older answer back. */
  rev: Record<string, number>;
};

export const NO_COMPLETIONS: Completions = { completing: {}, ended: {}, rev: {} };

export type CompletionAction =
  /** The person confirmed; `chat_complete` is on its way. */
  | { type: "asked"; chatId: string }
  /** `chat_complete` was refused or never answered. */
  | { type: "refused"; chatId: string; error: string }
  /** `chat-completing`, or the answer to this page's own `chat_complete`. */
  | { type: "completing"; chatId: string; turnId: string; state: "started" | "queued" }
  /** `chat-completed`. */
  | { type: "completed"; chatId: string; ok: boolean; reason?: string; doneAt?: number }
  /** `chat_activity` on connect: every chat the host says is completing. */
  | { type: "activity"; completing: string[]; rev: Record<string, number> }
  /** `chat_queue_state` for one chat. */
  | { type: "queue"; chatId: string; completingTurnId?: string; rev: number }
  /** The line was dismissed, or the chat moved on. */
  | { type: "dismiss"; chatId: string };

const without = <T,>(map: Record<string, T>, key: string): Record<string, T> => {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
};

const bump = (rev: Record<string, number>, chatId: string) => ({ ...rev, [chatId]: (rev[chatId] ?? 0) + 1 });

export function reduceCompletions(state: Completions, action: CompletionAction): Completions {
  switch (action.type) {
    case "asked":
      if (state.completing[action.chatId]) return state;
      return {
        completing: { ...state.completing, [action.chatId]: { state: "asked" } },
        ended: without(state.ended, action.chatId),
        rev: bump(state.rev, action.chatId),
      };
    case "refused": {
      // Only this page's own unanswered request: a completion the host
      // already has is not undone by a second click it turned away.
      if (state.completing[action.chatId]?.state !== "asked") return state;
      return {
        completing: without(state.completing, action.chatId),
        ended: { ...state.ended, [action.chatId]: { ok: false, reason: action.error } },
        rev: bump(state.rev, action.chatId),
      };
    }
    case "completing":
      return {
        completing: { ...state.completing, [action.chatId]: { turnId: action.turnId, state: action.state } },
        ended: without(state.ended, action.chatId),
        rev: bump(state.rev, action.chatId),
      };
    case "completed":
      return {
        completing: without(state.completing, action.chatId),
        ended: {
          ...state.ended,
          [action.chatId]: {
            ok: action.ok,
            ...(action.reason ? { reason: action.reason } : {}),
            ...(action.doneAt != null ? { doneAt: action.doneAt } : {}),
          },
        },
        rev: bump(state.rev, action.chatId),
      };
    case "activity": {
      // The host's list replaces what this page believed, chat by chat, except
      // where an event arrived while the read was in the air.
      const fresh = (chatId: string) => (state.rev[chatId] ?? 0) === (action.rev[chatId] ?? 0);
      const listed = new Set(action.completing);
      let completing = state.completing;
      for (const chatId of Object.keys(state.completing)) {
        // A request of this page's own is not on the host's list yet.
        if (listed.has(chatId) || !fresh(chatId) || state.completing[chatId].state === "asked") continue;
        completing = without(completing, chatId);
      }
      for (const chatId of listed) {
        if (completing[chatId] || !fresh(chatId)) continue;
        completing = { ...completing, [chatId]: { state: "started" } };
      }
      return completing === state.completing ? state : { ...state, completing };
    }
    case "queue": {
      if ((state.rev[action.chatId] ?? 0) !== action.rev) return state;
      const held = state.completing[action.chatId];
      if (!action.completingTurnId) {
        if (!held || held.state === "asked") return state;
        return { ...state, completing: without(state.completing, action.chatId) };
      }
      if (held?.turnId === action.completingTurnId) return state;
      return {
        ...state,
        completing: {
          ...state.completing,
          [action.chatId]: { turnId: action.completingTurnId, state: held?.state === "queued" ? "queued" : "started" },
        },
      };
    }
    case "dismiss":
      if (!(action.chatId in state.ended)) return state;
      return { ...state, ended: without(state.ended, action.chatId) };
  }
}

/** The ids the sidebar marks. */
export function completingIds(state: Completions): Set<string> {
  return new Set(Object.keys(state.completing));
}

// ---- The one line on the chat ----------------------------------------------

const WHY: Record<EndReason, string> = {
  cancelled: "Completion cancelled.",
  stopped: "Stopped before the wrap-up finished.",
  failed: "The wrap-up did not finish cleanly.",
  superseded: "A newer message took over from the wrap-up.",
  ended: "The agent's process ended before the wrap-up finished.",
};

/** Why a completion did not tick the chat. A reason this page does not know
 *  is the host's own sentence (a refusal), shown as given. */
export function endReasonLine(reason?: string): string {
  if (!reason) return "The chat was not completed.";
  return Object.hasOwn(WHY, reason) ? WHY[reason as EndReason] : reason;
}

/** Whether the wrap-up is still waiting in the host's queue. Read off the
 *  bubble when there is one, because that is what a reload has. */
export function wrapUpWaiting(completing: Completing, messages: readonly Message[]): boolean {
  const bubble = [...messages].reverse().find((m) => m.role === "user"
    && (completing.turnId ? m.turnId === completing.turnId : isWrapUpTurn(m.turnId)));
  if (bubble) return !bubble.echo && !bubble.takenUp && (bubble.delivery === "queued" || bubble.delivery === "starting");
  return completing.state === "queued";
}

export type CompletionLine =
  | { kind: "completing"; label: string; detail: string }
  | { kind: "done"; label: string; detail?: string }
  | { kind: "not-done"; label: string; detail: string };

/** What the line above the composer says, or nothing.
 *
 *  `done` is the chat index's own tick (`isChatDone`). A completion that ended
 *  well stops being worth a line the moment the chat is spoken in again, which
 *  is exactly when that tick goes. */
export function completionLine(input: {
  completing?: Completing;
  ended?: Ended;
  done: boolean;
  messages: readonly Message[];
}): CompletionLine | null {
  const { completing, ended } = input;
  if (completing) {
    const detail = completing.state === "asked" ? "Asking the agent to wrap up"
      : wrapUpWaiting(completing, input.messages) ? "Waiting for the current reply"
      : "Wrapping up";
    return { kind: "completing", label: "Completing", detail };
  }
  if (!ended) return null;
  if (ended.ok) return input.done ? { kind: "done", label: "Completed", detail: "Marked done. A new message reopens it." } : null;
  return { kind: "not-done", label: "Not completed", detail: endReasonLine(ended.reason) };
}

// ---- The wrap-up's bubble ---------------------------------------------------

export const WRAP_UP_LABEL = "Wrap-up";

/** What the queued bubble says in place of the host's text. */
export function wrapUpBubble(message: Pick<Message, "turnId" | "delivery" | "echo" | "takenUp">): {
  label: string;
  detail: string;
} | null {
  if (!isWrapUpTurn(message.turnId)) return null;
  const waiting = !message.echo && !message.takenUp && message.delivery === "queued";
  return {
    label: WRAP_UP_LABEL,
    detail: waiting ? "Completing this chat after the current reply" : "Completing this chat",
  };
}
