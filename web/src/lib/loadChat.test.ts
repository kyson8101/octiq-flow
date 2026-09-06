import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { addUserTurn, emptyChat, reduceChat, type ChatState } from "./chat";
import { CatchUp, type Frame } from "./catchUp";
import { readChatCheckpoint, saveChatCheckpoint } from "./chatCache";
import { loadChat, loadEarlierChat } from "./loadChat";
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
  const live = options.catchUp.live("chat:a", 5, frame(5).event);
  history.append("a", live);
  options.publish(reduceChat(options.getState(), frame(5).event));
  await loadEarlierChat({ ...options, history, request: async (after) => {
    expect(after).toBe(5);
    options.catchUp.live("chat:a", 7, frame(7).event);
    return [frame(6), frame(7)];
  }, requestPage: async (before) => {
    expect(before).toBe(3);
    return { events: [frame(1), frame(2)], context: [], before: null };
  } });
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
  await loadEarlierChat({ ...options, history, request: async () => [], requestPage: async () => ({
    events: [tool], context: [], before: null,
  }) });
  expect(options.getState().messages[0].blocks[0]).toMatchObject({ kind: "tool", result: "file contents", state: "done" });
});

it.each([false, true])("keeps an optimistic prompt while prepending history (echo=%s)", async (echo) => {
  const options = setup();
  const history = new ChatHistory();
  await loadChat({ ...options, history, request: async () => [], requestPage: async () => ({
    events: [frame(2)], context: [], before: 2,
  }) });
  options.publish(addUserTurn(options.getState(), "queued locally", [], 100, undefined, "pending"));
  await loadEarlierChat({ ...options, history, request: async () => echo ? [{ seq: 3, event: {
    type: "user", uuid: "echoed", message: { content: [{ type: "text", text: "queued locally" }] },
  } }] : [], requestPage: async () => ({ events: [frame(1)], context: [], before: null }) });
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
