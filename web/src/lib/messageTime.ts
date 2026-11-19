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
 *  message. A delivery receipt, a cancel, a dismissal and Codex's
 *  `turn.started` come later (a queued turn waits for the one before it) and
 *  say nothing of when the message was sent. */
function isUserLine(type: string): boolean {
  return type === "user";
}

/** Lines that are the agent writing. Everything the host adds about the chat
 *  (`octiq_*`), the process (`system`) and the person's turn is not, and a
 *  tool's result (a `user` line) must not move the reply's time. */
function isAgentLine(type: string): boolean {
  return !!type && !isUserLine(type) && type !== "turn.started" && type !== "system" && !type.startsWith("octiq_");
}

/** How many messages from the end an agent line can have changed. A streaming
 *  line touches the newest; the full stop its last assistant message. Looking
 *  only here keeps a delta from costing a walk of the whole conversation. */
const TAIL = 4;

/** Carry the time of `e` onto the messages it just made or changed.
 *
 *  - A person's message takes the time of the FIRST line that dates it, and
 *    keeps it. The browser's own clock (`atLocal`, an optimistic bubble) is
 *    replaced by that line, so live and reloaded agree; the echo or pickup
 *    that comes after it, possibly after a wait in the queue, moves nothing.
 *  - A reply takes the time of its LAST line: the moment it was finished is
 *    what a reader compares with their own clock, and every later line (the
 *    full stop included) moves it forward. The first line would say when the
 *    agent began, which for a long turn is minutes before anything is there.
 *
 *  Returns `next` itself when nothing changes. */
export function stampTimes(prev: ChatState, next: ChatState, e: Json): ChatState {
  if (next === prev || next.messages === prev.messages) return next;
  const time = readEventTime(e);
  if (!time) return next;
  const type = typeof e.type === "string" ? e.type : "";
  const user = isUserLine(type);
  if (!user && !isAgentLine(type)) return next;
  const before = new Set<Message>();
  const from = user ? 0 : Math.max(0, prev.messages.length - TAIL);
  for (let i = from; i < prev.messages.length; i++) before.add(prev.messages[i]);
  let messages: Message[] | undefined;
  const start = user ? 0 : Math.max(0, next.messages.length - TAIL);
  for (let i = start; i < next.messages.length; i++) {
    const m = next.messages[i];
    if (before.has(m)) continue;
    const dated = user
      ? m.role === "user" && (m.at === undefined || m.atLocal)
      : m.role === "assistant" && m.at !== time.at && (time.host || m.at === undefined);
    if (!dated) continue;
    messages ??= next.messages.slice();
    messages[i] = { ...m, at: time.at, atLocal: undefined };
  }
  return messages ? { ...next, messages } : next;
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

const DAY = 86_400_000;

/** `Today`, `Yesterday`, a weekday inside the last week, else a date. */
export function dayLabel(at: number, now: number, where: Where = {}): string {
  const key = dayKey(at, where);
  if (key === dayKey(now, where)) return "Today";
  if (key === dayKey(now - DAY, where)) return "Yesterday";
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
