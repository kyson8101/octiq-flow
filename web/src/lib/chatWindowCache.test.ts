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

it("bounds recent windows by count and bytes and keeps covered surfaces", () => {
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
  const covered = cache.retain(states, new Set(), () => true);
  expect(covered.size).toBe(RECENT_CHAT_WINDOWS);
  expect(covered.has("c19")).toBe(true);
  expect([...cache.retain(states, new Set(), () => true)]).toEqual([...covered]);
});

it("keeps six windows in LRU order, promotes a return, and releases a deleted chat", () => {
  const cache = new ChatWindowCache();
  const states = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`c${i}`, emptyChat()]));
  const shown = (id: string) => cache.retain(states, new Set([id]), () => true);
  for (let i = 0; i < 7; i++) shown(`c${i}`);
  expect([...shown("c0")]).toEqual(["c6", "c5", "c4", "c3", "c2", "c1"]);
  expect([...shown("c7")]).toEqual(["c0", "c6", "c5", "c4", "c3", "c2"]);
  delete states.c4;
  expect([...cache.retain(states, new Set(), () => true)]).toEqual(["c7", "c0", "c6", "c5", "c3", "c2"]);
  // A recreated id does not revive the deleted reducer window's recency.
  states.c4 = emptyChat();
  expect(cache.retain(states, new Set(), () => true).has("c4")).toBe(false);
  expect(cache.retain(states, new Set(), id => id !== "c5").has("c5")).toBe(false);
});

it("allows an indivisible large window to occupy the budget and skips an oversize window", () => {
  const cache = new ChatWindowCache();
  const window = (text: number): ChatState => ({ ...emptyChat(), messages: [{ id: "m", role: "assistant", streaming: false,
    blocks: [{ kind: "text", text: "x".repeat(text) }] }] });
  const states = { small: window(2 * 1024 * 1024), large: window(23 * 1024 * 1024),
    oversize: window(25 * 1024 * 1024), current: emptyChat() };
  for (const id of ["small", "large"]) cache.retain(states, new Set([id]), () => true);
  expect([...cache.retain(states, new Set(["current"]), () => true)]).toEqual(["large"]);
  cache.retain(states, new Set(["oversize"]), () => true);
  expect([...cache.retain(states, new Set(["current"]), () => true)]).toEqual(["large"]);
  expect(valueBytes(states.large)).toBeLessThan(RECENT_CHAT_BYTES);
});

it("remeasures an updated background window before retaining it again", () => {
  const cache = new ChatWindowCache();
  const states = { a: emptyChat(), b: emptyChat() };
  cache.retain(states, new Set(["a"]), () => true);
  expect(cache.retain(states, new Set(["b"]), () => true).has("a")).toBe(true);
  states.a = { ...states.a, messages: [{ id: "grown", role: "assistant", streaming: false,
    blocks: [{ kind: "text", text: "x".repeat(RECENT_CHAT_BYTES) }] }] };
  expect(cache.retain(states, new Set(["b"]), () => true).has("a")).toBe(false);
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
