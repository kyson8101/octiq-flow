import { emptyChat, reduceChat, type ChatState } from "./chat";
import { type CatchUp, type Frame } from "./catchUp";
import { readChatCheckpoint, saveChatCheckpoint } from "./chatCache";
import { replayChat } from "./replayChat";
import { type ChatHistory, type ChatPage } from "./chatHistory";

/** Claude's queued prompts may exist only in this browser until echoed. */
function keepPending(next: ChatState, current: ChatState): ChatState {
  const pending = current.messages.filter((message) => message.role === "user"
    && !message.echo && !message.takenUp
    && !next.messages.some((known) => known.id === message.id
      || (!!message.turnId && known.turnId === message.turnId)));
  return pending.length ? { ...next, busy: next.busy || current.busy, messages: [...next.messages, ...pending] } : next;
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
      publish(cached.state);
      storedSeq = cached.seq;
    }
  }
  if (cancelled()) return;
  const from = catchUp.begin(key, storedSeq);
  const before = getState();
  let page: ChatPage | undefined;
  if (from === 0 && options.requestPage) {
    try { page = await options.requestPage(null); }
    catch (error) {
      // A new client can be served before its backend is restarted. Fall back
      // only for that explicit capability mismatch, not for network errors.
      if (!String(error).includes("not available on this backend")) throw error;
    }
  }
  const run = page?.events ?? await request(from);
  if (cancelled()) return;
  // Imported sessions may have a local transcript before the server has any
  // events for this key. An empty answer must not erase those messages.
  const seed = from === 0 && run?.length ? { ...emptyChat(), sessionId: before.sessionId } : before;
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
  if (page) options.history?.set(id, frames, page.before);
  else options.history?.append(id, frames);
  publish(next);
  if (!options.history?.hasEarlier(id)) {
    void saveChatCheckpoint({ id, state: next, seq: catchUp.mark(key), updatedAt: Date.now() });
  }
}

export async function loadEarlierChat(options: ChatLoadOptions): Promise<void> {
  const { id, key, catchUp, getState, publish, request, cancelled, history, requestPage } = options;
  const window = history?.get(id);
  if (!window || !requestPage) return;
  const after = catchUp.begin(key);
  const [page, tail] = await Promise.all([requestPage(window.before), request(after)]);
  if (cancelled()) return;
  if (page.before !== null && page.before >= window.before) throw new Error("History cursor did not advance");
  const events = [...page.events.filter((f) => f.seq < window.before), ...window.events];
  let next = await replayChat({ ...emptyChat(), sessionId: getState().sessionId }, page.context, 0, cancelled);
  next = await replayChat(next, events, 0, cancelled);
  next = keepPending(next, getState());
  next = await replayChat(next, tail, after, cancelled);
  events.push(...tail);
  if (cancelled()) return;
  next = keepPending(next, getState());
  const replayedThrough = events.at(-1)?.seq ?? after;
  const live = catchUp.end(key, tail).filter((frame) => frame.seq > replayedThrough);
  for (const frame of live) next = reduceChat(next, frame.event);
  events.push(...live);
  history!.set(id, events, page.before);
  // Process exits are live status events, outside the durable transcript.
  next = { ...next, exited: getState().exited };
  publish(next);
  if (!history!.hasEarlier(id)) {
    void saveChatCheckpoint({ id, state: next, seq: catchUp.mark(key), updatedAt: Date.now() });
  }
}
