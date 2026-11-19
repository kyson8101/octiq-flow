// Changing a registered agent's runtime from inside its chat, and the way
// back after an automatic failover (`chat_switch_runtime`; the host's
// contract is docs/agents-mode.md, "Switching a chat's runtime").
//
// The host owns every fact here. This module only reads what it says and
// words it:
// - `homeRuntime`: present only while the chat runs on an automatic
//   fallback. It is the runtime the chat would be on if nothing had
//   failed over, with whether that provider is limited now and, when the
//   provider gave a real reset, when it resets (unix seconds, never a
//   guess). The row above the composer offers the one press back.
// - `pendingRuntime`: a switch picked during a turn. Nothing is interrupted;
//   the host applies it at the turn's full stop.
//
// The page never decides a runtime. What the chat runs on (`choice`,
// `effort`, `access`) moves only on the host's word: `chat-provider-switch`
// or a `switched` answer. A `pending` answer, and the pending events, only
// say what is waiting.
import {
  AGENT_NAME, accessFor, effortFor, modelFromReported, sameModelFlag,
  type AccessLevel, type Effort, type ModelChoice, type Provider,
} from "./agentProviders";

const PROVIDER_IDS: readonly string[] = ["claude", "codex", "pi", "antigravity"];

/** A runtime as the host names it. `model` and `effort` are null for the
 *  provider's own default. */
export type RuntimeRef = { agent: Provider; model: string | null; effort: string | null };

/** The chat's own runtime it would be on without a failover. */
export type HomeRuntime = RuntimeRef & { limited: boolean; resetsAt?: number };

export type SwitchAnswer = RuntimeRef & { state: "switched" | "pending"; access?: AccessLevel };

/** What the page holds about one chat's runtime, from the host's events and
 *  reads. `rev` counts the events that have arrived, so a read that was in
 *  the air when one arrived cannot put the older answer back. */
export type ChatRuntime = { pending?: RuntimeRef; home?: HomeRuntime; rev: number };
export type RuntimeState = Readonly<Record<string, ChatRuntime>>;
export const NO_RUNTIMES: RuntimeState = {};

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/** One runtime off the wire. Anything that is not a whole one reads as
 *  nothing: a half-read runtime must not offer a press. */
export function readRuntime(value: unknown): RuntimeRef | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.agent !== "string" || !PROVIDER_IDS.includes(row.agent)) return undefined;
  return { agent: row.agent as Provider, model: text(row.model), effort: text(row.effort) };
}

export function readHome(value: unknown): HomeRuntime | undefined {
  const ref = readRuntime(value);
  if (!ref) return undefined;
  const row = value as Record<string, unknown>;
  const resetsAt = typeof row.resetsAt === "number" && Number.isFinite(row.resetsAt) && row.resetsAt > 0 ? row.resetsAt : undefined;
  return { ...ref, limited: row.limited === true, ...(resetsAt ? { resetsAt } : {}) };
}

export function readAnswer(value: unknown): SwitchAnswer | undefined {
  const ref = readRuntime(value);
  const state = (value as { state?: unknown } | null)?.state;
  if (!ref || (state !== "switched" && state !== "pending")) return undefined;
  const access = (value as { access?: unknown }).access;
  return { ...ref, state, ...(typeof access === "string" ? { access: access as AccessLevel } : {}) };
}

/** The runtime a picked model and effort ask for. "Auto" effort is the
 *  provider's own default, which the host names null; an effort the other
 *  provider does not offer falls back the way the old picker did. */
export function refOf(choice: Pick<ModelChoice, "agent" | "flag">, effort: Effort): RuntimeRef {
  // Antigravity's effort is part of its model id: the host takes none.
  const kept = choice.agent === "antigravity" ? "auto" : effortFor(choice.agent, effort);
  return { agent: choice.agent, model: choice.flag || null, effort: kept === "auto" ? null : kept };
}

/** The same runtime, however each side spells its default. */
export function sameRuntime(a: RuntimeRef, b: RuntimeRef): boolean {
  if (a.agent !== b.agent) return false;
  const model = (a.model ?? "") === (b.model ?? "") || (!!a.model && !!b.model && sameModelFlag(a.agent, a.model, b.model));
  return model && (a.effort ?? "auto") === (b.effort ?? "auto");
}

/* ---- Folding what the host says ---------------------------------------- */

export type RuntimeAction =
  | { type: "pending"; chatId: string; runtime: RuntimeRef }
  | { type: "cleared"; chatId: string }
  /** `chat-provider-switch`: the chat moved. `home` is the host's word for
   *  whether it is now on a fallback; absent (an older host) leaves it. */
  | { type: "switched"; chatId: string; home?: HomeRuntime | null }
  /** A read of `chat_queue_state`, taken when the chat's rev was `rev`. */
  | { type: "queue"; chatId: string; rev: number; pending?: RuntimeRef; home?: HomeRuntime }
  /** The answer to this page's own `chat_switch_runtime`, sent when the
   *  chat's rev was `rev`. */
  | { type: "answer"; chatId: string; rev: number; answer: SwitchAnswer };

const of = (state: RuntimeState, chatId: string): ChatRuntime => state[chatId] ?? { rev: 0 };

function put(state: RuntimeState, chatId: string, next: Omit<ChatRuntime, "rev">, rev: number): RuntimeState {
  const row: ChatRuntime = { rev, ...(next.pending ? { pending: next.pending } : {}), ...(next.home ? { home: next.home } : {}) };
  return { ...state, [chatId]: row };
}

export function reduceRuntime(state: RuntimeState, action: RuntimeAction): RuntimeState {
  const row = of(state, action.chatId);
  switch (action.type) {
    case "pending":
      return put(state, action.chatId, { ...row, pending: action.runtime }, row.rev + 1);
    case "cleared":
      return put(state, action.chatId, { home: row.home }, row.rev + 1);
    case "switched": {
      const home = action.home === undefined ? row.home : action.home ?? undefined;
      return put(state, action.chatId, { pending: row.pending, home }, row.rev + 1);
    }
    case "queue":
      // A read older than an event is older than the event.
      if (action.rev !== row.rev) return state;
      return put(state, action.chatId, { pending: action.pending, home: action.home }, row.rev);
    case "answer": {
      // The events for a quick switch arrive before its answer, and they are
      // the host's own word: the answer only fills in what none of them said.
      if (action.rev !== row.rev) return state;
      if (action.answer.state === "pending") {
        return put(state, action.chatId, { ...row, pending: action.answer }, row.rev + 1);
      }
      // Switched, or the runtime already running: nothing waits any more.
      return put(state, action.chatId, { home: row.home }, row.rev + 1);
    }
  }
}

/* ---- Words ------------------------------------------------------------- */

/** A runtime's model as the person reads it ("Opus latest", "Sol"). */
export function modelName(runtime: RuntimeRef): string {
  return modelFromReported(runtime.agent, runtime.model ?? "")?.model ?? runtime.model ?? AGENT_NAME[runtime.agent];
}

/** The model a person would name when going back: "Opus", not "Opus latest"
 *  (the alias is the registration's wording, not a thing to read twice). */
export function shortModelName(runtime: RuntimeRef): string {
  return modelName(runtime).replace(/\s+latest$/i, "");
}

/** `Switches to <model> after this turn`: what is waiting, in one line. */
export function pendingLine(pending: RuntimeRef): string {
  return `Switches to ${shortModelName(pending)} after this turn`;
}

/** A reset time as a clock; another day says which. */
export function clockWords(atMs: number, nowMs: number, locale?: string): string {
  const at = new Date(atMs);
  const clock = at.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  const sameDay = at.toDateString() === new Date(nowMs).toDateString();
  return sameDay ? clock : `${at.toLocaleDateString(locale, { weekday: "short" })} ${clock}`;
}

export type HomeWords = {
  /** `Running on Codex`: the row's label. */
  label: string;
  /** What follows it: when the limit resets, or that it may be back. */
  detail: string;
  /** `Back to Opus`. */
  back: string;
  /** The whole line, for the accessible name. */
  line: string;
};

/** The way-back row's words. `now` is the page's clock; the reset has
 *  passed when it is behind it, and then the provider "may be available
 *  again": the host's cooldown is an estimate and the host decides. */
export function homeWords(current: Provider, home: HomeRuntime, nowMs: number, locale?: string): HomeWords {
  const name = shortModelName(home);
  const label = `Running on ${AGENT_NAME[current]}`;
  const future = home.resetsAt !== undefined && home.resetsAt * 1000 > nowMs;
  const detail = home.limited && future
    ? `${name} limit resets ${clockWords(home.resetsAt! * 1000, nowMs, locale)}`
    : home.limited && home.resetsAt === undefined
      ? `${name} limit reached`
      : `${name} may be available again`;
  return { label, detail, back: `Back to ${name}`, line: `${label} · ${detail}` };
}

/** How long until a reset the row's words change at, for its one timer.
 *  Undefined when nothing is waiting for a clock. `setTimeout` cannot hold
 *  more than 2^31 ms, so a far reset is waited for in steps. */
export function msToReset(home: Pick<HomeRuntime, "limited" | "resetsAt"> | undefined, nowMs: number): number | undefined {
  if (!home?.limited || home.resetsAt === undefined) return undefined;
  const left = home.resetsAt * 1000 - nowMs;
  if (left <= 0) return undefined;
  return Math.min(left + 250, 2 ** 31 - 1);
}

/* ---- Who is offered it -------------------------------------------------- */

/** Whether a chat can change its runtime from inside: a registered agent's
 *  conversation that has been sent. Not a worker's chat (its runtime comes
 *  with its task), not a front desk, not a removed agent's, not a
 *  conversation nobody has sent a message in yet (it starts on the
 *  registration's settings, and the host has no chat to switch). */
export function runtimeSwitchable(chat: { identity: boolean; removed: boolean; workerChat: boolean; frontDesk: boolean; saved: boolean; started: boolean }): boolean {
  return chat.identity && !chat.removed && !chat.workerChat && !chat.frontDesk && chat.saved && chat.started;
}

/** Antigravity cannot ask, so the host refuses it for a chat at guarded Auto
 *  or Manual (the rule failover uses). The reason in words, or nothing. */
export function antigravityHold(agent: Provider, access: AccessLevel): string | undefined {
  if (agent !== "antigravity") return undefined;
  if (access !== "auto" && access !== "manual") return undefined;
  return "Antigravity cannot ask for permission, so it is not offered while this chat is at Auto or Manual.";
}

/** What the host's `access` answer says the chat now runs at, kept to what
 *  the provider offers. */
export function accessOf(agent: Provider, access: AccessLevel | undefined, held: AccessLevel): AccessLevel {
  return accessFor(agent, access ?? held);
}

/** The key a request about a chat's runtime is held under (`lib/inFlight`). */
export const runtimeFlight = (chatId: string) => `runtime:${chatId}`;
