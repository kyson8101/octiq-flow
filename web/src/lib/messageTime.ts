// The time on a message, WhatsApp-style: a short clock under it, the whole date
// and time on demand, and a divider where the local day changes.
//
// Where a time comes from, best first:
//   1. `octiq_at` — the host's own stamp (epoch ms) on every line it records,
//      and on the live event with the same value, so a conversation read back
//      next week shows what it showed live.
//   2. the provider's own `timestamp` on the line, when it carries one.
//   3. nothing. A record older than the host's stamp has no time and draws none.
//
// All of it is pure: the zone and the locale are arguments, so a test lands on
// the same words on every machine.
import type { ChatState, Message } from "./chat";

type Json = Record<string, unknown>;

/** The host's time on a recorded line (`transcript::AT`). */
export const HOST_AT = "octiq_at";

/** Before this a number is not a plausible epoch-ms stamp (2001-09-09). Seconds
 *  since the epoch stay below it until 2286, so a smaller number is seconds. */
const MS_FROM = 1e12;
/** And nothing before the year 2000 is a time this product recorded. */
const FLOOR = 946_684_800_000;

function asMs(raw: unknown): number | undefined {
  let ms: number | undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) ms = raw < MS_FROM ? raw * 1000 : raw;
  else if (typeof raw === "string" && raw.trim()) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) ms = parsed;
  }
  return ms !== undefined && ms >= FLOOR ? Math.round(ms) : undefined;
}

export type EventTime = { at: number; host: boolean };

/** The time a line says, and whether it is the host's. */
export function readEventTime(e: Json): EventTime | undefined {
  const host = asMs(e[HOST_AT]);
  if (host !== undefined) return { at: host, host: true };
  const own = asMs(e.timestamp);
  if (own !== undefined) return { at: own, host: false };
  const message = e.message;
  if (message && typeof message === "object") {
    const inner = asMs((message as Json).timestamp);
    if (inner !== undefined) return { at: inner, host: false };
  }
  return undefined;
}

/** Lines that are a person's turn arriving: the only ones that date a user
 *  message. A delivery receipt, a cancel, a dismissal and a provider's turn
 *  start come later (a queued turn waits for the one before it) and say
 *  nothing of when the message was sent. */
function isUserLine(e: Json): boolean {
  return e.type === "user";
}

/** What a line is called by its own provider: Claude, Codex and Pi write a
 *  `type`; Antigravity writes an `event` and no `type`. */
function lineKind(e: Json): string {
  if (typeof e.type === "string" && e.type) return e.type;
  return typeof e.event === "string" ? e.event : "";
}

/** Lines that are the agent writing. Everything the host adds about the chat
 *  (`octiq_*`), the process (`system`, `init`), a provider's turn start and
 *  the person's input (a `user` line, Antigravity's `user_input` step) is not.
 *  A tool's result is a `user` line too, so it never moves a reply's time. */
function isAgentLine(e: Json): boolean {
  const kind = lineKind(e);
  if (!kind || kind === "user" || kind === "system" || kind === "init") return false;
  if (kind === "turn.started" || kind === "turn_start" || kind.startsWith("octiq_")) return false;
  if (kind === "step_update") {
    const step = e.step_update;
    if (step && typeof step === "object" && (step as Json).step_type === "user_input") return false;
  }
  return true;
}

/** The same message: every field equal, the blocks compared one by one. The
 *  reducers of Pi, Codex and Antigravity copy every message on a tool result
 *  (`messages.map(m => ({ ...m, blocks: m.blocks.map(...) }))`), so a new
 *  object says nothing about whether the line touched it. */
function sameMessage(a: Message, b: Message): boolean {
  if (a === b) return true;
  const x = a as unknown as Json;
  const y = b as unknown as Json;
  for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
    if (key === "blocks") {
      if (a.blocks.length !== b.blocks.length || a.blocks.some((block, i) => block !== b.blocks[i])) return false;
    } else if (x[key] !== y[key]) {
      return false;
    }
  }
  return true;
}

/** A person's message that is waiting to be taken up (the shape
 *  `chatShared.waitingForCodex` reads, without importing it: that module
 *  imports the reducer which imports this one). */
function waiting(m: Message): boolean {
  return m.role === "user" && !m.echo && !m.takenUp && !m.queueLost && m.delivery !== "unknown" && !m.to;
}

function turnIdOf(e: Json): string {
  const own = e.octiq_user_turn === true ? e.uuid : e.octiq_user_turn_id;
  return typeof own === "string" ? own : "";
}

/** Carry the time of `e` onto the messages it dated. A message is dated by
 *  WHICH message it is, never by where it sits in the list or whether the
 *  reducer happened to copy it:
 *
 *  - A person's message is found by its turn id and takes the time of the
 *    FIRST host line that dates it. The browser's own clock (`atLocal`, an
 *    optimistic bubble) is replaced by that line, the host's canonical
 *    envelope (`octiq_user_turn`) even when it changes nothing else, and the
 *    echo or pickup that comes after, possibly after a wait in the queue,
 *    moves nothing.
 *  - A reply takes the time of its LAST line: the moment it was finished is
 *    what a reader compares with their own clock, and the full stop moves it
 *    forward. Only a reply the line made or changed, and only while it is the
 *    current one (still streaming, or the newest reply after the last turn
 *    the agent accepted), is dated. A finished reply of an earlier turn keeps
 *    its time whatever later line copies it.
 *
 *  Returns `next` itself when nothing changes. */
export function stampTimes(prev: ChatState, next: ChatState, e: Json): ChatState {
  const time = readEventTime(e);
  if (!time) return next;
  if (isUserLine(e)) return stampUser(prev, next, e, time);
  if (!isAgentLine(e)) return next;
  if (next === prev || next.messages === prev.messages) return next;
  return stampReply(prev, next, time);
}

function stampUser(prev: ChatState, next: ChatState, e: Json, time: EventTime): ChatState {
  const messages = next.messages;
  const tid = turnIdOf(e);
  const echo = typeof e.uuid === "string" ? e.uuid : "";
  const canonical = e.octiq_user_turn === true;
  let target = -1;
  if (tid || echo) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "user") continue;
      if ((tid && (m.turnId === tid || m.sourceTurnIds?.includes(tid))) || (!tid && echo && m.echo === echo)) {
        target = i;
        break;
      }
    }
  }
  if (target < 0 && messages !== prev.messages) {
    // A bubble the line made without a turn id (an older record): the user
    // message that was not there before.
    const had = new Set(prev.messages.map((m) => m.id));
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user" && !had.has(messages[i].id)) { target = i; break; }
    }
  }
  if (target < 0) return next;
  const m = messages[target];
  const open = m.at === undefined || m.atLocal;
  // The envelope is the host's word on when the turn was sent, so it also
  // replaces a host time an earlier echo may have left; nothing else does.
  if (!(open || (canonical && time.host && m.at !== time.at))) return next;
  if (m.at === time.at && !m.atLocal) return next;
  const copy = messages.slice();
  copy[target] = { ...m, at: time.at, atLocal: undefined };
  return { ...next, messages: copy };
}

function stampReply(prev: ChatState, next: ChatState, time: EventTime): ChatState {
  const list = next.messages;
  // The current turn is everything after the last message the agent accepted.
  // Queued prompts sit at its end and are not a boundary, so a reply placed
  // ahead of five of them is still inside.
  let from = list.length - 1;
  while (from >= 0 && !(list[from].role === "user" && !waiting(list[from]))) from--;
  from += 1;
  let newest = -1;
  for (let i = list.length - 1; i >= from; i--) {
    if (list[i].role === "assistant" && !list[i].parent && !list[i].speaker) { newest = i; break; }
  }
  const before = new Map<string, Message>();
  for (let i = prev.messages.length - 1; i >= 0; i--) before.set(prev.messages[i].id, prev.messages[i]);
  let out: Message[] | undefined;
  for (let i = from; i < list.length; i++) {
    const m = list[i];
    if (m.role !== "assistant") continue;
    const was = before.get(m.id);
    if (was) {
      if (sameMessage(was, m)) continue;
      if (!was.streaming && i !== newest) continue;
    }
    if (m.at === time.at || !(time.host || m.at === undefined)) continue;
    out ??= list.slice();
    out[i] = { ...m, at: time.at, atLocal: undefined };
  }
  return out ? { ...next, messages: out } : next;
}

/** The newest time any of these messages has: a reply is several messages. */
export function turnTime(messages: readonly Message[], role: "user" | "assistant"): number | undefined {
  if (role === "user") return messages[0]?.at;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].at !== undefined) return messages[i].at;
  return undefined;
}

type Where = { timeZone?: string; locale?: string };

/** `14:32` or `2:32 PM`, as the reader's locale writes a clock. */
export function clockLabel(at: number, where: Where = {}): string {
  return new Intl.DateTimeFormat(where.locale, { timeStyle: "short", timeZone: where.timeZone }).format(at);
}

/** The whole date and time, for the tooltip and the accessible name. */
export function fullLabel(at: number, where: Where = {}): string {
  return new Intl.DateTimeFormat(where.locale, { dateStyle: "full", timeStyle: "medium", timeZone: where.timeZone }).format(at);
}

/** One calendar day in the reader's zone, as a comparable key. */
export function dayKey(at: number, where: Where = {}): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: where.timeZone }).format(at);
}

/** The key of the calendar day before `at`'s, in the reader's zone. Noon of
 *  the key's day, minus a day of calendar, so a 23- or 25-hour day (daylight
 *  saving) cannot land on the wrong date. */
function previousDayKey(at: number, where: Where): string {
  const [y, m, d] = dayKey(at, where).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/** `Today`, `Yesterday`, a weekday inside the last week, else a date. */
export function dayLabel(at: number, now: number, where: Where = {}): string {
  const key = dayKey(at, where);
  if (key === dayKey(now, where)) return "Today";
  if (key === previousDayKey(now, where)) return "Yesterday";
  const sameYear = key.slice(0, 4) === dayKey(now, where).slice(0, 4);
  return new Intl.DateTimeFormat(where.locale, {
    weekday: "short", day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }), timeZone: where.timeZone,
  }).format(at);
}

/** Where a divider goes: the indexes of the turns whose day differs from the
 *  last turn that has a time. The first dated turn gets none, so a window that
 *  grows upward never makes a divider appear or vanish above the reader. */
export function dividerBefore(times: readonly (number | undefined)[], where: Where = {}): Set<number> {
  const out = new Set<number>();
  let last: string | undefined;
  times.forEach((at, i) => {
    if (at === undefined) return;
    const key = dayKey(at, where);
    if (last !== undefined && key !== last) out.add(i);
    last = key;
  });
  return out;
}

/** Milliseconds from `now` to the next local midnight. Built from the
 *  calendar (a 23- or 25-hour day included), never from a fixed 24 hours. */
export function msUntilLocalMidnight(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - now;
}

/** Call `onChange` each time the local date changes: one timer, re-armed for
 *  the next midnight. Returns the function that stops it. */
export function watchLocalDay(
  onChange: () => void,
  clock: { now(): number; setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } = {
    now: () => Date.now(),
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (id) => clearTimeout(id),
  },
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const arm = () => {
    // A little past midnight, so the timer never lands on the day it ends.
    timer = clock.setTimeout(() => {
      if (stopped) return;
      onChange();
      arm();
    }, Math.max(1_000, msUntilLocalMidnight(clock.now()) + 50));
  };
  arm();
  return () => {
    stopped = true;
    if (timer !== undefined) clock.clearTimeout(timer);
  };
}
