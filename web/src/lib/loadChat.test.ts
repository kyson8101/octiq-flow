import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { addUserTurn, emptyChat, reduceChat, type ChatState } from "./chat";
import { CatchUp, type Frame } from "./catchUp";
import { readChatCheckpoint, saveChatCheckpoint } from "./chatCache";
import { loadChat, loadEarlierChat, CHAT_WINDOW_PAGES } from "./loadChat";
import * as chatReducer from "./chat";
import { replayChat } from "./replayChat";
import { ChatHistory } from "./chatHistory";

beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => vi.unstubAllGlobals());

function setup() {
  let state = emptyChat();
  return { id: "a", key: "chat:a", catchUp: new CatchUp(),
    getState: () => state, publish: (next: ChatState) => { state = next; }, cancelled: () => false };
}

const frame = (seq: number): Frame => ({ seq, event: {
  type: "assistant", message: { id: `m${seq}`, content: [{ type: "text", text: `answer ${seq}` }] },
} });

it("shows saved messages before the network answers, then adds the missing and live tails once", async () => {
  const state = await replayChat(emptyChat(), [frame(1)], 0, () => false);
  await saveChatCheckpoint({ id: "a", seq: 1, state, updatedAt: 1 });
  const options = setup();
  let finish!: (frames: Frame[]) => void;
  const request = vi.fn(() => new Promise<Frame[]>((resolve) => { finish = resolve; }));
  const loading = loadChat({ ...options, request });
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith(1));
  expect(options.getState().messages).toEqual(state.messages);
  expect(options.catchUp.live("chat:a", 3, frame(3).event)).toEqual([]);
  finish([frame(2), frame(3)]);
  await loading;
  expect(options.getState().messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  expect(options.catchUp.mark("chat:a")).toBe(3);
});

it("ignores an older IndexedDB snapshot when localStorage has a newer copy", async () => {
  await saveChatCheckpoint({ id: "a", seq: 1, state: emptyChat(), updatedAt: 1 });
  const options = setup();
  const newer = await replayChat(emptyChat(), [frame(2)], 0, () => false);
  options.publish(newer);
  const request = vi.fn(async () => []);
  await loadChat({ ...options, storedSeq: 2, request });
  expect(request).toHaveBeenCalledWith(2);
  expect(options.getState()).toBe(newer);
});

it("keeps local words, attachments and queue state while a released chat seeds from IndexedDB and replays", async () => {
  const saved = await replayChat(emptyChat(), [frame(1)], 0, () => false);
  await saveChatCheckpoint({ id: "a", seq: 1, state: saved, updatedAt: 1 });
  const options = setup();
  const local = addUserTurn(emptyChat(), "only in this tab", [], 10, "local");
  const prompt = { ...local.messages[0], delivery: "queued" as const, queueError: "retry later",
    attachments: [{ path: "/fixture/image.png", name: "image.png", isImage: true }] };
  options.publish({ ...local, messages: [prompt] });
  let finish!: (frames: Frame[]) => void;
  const request = vi.fn(() => new Promise<Frame[]>(resolve => { finish = resolve; }));
  const loading = loadChat({ ...options, request });
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith(1));
  expect(options.getState().messages.find(message => message.id === prompt.id)).toEqual(prompt);
  finish([frame(2)]); await loading;
  expect(options.getState().messages.find(message => message.id === prompt.id)).toEqual(prompt);
});

it.each(["octiq_user_turn_cancelled", "octiq_user_turn_dismissed"])("lets replayed %s remove a local-only prompt", async type => {
  const options = setup();
  options.publish(addUserTurn(emptyChat(), "local words", [], 10, "local"));
  await loadChat({ ...options, request: async () => [frame(1), { seq: 2, event: { type, uuid: "local" } }] });
  expect(options.getState().messages.some(message => message.turnId === "local")).toBe(false);
});

it("keeps an unrelated old echo separate and applies only identified delivery/pickup facts", async () => {
  const options = setup();
  options.publish(addUserTurn(emptyChat(), "continue", [], 10, "local"));
  await loadChat({ ...options, request: async () => [
    { seq: 1, event: { type: "user", uuid: "old-echo", message: { content: [{ type: "text", text: "continue" }] } } },
    { seq: 2, event: { type: "octiq_user_turn_delivery", uuid: "local", state: "queued" } },
  ] });
  expect(options.getState().messages).toHaveLength(2);
  expect(options.getState().messages.find(message => message.turnId === "local")).toMatchObject({ delivery: "queued" });
  expect(options.getState().messages.find(message => message.turnId === "local")?.echo).toBeUndefined();
  options.catchUp.forget("chat:a");
  await loadChat({ ...options, request: async () => [frame(1), { seq: 2, event: { type: "turn.started", octiq_user_turn_id: "local" } }] });
  expect(options.getState().messages.find(message => message.turnId === "local")).toMatchObject({ takenUp: true, delivery: "dispatched" });
});

it("does not resurrect a chat cleared or deleted during download", async () => {
  const options = setup();
  let cancelled = false;
  await loadChat({ ...options, cancelled: () => cancelled, request: async () => {
    cancelled = true;
    options.catchUp.forget("chat:a");
    return [frame(1)];
  } });
  expect(options.getState().messages).toEqual([]);
  expect(options.catchUp.holds("chat:a")).toBe(false);
});

it("keeps an imported transcript when the server has no events for it yet", async () => {
  const options = setup();
  const imported = await replayChat(emptyChat(), [frame(1)], 0, () => false);
  options.publish(imported);
  await loadChat({ ...options, request: async () => [] });
  expect(options.getState().messages).toEqual(imported.messages);
});

// The reported bug: a past session picked up into a new chat, nothing said,
// reopened where the page's own copy is gone. Its history is the start of the
// chat's record on the server now, so it comes back from there — still
// pointing at the session and the folder it ran in, or the first message would
// resume nothing.
it("reopens a picked-up session from its record when this page holds no copy", async () => {
  const history: Frame[] = [
    { seq: 1, event: { type: "user", message: { role: "user", content: [{ type: "text", text: "fix the bug" }] } } },
    { seq: 2, event: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } } },
  ];
  const options = setup();
  // What opening the chat seeds from the server's index: no messages.
  options.publish({ ...emptyChat(), sessionId: "s-1", cwd: "/work/app" });
  const requestPage = vi.fn(async () => ({ events: history, context: [], before: null }));
  await loadChat({ ...options, requestPage, request: async () => [] });
  expect(requestPage).toHaveBeenCalledWith(null);
  const state = options.getState();
  const said = (m: (typeof state.messages)[number]) =>
    m.blocks.map((b) => (b.kind === "text" ? b.text : "")).join("");
  expect(state.messages.map((m) => [m.role, said(m)])).toEqual([["user", "fix the bug"], ["assistant", "done"]]);
  expect(state.sessionId).toBe("s-1");
  expect(state.cwd).toBe("/work/app");
  expect(options.catchUp.mark("chat:a")).toBe(2);
});

it("reads a chat afresh when its record was compacted inside the stream a saved copy ends in", async () => {
  const stream = (seq: number, event: Record<string, unknown>): Frame => ({ seq, event: { type: "stream_event", event } });
  const piece = (seq: number, text: string) => stream(seq, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  const start = stream(1, { type: "message_start", message: { id: "m1" } });
  const stop = stream(4, { type: "message_stop" });
  // Saved while the reply was arriving: "hel" of "hello".
  const saved = await replayChat(emptyChat(), [start, piece(2, "hel")], 0, () => false);
  await saveChatCheckpoint({ id: "a", seq: 2, state: saved, updatedAt: 1 });
  // Since then the record merged the pieces into line 2 and emptied line 3.
  const compacted = [start, piece(2, "hello"), { seq: 3, event: { type: "octiq_compacted", into: 2 } }, stop];
  const options = setup();
  const request = vi.fn(async (after: number) => compacted.filter((f) => f.seq > after));
  const requestPage = vi.fn(async () => ({ events: compacted, context: [], before: null }));
  await loadChat({ ...options, history: new ChatHistory(), request, requestPage });
  expect(request).toHaveBeenCalledExactlyOnceWith(2);
  expect(requestPage).toHaveBeenCalledExactlyOnceWith(null);
  expect(options.getState().messages.map((m) => m.blocks)).toEqual([[{ kind: "text", text: "hello" }]]);
  expect(options.catchUp.mark("chat:a")).toBe(4);
});

it("downloads only the recent page and never caches it as a complete conversation", async () => {
  const options = setup();
  const history = new ChatHistory();
  const request = vi.fn(async () => []);
  const requestPage = vi.fn(async () => ({ events: [frame(100)], context: [
    { seq: 1, event: { type: "system", subtype: "init", session_id: "resume-me" } },
  ], before: 100 }));
  await loadChat({ ...options, history, request, requestPage });
  expect(requestPage).toHaveBeenCalledExactlyOnceWith(null);
  expect(request).not.toHaveBeenCalled();
  expect(options.getState().messages.map((m) => m.id)).toEqual(["m100"]);
  expect(options.getState().sessionId).toBe("resume-me");
  expect(history.hasEarlier("a")).toBe(true);
  expect(await readChatCheckpoint("a")).toBeUndefined();
});

it("prepends older pages and keeps both streamed and reconnected tails exactly once", async () => {
  const options = setup();
  const history = new ChatHistory();
  await loadChat({ ...options, history, request: async () => [], requestPage: async () => ({
    events: [frame(3), frame(4)], context: [], before: 3,
  }) });
  options.catchUp.live("chat:a", 5, frame(5).event);
  options.publish(reduceChat(options.getState(), frame(5).event));
  const request = vi.fn(async () => { throw new Error("must not download an unbounded tail"); });
  await loadEarlierChat({ ...options, history, request, requestPage: async (before) => {
    if (before === 3) return { events: [frame(1), frame(2)], context: [], before: null };
    expect(before).toBe(null);
    options.catchUp.live("chat:a", 7, frame(7).event);
    return { events: [frame(3), frame(4), frame(5), frame(6), frame(7)], context: [], before: 3 };
  } });
  expect(request).not.toHaveBeenCalled();
  expect(options.getState().messages.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6", "m7"]);
  expect(options.catchUp.mark("chat:a")).toBe(7);
  expect(history.hasEarlier("a")).toBe(false);
});

it("rejoins tool results to older tool calls when their page is loaded", async () => {
  const options = setup();
  const history = new ChatHistory();
  const tool = { seq: 1, event: { type: "assistant", message: { id: "tool", content: [
    { type: "tool_use", id: "call", name: "Read", input: { path: "a.txt" } },
  ] } } };
  const result = { seq: 2, event: { type: "user", message: { content: [
    { type: "tool_result", tool_use_id: "call", content: "file contents" },
  ] } } };
  await loadChat({ ...options, history, request: async () => [], requestPage: async () => ({
    events: [result, frame(3)], context: [], before: 2,
  }) });
  await loadEarlierChat({ ...options, history, request: async () => [result, frame(3)], requestPage: async before => before === 2 ? ({
    events: [tool], context: [], before: null,
  }) : ({ events: [result, frame(3)], context: [], before: 2 }) });
  expect(options.getState().messages[0].blocks[0]).toMatchObject({ kind: "tool", result: "file contents", state: "done" });
});

it.each([false, true])("keeps an optimistic prompt while prepending history (echo=%s)", async (echo) => {
  const options = setup();
  const history = new ChatHistory();
  await loadChat({ ...options, history, request: async () => [], requestPage: async () => ({
    events: [frame(2)], context: [], before: 2,
  }) });
  options.publish(addUserTurn(options.getState(), "queued locally", [], 100, "pending"));
  await loadEarlierChat({ ...options, history, request: async () => [], requestPage: async before => before === 2
    ? { events: [frame(1)], context: [], before: null }
    : { events: [frame(2), ...(echo ? [{ seq: 3, event: { type: "user", uuid: "echoed", message: { content: [{ type: "text", text: "queued locally" }] } } }] : [])], context: [], before: 2 } });
  const users = options.getState().messages.filter((m) => m.role === "user");
  expect(users).toHaveLength(1);
  expect(users[0].turnId).toBe("pending");
  expect(users[0].echo).toBe(echo ? "echoed" : undefined);
});

it("falls back for an older backend, but never turns a network error into a full download", async () => {
  const options = setup();
  const request = vi.fn(async () => [frame(1)]);
  await loadChat({ ...options, request, requestPage: async () => {
    throw new Error("'chat_page' is not available on this backend");
  } });
  expect(request).toHaveBeenCalledOnce();
  const fresh = setup();
  request.mockClear();
  await expect(loadChat({ ...fresh, id: "uncached", request, requestPage: async () => {
    throw new Error("Connection closed");
  } })).rejects.toThrow("Connection closed");
  expect(request).not.toHaveBeenCalled();
});

it("yields during a long cold replay and folds every event", async () => {
  let now = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => ++now);
  const frames = Array.from({ length: 1000 }, (_, n) => frame(n + 1));
  let yielded = false;
  setTimeout(() => { yielded = true; }, 0);
  const result = await replayChat(emptyChat(), frames, 0, () => false);
  expect(yielded).toBe(true);
  expect(result.messages).toHaveLength(1000);
  clock.mockRestore();
});

it("a long offline gap resets to the recent page without downloading the whole missing record", async () => {
  const options = setup();
  await saveChatCheckpoint({ id: "a", seq: 1, state: await replayChat(emptyChat(), [frame(1)], 0, () => false), updatedAt: 1 });
  const history = new ChatHistory();
  const request = vi.fn(async () => { throw new Error("unbounded tail"); });
  await loadChat({ ...options, history, request, requestPage: async () => ({ events: [frame(100000)], context: [], before: 100000 }) });
  expect(request).not.toHaveBeenCalled();
  expect(options.getState().messages.map(m => m.id)).toEqual(["m100000"]);
  expect(history.hasEarlier("a")).toBe(true);
  expect(options.catchUp.mark("chat:a")).toBe(100000);
});

it("slides a byte-full history window backwards without caching it as a complete record", async () => {
  const options = setup(); const history = new ChatHistory();
  const big = (seq: number, length: number): Frame => ({ seq, event: { type: "assistant", message: { id: `m${seq}`, content: [{ type: "text", text: "x".repeat(length) }] } } });
  const latest = big(30, 3 * 1024 * 1024), older = big(20, 2 * 1024 * 1024);
  await loadChat({ ...options, history, request: async () => [], requestPage: async () => ({ events: [latest], context: [], before: 30 }) });
  const request = vi.fn(async () => { throw new Error("unbounded tail"); });
  await loadEarlierChat({ ...options, history, request, requestPage: async before => before === 30
    ? { events: [older], context: [], before: null }
    : { events: [latest], context: [], before: 30 } });
  expect(request).not.toHaveBeenCalled();
  expect(options.getState().messages.map(m => m.id)).toEqual(["m20"]);
  expect(history.isPast("a")).toBe(true); expect(history.isPartial("a")).toBe(true);
  expect(history.hasEarlier("a")).toBe(false);
  expect(await readChatCheckpoint("a")).toBeUndefined();
});

it("does only per-page replay/download work and shares already reduced message bodies", async () => {
  const options = setup(), history = new ChatHistory();
  const requestPage = vi.fn(async (before: number | null) => {
    const end = before === null ? 1000 : before - 1;
    return { events: [frame(end - 1), frame(end)], context: [], before: end - 1 };
  });
  await loadChat({ ...options, history, request: async () => [], requestPage });
  const reducer = vi.spyOn(chatReducer, "reduceChat");
  for (let n = 0; n < 20; n++) {
    const previous = options.getState().messages;
    requestPage.mockClear(); reducer.mockClear();
    await loadEarlierChat({ ...options, history, request: async () => { throw new Error("unbounded tail"); }, requestPage });
    // An old implementation re-downloaded and reduced every loaded page here.
    expect(requestPage.mock.calls.length).toBeLessThanOrEqual(2);
    expect(reducer.mock.calls.length).toBeLessThanOrEqual(2);
    expect(options.getState().messages[2]).toBe(previous[0]);
    expect(history.slices("a").length).toBeLessThanOrEqual(CHAT_WINDOW_PAGES);
    expect(options.getState().messages.length).toBeLessThanOrEqual(CHAT_WINDOW_PAGES * 2);
  }
  expect(history.isPast("a")).toBe(true);
  reducer.mockRestore();
});

it("waits to publish until scrolling settles and keeps live events held meanwhile", async () => {
  const options = setup(), history = new ChatHistory();
  await loadChat({ ...options, history, request: async () => [], requestPage: async () => ({ events: [frame(3)], context: [], before: 3 }) });
  let ready!: () => void;
  const beforePrepend = vi.fn(() => new Promise<void>(resolve => { ready = resolve; }));
  const loading = loadEarlierChat({ ...options, history, beforePrepend, request: async () => [],
    requestPage: async before => before === 3 ? { events: [frame(2)], context: [], before: 2 } : { events: [frame(3)], context: [], before: 3 } });
  await vi.waitFor(() => expect(beforePrepend).toHaveBeenCalledOnce());
  expect(options.getState().messages.map(m => m.id)).toEqual(["m3"]);
  expect(options.catchUp.live("chat:a", 4, frame(4).event)).toEqual([]);
  ready(); await loading;
  expect(options.getState().messages.map(m => m.id)).toEqual(["m2", "m3", "m4"]);
});

it("never text-confirms a new local turn against a different older stamped identity", async () => {
  const options = setup(), history = new ChatHistory();
  await loadChat({ ...options, history, request: async () => [], requestPage: async () => ({ events: [frame(3)], context: [], before: 3 }) });
  options.publish(addUserTurn(options.getState(), "continue", [], 100, "new-local"));
  const prompt = options.getState().messages.at(-1);
  await loadEarlierChat({ ...options, history, request: async () => [], requestPage: async before => before === 3
    ? { events: [{ seq: 2, event: { type: "user", uuid: "old-echo", octiq_user_turn_id: "old-local", message: { content: [{ type: "text", text: "continue" }] } } }], context: [], before: 2 }
    : { events: [frame(3)], context: [], before: 3 } });
  expect(options.getState().messages.find(m => m.turnId === "new-local")).toBe(prompt);
  expect(prompt?.echo).toBeUndefined();
  expect(options.getState().messages.filter(m => m.role === "user")).toHaveLength(2);
});

it("does not advance the older cursor or publish if cancelled while waiting for the viewport", async () => {
  const options = setup(), history = new ChatHistory();
  await loadChat({ ...options, history, request: async () => [], requestPage: async () => ({ events: [frame(3)], context: [], before: 3 }) });
  const original = options.getState(); let cancelled = false;
  await loadEarlierChat({ ...options, history, cancelled: () => cancelled, beforePrepend: async () => { cancelled = true; }, request: async () => [],
    requestPage: async before => before === 3 ? { events: [frame(2)], context: [], before: 2 } : { events: [frame(3)], context: [], before: 3 } });
  expect(options.getState()).toBe(original);
  expect(history.get("a")?.before).toBe(3);
});

it.each(["anonymous-assistant", "compaction"])("keeps distinct page-local fallback ids (%s)", async kind => {
  const options = setup(), history = new ChatHistory();
  const event = (text: string) => kind === "compaction"
    ? { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: text } }
    : { type: "assistant", message: { content: [{ type: "text", text }] } };
  await loadChat({ ...options, history, request: async () => [], requestPage: async () => ({ events: [{ seq: 3, event: event("newer") }], context: [], before: 3 }) });
  const previous = options.getState().messages[0];
  await loadEarlierChat({ ...options, history, request: async () => [], requestPage: async before => before === 3
    ? { events: [{ seq: 2, event: event("older") }], context: [], before: 2 }
    : { events: [{ seq: 3, event: event("newer") }], context: [], before: 3 } });
  expect(options.getState().messages).toHaveLength(2);
  expect(options.getState().messages[1]).toBe(previous);
  expect(options.getState().messages[0].id).not.toBe(previous.id);
});

it("applies an identified dismissal to a retained local prompt without replaying old messages", async () => {
  const options = setup(), history = new ChatHistory();
  await loadChat({ ...options, history, request: async () => [], requestPage: async () => ({ events: [frame(3)], context: [], before: 3 }) });
  options.publish(addUserTurn(options.getState(), "local", [], 100, "dismissed"));
  await loadEarlierChat({ ...options, history, request: async () => [], requestPage: async before => before === 3
    ? { events: [{ seq: 2, event: { type: "octiq_user_turn_dismissed", uuid: "dismissed" } }], context: [], before: 2 }
    : { events: [frame(3)], context: [], before: 3 } });
  expect(options.getState().messages.map(m => m.id)).toEqual(["m3"]);
});

it("evicts historical agent and unmatched outcome projections with their page", async () => {
  const options = setup(), history = new ChatHistory();
  const page = (start: number) => ({ context: [], before: start, events: [frame(start),
    { seq: start + 1, event: { type: "system", subtype: "task_started", task_id: `agent-${start}`, task_type: "local_agent" } },
    { seq: start + 2, event: { type: "octiq_tool_outcome", tool_use_id: `missing-${start}`, octiq_outcome: { origin: "octiqflow", reasonClass: "approval-expired", severity: "warning" } } },
  ] });
  const requestPage = async (before: number | null) => page(before === null ? 1000 : before - 3);
  await loadChat({ ...options, history, request: async () => [], requestPage: async () => page(1000) });
  for (let n = 0; n < 20; n++) await loadEarlierChat({ ...options, history, request: async () => [], requestPage });
  expect(options.getState().agents).toHaveLength(CHAT_WINDOW_PAGES);
  expect(Object.keys(options.getState().pendingOutcomes ?? {})).toHaveLength(CHAT_WINDOW_PAGES);
  expect(options.getState().agents.some(a => a.id === "agent-1000")).toBe(false);
});
