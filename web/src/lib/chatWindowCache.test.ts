import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { addUserTurn, emptyChat, type ChatState } from "./chat";
import { ChatWindowCache, RECENT_CHAT_BYTES } from "./chatWindowCache";

// A small stand-in so no test allocates hundreds of MiB of text.
const BUDGET = 4 * 1024 * 1024;
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
  const cache = new ChatWindowCache(BUDGET), history = new ChatHistory(), catchUp = new CatchUp();
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

const big = (id: string, bytes: number): ChatState => ({ ...emptyChat(), messages: [{ id, role: "assistant", streaming: false,
  blocks: [{ kind: "text", text: "x".repeat(Math.floor((bytes - 200) / 2)) }] }] });

it("defaults to a 512 MiB safety budget and no count cap", () => {
  expect(RECENT_CHAT_BYTES).toBe(512 * 1024 * 1024);
});

it("keeps every opened window; only the byte safety budget evicts, oldest first", () => {
  const cache = new ChatWindowCache(BUDGET);
  const states: Record<string, ChatState> = {};
  // 60 chats is far past the old six-window cap and well under 512 MiB.
  for (let n = 0; n < 60; n++) {
    const id = `c${n}`;
    states[id] = big(id, 64 * 1024);
    cache.retain(states, new Set([id]), () => true);
  }
  expect(cache.retain(states, new Set(), () => true).size).toBe(60);
  // Past the budget the OLDEST goes, never the most recent.
  const heavy = (id: string) => big(id, BUDGET / 4 + 1);
  const huge: Record<string, ChatState> = { a: heavy("a"), b: heavy("b"), c: heavy("c"), d: heavy("d"), now: emptyChat() };
  const second = new ChatWindowCache(BUDGET);
  for (const id of ["a", "b", "c", "d"]) second.retain(huge, new Set([id]), () => true);
  expect([...second.retain(huge, new Set(["now"]), () => true)]).toEqual(["d", "c", "b"]);
});

it("never evicts a window that holds a prompt only this tab has", () => {
  const cache = new ChatWindowCache(BUDGET);
  const states: Record<string, ChatState> = {
    typed: big("typed", BUDGET / 2 + 1), b: big("b", BUDGET / 2 + 1),
    c: big("c", BUDGET / 2 + 1), now: emptyChat() };
  for (const id of ["typed", "b", "c"]) cache.retain(states, new Set([id]), () => true, id => id === "typed");
  const kept = cache.retain(states, new Set(["now"]), () => true, id => id === "typed");
  expect(kept.has("typed")).toBe(true);
  expect(kept.has("c")).toBe(true);
  expect(kept.has("b")).toBe(false);
});

it("releases a deleted chat and a window the host no longer holds, and keeps covered surfaces", () => {
  const cache = new ChatWindowCache(BUDGET);
  const states = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`c${i}`, emptyChat()]));
  const shown = (id: string) => cache.retain(states, new Set([id]), () => true);
  for (let i = 0; i < 9; i++) shown(`c${i}`);
  expect([...shown("c0")]).toEqual(["c8", "c7", "c6", "c5", "c4", "c3", "c2", "c1"]);
  expect([...cache.retain(states, new Set(), () => true)]).toEqual(["c0", "c8", "c7", "c6", "c5", "c4", "c3", "c2", "c1"]);
  delete states.c4;
  expect(cache.retain(states, new Set(), () => true).has("c4")).toBe(false);
  // A recreated id does not revive the deleted reducer window's recency.
  states.c4 = emptyChat();
  expect(cache.retain(states, new Set(), () => true).has("c4")).toBe(false);
  expect(cache.retain(states, new Set(), id => id !== "c5").has("c5")).toBe(false);
});

it("lets a large window use the budget alone and skips one larger than it", () => {
  const cache = new ChatWindowCache(BUDGET);
  const states = { small: big("small", 2 * 1024 * 1024), large: big("large", BUDGET - 1024 * 1024),
    oversize: big("oversize", BUDGET + 1024 * 1024), current: emptyChat() };
  for (const id of ["small", "large"]) cache.retain(states, new Set([id]), () => true);
  expect([...cache.retain(states, new Set(["current"]), () => true)]).toEqual(["large"]);
  cache.retain(states, new Set(["oversize"]), () => true);
  expect([...cache.retain(states, new Set(["current"]), () => true)]).toEqual(["large"]);
});

it("remeasures an updated background window before retaining it again", () => {
  const cache = new ChatWindowCache(BUDGET);
  const states = { a: emptyChat(), b: emptyChat() };
  cache.retain(states, new Set(["a"]), () => true);
  expect(cache.retain(states, new Set(["b"]), () => true).has("a")).toBe(true);
  states.a = { ...states.a, messages: [{ id: "grown", role: "assistant", streaming: false,
    blocks: [{ kind: "text", text: "x".repeat(BUDGET) }] }] };
  expect(cache.retain(states, new Set(["b"]), () => true).has("a")).toBe(false);
});

it("evicts the older window when individually fitting windows exceed the combined byte budget", () => {
  const cache = new ChatWindowCache(BUDGET);
  const window = (id: string): ChatState => ({ ...emptyChat(), messages: [{ id, role: "assistant", streaming: false,
    blocks: [{ kind: "text", text: "x".repeat(BUDGET / 3) }] }] });
  const states = { a: window("a"), b: window("b"), c: emptyChat() };
  expect(valueBytes(states.a)).toBeLessThan(BUDGET);
  expect(valueBytes(states.a) + valueBytes(states.b)).toBeGreaterThan(BUDGET);
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
