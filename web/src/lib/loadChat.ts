import { valueBytes } from "./valueBytes";
import { emptyChat, reduceChat, type ChatState } from "./chat";
import { type CatchUp, type Frame } from "./catchUp";
import { readChatCheckpoint, saveChatCheckpoint } from "./chatCache";
import { replayChat } from "./replayChat";
import { type ChatHistory, type ChatPage } from "./chatHistory";
import { restoredTurn } from "./turnClock";

/** Claude's queued prompts may exist only in this browser until echoed. */
function keepPending(next: ChatState, current: ChatState): ChatState {
  const pending = current.messages.filter((message) => message.role === "user"
    && !message.echo && !message.takenUp
    && !next.messages.some((known) => known.id === message.id
      || (!!message.turnId && known.turnId === message.turnId)));
  return pending.length ? { ...next, busy: next.busy || current.busy, messages: [...next.messages, ...pending] } : next;
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
      publish(restoredTurn(cached.state, cached.updatedAt));
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
  const frames = catchUp.end(key, run ?? []);
  for (const frame of frames) {
    if (frame.seq > tail) next = reduceChat(next, frame.event);
  }
  if (page) options.history?.set(id, page.before);
  next = keepPending(next, getState());
  const live = getState();
  if (live.busy && next.busy && live.turnStartedAt !== undefined) next = { ...next, turnStartedAt: live.turnStartedAt, turnWaits: live.turnWaits, activityTurnId: live.activityTurnId };
  publish(next);
  if (!options.history?.isPartial(id)) {
    void saveChatCheckpoint({ id, state: next, seq: catchUp.mark(key), updatedAt: Date.now() });
  }
}

/** Raw replay windows are bounded too. Explicit earlier reads may slide the
 * newest turns out; the UI then offers Return to latest. Whole turns stay whole,
 * so one indivisible oversized turn can exceed this target (server contract). */
export const CHAT_WINDOW_BYTES = 8 * 1024 * 1024;
export const CHAT_WINDOW_PAGES = 12;

export async function loadEarlierChat(options: ChatLoadOptions): Promise<void> {
  const { id, key, catchUp, getState, publish, cancelled, history, requestPage } = options;
  const window = history?.get(id);
  if (window?.before == null || !requestPage) return;
  const current = getState();
  const after = catchUp.begin(key);
  const page = await requestPage(window.before);
  if (cancelled()) return;
  if (page.before !== null && page.before >= window.before) throw new Error("History cursor did not advance");
  // Walk only the displayed window in bounded pages, never chat_since(oldest).
  const newer: ChatPage[] = [];
  let contiguous = false;
  let downloaded = 0;
  let cursor: number | null = window.end !== undefined ? window.end + 1 : null;
  for (let n = 0; n < CHAT_WINDOW_PAGES; n++) {
    const part = await requestPage(cursor);
    if (cancelled()) return;
    downloaded += valueBytes(part);
    if (downloaded > CHAT_WINDOW_BYTES) break;
    newer.unshift(part);
    if (part.before === null || part.before <= window.before) { contiguous = true; break; }
    if (cursor !== null && part.before >= cursor) throw new Error("History cursor did not advance");
    cursor = part.before;
  }
  let bytes = valueBytes(page);
  const tail: Frame[] = [];
  let end = page.events.at(-1)?.seq ?? window.before - 1;
  let slid = !contiguous;
  for (const part of contiguous ? newer : []) {
    const frames = part.events.filter(f => f.seq >= window.before! && f.seq <= (window.end ?? Infinity));
    if (!frames.length) continue;
    const size = valueBytes(frames);
    if (bytes + size > CHAT_WINDOW_BYTES) { slid = true; break; }
    bytes += size; tail.push(...frames); end = frames.at(-1)!.seq;
  }
  const events = [...page.events, ...tail];
  let next = await replayChat({ ...emptyChat(), sessionId: current.sessionId, cwd: current.cwd }, page.context, 0, cancelled);
  next = await replayChat(next, events.filter(f => f.seq <= after), 0, cancelled);
  next = keepPending(next, getState());
  next = await replayChat(next, events, after, cancelled);
  if (cancelled()) return;
  next = keepPending(next, getState());
  const live = catchUp.end(key, []).filter(f => f.seq > end);
  const past = slid || window.end !== undefined;
  if (!past) for (const frame of live) next = reduceChat(next, frame.event);
  // An old turn's end is history, not the host's current busy/clock facts.
  const now = getState();
  if (past) next = { ...next, busy: now.busy, turnStartedAt: now.turnStartedAt, turnWaits: now.turnWaits, background: now.background };
  history!.set(id, page.before, past ? end : undefined);
  next = { ...next, exited: now.exited };
  publish(next);
  if (!history!.isPartial(id)) void saveChatCheckpoint({ id, state: next, seq: catchUp.mark(key), updatedAt: Date.now() });
}
