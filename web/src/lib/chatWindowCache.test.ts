import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { addUserTurn, emptyChat, type ChatState } from "./chat";
import { ChatWindowCache, RECENT_CHAT_BYTES, RECENT_CHAT_WINDOWS } from "./chatWindowCache";
import { ChatHistory } from "./chatHistory";
import { CatchUp, type Frame } from "./catchUp";
import { loadChat } from "./loadChat";
import { chatPreviewState } from "./chatRetention";
import { valueBytes } from "./valueBytes";

beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => vi.unstubAllGlobals());
const frame = (id: string, seq: number): Frame => ({ seq, event: {
  type: "assistant", message: { id: `${id}-${seq}`, content: [{ type: "text", text: `${id} answer ${seq}` }] },
} });

it("switches between partial chats without clearing their words or rereading older pages", async () => {
  const cache = new ChatWindowCache(), history = new ChatHistory(), catchUp = new CatchUp();
  const states: Record<string, ChatState> = { a: emptyChat(), b: emptyChat() };
  const request = vi.fn(async (_id: string, _after: number): Promise<Frame[]> => []);
  const pages = vi.fn(async (id: string, before: number | null) => {
    expect(before).toBe(null);
    return { events: [frame(id, 100)], context: [], before: 100 };
  });
  for (const id of ["a", "b", "a", "b", "a"]) {
    const keep = cache.retain(states, new Set([id]), other => catchUp.holds(`chat:${other}`));
    for (const other of Object.keys(states)) if (other !== id && !keep.has(other)) {
      states[other] = chatPreviewState(states[other]); catchUp.forget(`chat:${other}`); history.forget(other);
    }
    const before = states[id];
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const loading = loadChat({ id, key: `chat:${id}`, catchUp, history,
      getState: () => states[id], publish: next => { states[id] = next; }, cancelled: () => false,
      requestPage: async cursor => { await gate; return pages(id, cursor); }, request: after => request(id, after) });
    // Returning to a cached chat must show its original reducer window even
    // with a slow socket. A fresh chat is allowed to be empty.
    expect(states[id]).toBe(before);
    if (catchUp.holds(`chat:${id}`)) expect(states[id].messages.map(m => m.id)).toEqual([`${id}-100`]);
    finish(); await loading;
    expect(states[id].messages.map(m => m.id)).toEqual([`${id}-100`]);
    expect(history.get(id)).toEqual({ before: 100 });
  }
  expect(pages).toHaveBeenCalledTimes(5); // one bounded gap probe per opening
  expect(request.mock.calls).toEqual([["a", 100], ["b", 100], ["a", 100]]);
});

it("bounds recent windows by count and bytes, keeps the newest, and releases covered surfaces", () => {
  const cache = new ChatWindowCache();
  const states: Record<string, ChatState> = {};
  for (let n = 0; n < 20; n++) {
    const id = `c${n}`;
    states[id] = { ...emptyChat(), messages: [{ id, role: "assistant", streaming: false,
      blocks: [{ kind: "text", text: "x".repeat(n % 3 === 0 ? RECENT_CHAT_BYTES : 1000) }] }] };
    const retained = cache.retain(states, new Set([id]), () => true);
    expect(retained.size).toBeLessThanOrEqual(RECENT_CHAT_WINDOWS);
    expect([...retained].reduce((n, id) => n + valueBytes(states[id]), 0)).toBeLessThanOrEqual(RECENT_CHAT_BYTES);
    if (n > 0 && (n - 1) % 3 !== 0) expect(retained.has(`c${n - 1}`)).toBe(true);
  }
  expect(cache.retain(states, new Set(), () => true).size).toBe(0);
  expect(cache.retain(states, new Set(["c0"]), () => true).size).toBe(0);
});

it("evicts the older window when individually fitting windows exceed the combined byte budget", () => {
  const cache = new ChatWindowCache();
  const window = (id: string): ChatState => ({ ...emptyChat(), messages: [{ id, role: "assistant", streaming: false,
    blocks: [{ kind: "text", text: "x".repeat(RECENT_CHAT_BYTES / 3) }] }] });
  const states = { a: window("a"), b: window("b"), c: emptyChat() };
  expect(valueBytes(states.a)).toBeLessThan(RECENT_CHAT_BYTES);
  expect(valueBytes(states.a) + valueBytes(states.b)).toBeGreaterThan(RECENT_CHAT_BYTES);
  cache.retain(states, new Set(["a"]), () => true);
  cache.retain(states, new Set(["b"]), () => true);
  expect([...cache.retain(states, new Set(["c"]), () => true)]).toEqual(["b"]);
});

it("ignores an old chat download after switching away and reopening with a newer request", async () => {
  const catchUp = new CatchUp(), history = new ChatHistory();
  let state = addUserTurn(emptyChat(), "local words", [], 10, "local"), current = 1;
  let finish!: (page: { events: Frame[]; context: Frame[]; before: null }) => void;
  const options = { id: "a", key: "chat:a", catchUp, history,
    getState: () => state, publish: (next: ChatState) => { state = next; }, request: async () => [] };
  const old = loadChat({ ...options, cancelled: () => current !== 1,
    requestPage: () => new Promise(resolve => { finish = resolve; }) });
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  current = 2; catchUp.abandon("chat:a");
  await loadChat({ ...options, cancelled: () => current !== 2,
    requestPage: async () => ({ events: [frame("fresh", 2)], context: [], before: null }) });
  const fresh = state;
  finish({ events: [frame("stale", 1)], context: [], before: null }); await old;
  expect(state).toBe(fresh);
  expect(state.messages.map(m => m.id)).toContain("fresh-2");
  expect(state.messages.map(m => m.id)).not.toContain("stale-1");
  expect(state.messages.some(m => m.turnId === "local")).toBe(true);
  expect(catchUp.mark("chat:a")).toBe(2);
});
