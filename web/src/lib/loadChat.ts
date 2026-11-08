import { valueBytes } from "./valueBytes";
import { emptyChat, reduceChat, type ChatState, type Message } from "./chat";
import { type CatchUp, type Frame } from "./catchUp";
import { readChatCheckpoint, saveChatCheckpoint } from "./chatCache";
import { replayChat } from "./replayChat";
import { type ChatHistory, type ChatPage, type HistorySlice } from "./chatHistory";
import { restoredTurn } from "./turnClock";
import { withLocalPrompts } from "./chatRetention";

/** Reconcile only identified host facts against local-only words. Historical
 * replay is identity-only even when a checkpoint seed already contains those
 * words: an unrelated unstamped echo of "continue" cannot acknowledge them. */
function pendingAfterReplay(next: ChatState, current: ChatState, frames: Frame[]): ChatState {
  next = withLocalPrompts(next, current);
  for (const { event } of frames) {
    if (!event || typeof event !== "object") continue;
    const e = event as { type?: string; octiq_user_turn_id?: string };
    if (["octiq_user_turn_cancelled", "octiq_user_turn_dismissed", "octiq_user_turn_delivery"].includes(e.type ?? "")) next = reduceChat(next, event);
    if (e.type === "turn.started" && e.octiq_user_turn_id) next = { ...next, messages: next.messages.map(message =>
      message.turnId === e.octiq_user_turn_id && !message.echo
        ? { ...message, takenUp: true, delivery: "dispatched", queueLost: undefined, queueAction: undefined, queueError: undefined } : message) };
  }
  return next;
}

/** Whether the events after `from` empty stream pieces whose text was merged
 *  into a line at or before `from` (`record_trim::compact_record`). */
function splitsMergedText(after: Frame[], from: number): boolean {
  return after.some(({ event }) => {
    const e = event as { type?: unknown; into?: unknown } | null;
    return e?.type === "octiq_compacted" && typeof e.into === "number" && e.into <= from;
  });
}

/** Keep restoring readable words independent of the network. Live events stay
 * in CatchUp until the checkpoint and its missing tail can commit together. */
export type ChatLoadOptions = {
  id: string;
  key: string;
  storedSeq?: number;
  catchUp: CatchUp;
  getState: () => ChatState;
  publish: (state: ChatState) => void;
  request: (after: number) => Promise<Frame[]>;
  cancelled: () => boolean;
  history?: ChatHistory;
  requestPage?: (before: number | null) => Promise<ChatPage>;
  /** Let native touch/momentum scrolling finish before changing its content. */
  beforePrepend?: () => Promise<void>;
};

export async function loadChat(options: ChatLoadOptions): Promise<void> {
  const { id, key, catchUp, getState, publish, request, cancelled } = options;
  let { storedSeq } = options;
  if (!catchUp.holds(key)) {
    const cached = await readChatCheckpoint(id);
    if (cancelled()) return;
    if (cached && cached.seq >= (storedSeq ?? 0)) {
      // A turn in flight comes back with the time since this was written
      // left off its clock: nobody saw it (`turnClock.restoredTurn`).
      publish(withLocalPrompts(restoredTurn(cached.state, cached.updatedAt), getState(), true));
      storedSeq = cached.seq;
    }
  }
  if (cancelled()) return;
  let from = catchUp.begin(key, storedSeq);
  const before = getState();
  let missing: Frame[] | undefined;
  let page: ChatPage | undefined;
  let recent: ChatPage | undefined;
  if (from > 0 && options.requestPage) {
    try {
      recent = await options.requestPage(null);
      if (cancelled()) return;
      if (recent.before !== null && recent.before > from + 1) {
        // A long offline gap is a new window, never an unbounded chat_since.
        catchUp.forget(key); from = catchUp.begin(key, 0); page = recent;
      }
    } catch (e) { if (!String(e).includes("not available on this backend")) throw e; }
  }
  if (from > 0) {
    missing = await request(from);
    if (cancelled()) return;
    if (options.requestPage && splitsMergedText(missing, from)) {
      // The record was compacted after this copy was made, and the copy ends
      // inside a stream whose text now sits whole on a line it already has.
      // What follows would leave that text cut short, so read it afresh.
      catchUp.forget(key);
      from = catchUp.begin(key, 0);
      missing = undefined;
    }
  }
  if (!page && from === 0 && options.requestPage) {
    try { page = recent ?? await options.requestPage(null); }
    catch (error) {
      // A new client can be served before its backend is restarted. Fall back
      // only for that explicit capability mismatch, not for network errors.
      if (!String(error).includes("not available on this backend")) throw error;
    }
  }
  const run = page?.events ?? missing ?? await request(from);
  if (cancelled()) return;
  // Imported sessions may have a local transcript before the server has any
  // events for this key. An empty answer must not erase those messages.
  // The folder travels with the session id: a session picked up from history
  // has no `system/init` in its record to say where it ran, and resuming it
  // anywhere else would not find it.
  const seed = from === 0 && run?.length
    ? { ...emptyChat(), sessionId: before.sessionId, cwd: before.cwd }
    : before;
  const context = page?.context ?? [];
  let next = await replayChat(seed, context, 0, cancelled);
  next = await replayChat(next, run ?? [], from, cancelled);
  if (cancelled()) return;
  // end includes events held during download AND the yielding replay. Only
  // events beyond the replay's tail still need folding.
  const tail = run?.length ? run[run.length - 1].seq : from;
  next = pendingAfterReplay(next, getState(), [...context, ...(run ?? [])]);
  const frames = catchUp.end(key, run ?? []);
  for (const frame of frames) {
    if (frame.seq > tail) next = reduceChat(next, frame.event);
  }
  if (page) options.history?.set(id, page.before, undefined, [historySlice(next, page.events.at(-1)?.seq ?? 0)]);
  const live = getState();
  if (live.busy && next.busy && live.turnStartedAt !== undefined) next = { ...next, turnStartedAt: live.turnStartedAt, turnWaits: live.turnWaits, activityTurnId: live.activityTurnId };
  publish(next);
  if (!options.history?.isPartial(id)) {
    void saveChatCheckpoint({ id, state: next, seq: catchUp.mark(key), updatedAt: Date.now() });
  }
}

/** Reduced history windows are bounded too. Explicit earlier reads may slide the
 * newest turns out; the UI then offers Return to latest. Whole turns stay whole,
 * so the incoming page and its adjacent visible page may exceed this target:
 * evicting the reader's anchor to meet a soft target would itself be a jump. */
export const CHAT_WINDOW_BYTES = 8 * 1024 * 1024;
export const CHAT_WINDOW_PAGES = 12;

function historySlice(state: ChatState, end: number): HistorySlice {
  return { ids: state.messages.map(m => m.id), agentIds: state.agents.map(a => a.id),
    outcomeIds: Object.keys(state.pendingOutcomes ?? {}), notices: state.notices.length, end };
}

// Immutable message bodies are measured once; walking a window subsequently
// copies only references. Weak keys do not keep evicted pages alive.
const messageSizes = new WeakMap<object, number>();
function messageBytes(message: object): number {
  let bytes = messageSizes.get(message);
  if (bytes === undefined) { bytes = valueBytes(message); messageSizes.set(message, bytes); }
  return bytes;
}

/** Join by host identity only. Replaying an old "continue" against a new local
 * prompt would confirm it by text on legacy records. Historical replay stays
 * separate, and only identified overlap can adopt local metadata. */
function prependMessages(older: Message[], current: Message[]): Message[] {
  const known = new Map<string, Message>();
  const keys = (m: Message) => [`message:${m.id}`, ...[m.turnId, ...(m.sourceTurnIds ?? [])].filter(Boolean).map(id => `turn:${id}`)];
  for (const message of current) for (const key of keys(message)) known.set(key, message);
  const replaced = new Set<Message>();
  const prefix = older.map(message => {
    const match = keys(message).map(key => known.get(key)).find(Boolean);
    if (!match) return message;
    replaced.add(match);
    if (message.role !== "user" || match.role !== "user") return match;
    return withLocalPrompts({ ...emptyChat(), messages: [message] }, { ...emptyChat(), messages: [match] }).messages[0];
  });
  return [...prefix, ...current.filter(message => !replaced.has(message))];
}

export async function loadEarlierChat(options: ChatLoadOptions): Promise<void> {
  const { id, key, catchUp, getState, publish, cancelled, history, requestPage } = options;
  const window = history?.get(id);
  if (window?.before == null || !requestPage) return;
  const current = getState();
  const after = catchUp.begin(key);
  const page = await requestPage(window.before);
  if (cancelled()) return;
  if (page.before !== null && page.before >= window.before) throw new Error("History cursor did not advance");
  let older = await replayChat({ ...emptyChat(), sessionId: current.sessionId, cwd: current.cwd }, page.context, 0, cancelled);
  older = await replayChat(older, page.events, 0, cancelled);
  if (cancelled()) return;
  // Some old provider records have no native message id. The reducer's local
  // m0/u0 fallback belongs to this page, not another independently read page.
  const existingIds = new Set(current.messages.map(m => m.id));
  const nativeIds = new Set([...page.context, ...page.events].flatMap(({ event }) => {
    const e = event as { uuid?: string; message?: { id?: string }; item?: { id?: string } };
    return [e?.uuid, e?.message?.id, e?.item?.id].filter(Boolean);
  }));
  older = { ...older, messages: older.messages.map(m => existingIds.has(m.id) && !nativeIds.has(m.id) && !m.echo && !m.turnId && /^(?:[mu]|writer-|recovered-|compact-|local-)\d+$/.test(m.id)
    ? { ...m, id: `history:${page.events[0]?.seq}:${m.id}` } : m) };

  // The server supplies whole turns. For legacy split tool calls, read only
  // the adjoining page's results, never the already displayed window.
  const unresolved = new Set(older.messages.flatMap(m => m.blocks.flatMap(b => b.kind === "tool" && b.result === undefined ? [b.id] : [])));
  const slices = history!.slices(id);
  if (unresolved.size) {
    const boundary = await requestPage((slices[0]?.end ?? after) + 1);
    if (cancelled()) return;
    const results = boundary.events.filter(({ event }) => {
      const e = event as { type?: string; message?: { content?: { type?: string; tool_use_id?: string }[] } };
      return e?.type === "user" && Array.isArray(e.message?.content) && e.message.content.some(b => b?.type === "tool_result" && unresolved.has(b.tool_use_id ?? ""));
    });
    older = await replayChat(older, results, 0, cancelled);
  }

  // One bounded recent page covers a reconnect race; live events remain held
  // until commit. An unseen gap cannot be silently skipped or downloaded whole.
  const recent = window.end === undefined ? await requestPage(null) : undefined;
  if (cancelled()) return;
  if (recent?.before != null && recent.before > after + 1) throw new Error("Recent messages moved beyond this window. Reopen the chat to read the latest messages.");
  await options.beforePrepend?.();
  if (cancelled()) return;
  let now = getState();
  const live = catchUp.end(key, recent?.events ?? []);
  if (window.end === undefined) for (const frame of live) now = reduceChat(now, frame.event);

  // Only the few unconfirmed local prompts need delivery facts from the older
  // page. All confirmed messages and runtime/clock facts remain untouched.
  const locals = now.messages.filter(m => m.role === "user" && !m.echo && !m.takenUp);
  const reconciled = pendingAfterReplay({ ...now, messages: locals }, { ...now, messages: locals }, [...page.context, ...page.events]);
  const localById = new Map(reconciled.messages.map(m => [m.id, m]));
  const localIds = new Set(locals.map(m => m.id));
  const messages = prependMessages(older.messages, now.messages.filter(m => !localIds.has(m.id) || localById.has(m.id)).map(m => localById.get(m.id) ?? m));
  // Reconciled echoes can have the browser's id instead of the native uuid.
  const prefixIds = messages.slice(0, older.messages.length).map(m => m.id);
  const prior: HistorySlice[] = slices.length ? slices.map(slice => ({ ...slice, ids: [...slice.ids], agentIds: [...(slice.agentIds ?? [])], outcomeIds: [...(slice.outcomeIds ?? [])] }))
    : [historySlice(current, window.end ?? after)];
  const accounted = new Set(prior.flatMap(slice => slice.ids));
  const prefix = new Set(prefixIds);
  prior[prior.length - 1].ids.push(...messages.filter(m => !prefix.has(m.id) && !accounted.has(m.id)).map(m => m.id));
  const accountedAgents = new Set(prior.flatMap(slice => slice.agentIds ?? []));
  prior[prior.length - 1].agentIds!.push(...now.agents.filter(a => !accountedAgents.has(a.id)).map(a => a.id));
  const accountedOutcomes = new Set(prior.flatMap(slice => slice.outcomeIds ?? []));
  prior[prior.length - 1].outcomeIds!.push(...Object.keys(now.pendingOutcomes ?? {}).filter(id => !accountedOutcomes.has(id)));
  prior[prior.length - 1].notices = (prior.at(-1)!.notices ?? 0) + Math.max(0, now.notices.length - prior.reduce((n, slice) => n + (slice.notices ?? 0), 0));
  if (window.end === undefined) prior[prior.length - 1].end = catchUp.mark(key);
  const candidates = [{ ...historySlice(older, page.events.at(-1)?.seq ?? window.before - 1), ids: prefixIds }, ...prior];
  const byId = new Map(messages.map(m => [m.id, m]));
  const allAgents = new Map([...older.agents, ...now.agents].map(a => [a.id, a]));
  const allNotices = [...older.notices, ...now.notices];
  const allOutcomes = { ...older.pendingOutcomes, ...now.pendingOutcomes };
  const kept: HistorySlice[] = [];
  let bytes = 0, notice = 0;
  for (const slice of candidates) {
    let size = slice.ids.reduce((sum, id) => sum + (byId.has(id) ? messageBytes(byId.get(id)!) : 0), 0);
    size += (slice.agentIds ?? []).reduce((sum, id) => sum + (allAgents.has(id) ? messageBytes(allAgents.get(id)!) : 0), 0);
    size += (slice.outcomeIds ?? []).reduce((sum, id) => sum + (allOutcomes[id] ? messageBytes(allOutcomes[id]) : 0), 0);
    for (let n = 0; n < (slice.notices ?? 0); n++) size += valueBytes(allNotices[notice++]);
    if (kept.length >= CHAT_WINDOW_PAGES || (kept.length >= 2 && bytes + size > CHAT_WINDOW_BYTES)) break;
    bytes += size; kept.push(slice);
  }
  const slid = kept.length < candidates.length;
  const keep = new Set(kept.flatMap(slice => slice.ids));
  const retained = messages.filter(m => keep.has(m.id) || (m.role === "user" && !m.echo && !m.takenUp));
  const agentIds = new Set(kept.flatMap(slice => slice.agentIds ?? []));
  const agents = [...older.agents.filter(a => !now.agents.some(b => b.id === a.id)), ...now.agents]
    .filter(a => agentIds.has(a.id));
  // The two-page soft exception is an explicit history window too. Freeze its
  // end so App's latest-stream trim cannot immediately discard the requested
  // page and anchor just because neither indivisible page could be evicted.
  const past = slid || window.end !== undefined || bytes > CHAT_WINDOW_BYTES;
  history!.set(id, page.before, past ? kept.at(-1)!.end : undefined, kept);
  const outcomeIds = new Set(kept.flatMap(slice => slice.outcomeIds ?? []));
  const outcomes = Object.fromEntries(Object.entries(allOutcomes).filter(([id]) => outcomeIds.has(id)));
  const next = { ...now, messages: retained, agents, pendingOutcomes: Object.keys(outcomes).length ? outcomes : undefined,
    notices: allNotices.slice(0, kept.reduce((n, slice) => n + (slice.notices ?? 0), 0)) };
  publish(next);
  if (!history!.isPartial(id)) void saveChatCheckpoint({ id, state: next, seq: catchUp.mark(key), updatedAt: Date.now() });
}
