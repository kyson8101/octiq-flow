// The transcripts get a budget, not the whole shelf.
//
// A browser gives an origin about 5 MB of localStorage, shared by everything
// the app writes. The chat cache is the only thing here big enough to matter,
// and a count of eighty says nothing about size: on one machine it had grown to
// 4.09 MB, and what it had taken was the room every SETTING needed. From there,
// writing four letters into `octiq.v2.effort` threw.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "./store";
import { loadConversations, saveConversations } from "./store";

const real = globalThis.localStorage;
let held: Map<string, string>;

beforeEach(() => {
  held = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => held.get(k) ?? null,
    setItem: (k: string, v: string) => void held.set(k, v),
    removeItem: (k: string) => void held.delete(k),
  });
});

afterEach(() => {
  vi.stubGlobal("localStorage", real);
});

/** A conversation of roughly `kb` kilobytes, `at` deciding how recent it is. */
const chat = (id: string, at: number, kb: number): Conversation => ({
  id,
  projectId: "p",
  title: id,
  messages: [
    { id: "m1", role: "assistant", blocks: [{ kind: "text", text: "x".repeat(kb * 1024) }], streaming: false },
  ],
  createdAt: at,
  updatedAt: at,
});

const storedBytes = () => (held.get("octiq.v2.conversations") ?? "").length;

describe("saving the chat cache", () => {
  it("keeps the newest chats and stays under budget", () => {
    // 8 MB asked for, against a 3 MB budget.
    const list = Array.from({ length: 16 }, (_, i) => chat(`c${i}`, i, 512));

    saveConversations(list);

    expect(storedBytes()).toBeLessThanOrEqual(3 * 1024 * 1024);
    const kept = loadConversations();
    expect(kept.length).toBeGreaterThan(0);
    // Dropped oldest-first, so the most recently used one is always there.
    expect(kept.map((c) => c.id)).toContain("c15");
    expect(kept.map((c) => c.id)).not.toContain("c0");
  });

  it("leaves room for everything else in the store", () => {
    saveConversations(Array.from({ length: 16 }, (_, i) => chat(`c${i}`, i, 512)));

    // The settings are four-byte words, and they are what this exists to
    // protect: an effort level, a model id, which panel was open.
    const spare = 5 * 1024 * 1024 - storedBytes();
    expect(spare).toBeGreaterThan(1024 * 1024);
  });

  it("does not grow the store when one chat alone is over budget", () => {
    saveConversations([chat("huge", 1, 4096)]);

    // Nothing is kept rather than the quota being taken — the chat is on the
    // server too, and reopening it replays from there.
    expect(loadConversations()).toEqual([]);
    expect(storedBytes()).toBeLessThanOrEqual(3 * 1024 * 1024);
  });

  it("skips one oversized chat rather than dropping the ones behind it", () => {
    // The live chat is the most recently updated, so it sorts to the FRONT —
    // and when it alone is over budget, walking down from the full list meant
    // every candidate still contained it, and the store was written empty with
    // a dozen perfectly small chats in hand.
    saveConversations([chat("huge", 99, 4096), ...Array.from({ length: 4 }, (_, i) => chat(`c${i}`, i, 64))]);

    const kept = loadConversations().map((c) => c.id);
    expect(kept).not.toContain("huge");
    expect(kept).toEqual(expect.arrayContaining(["c0", "c1", "c2", "c3"]));
    expect(storedBytes()).toBeLessThanOrEqual(3 * 1024 * 1024);
  });

  it("still shrinks when the browser refuses before the budget does", () => {
    // The budget is this app's guess; the browser is the one that knows. A
    // store with a much smaller quota than we assumed must still end up with
    // something written rather than an exception.
    const CAP = 200 * 1024;
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => held.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (v.length > CAP) throw new DOMException("quota", "QuotaExceededError");
        held.set(k, v);
      },
      removeItem: (k: string) => void held.delete(k),
    });

    expect(() =>
      saveConversations(Array.from({ length: 8 }, (_, i) => chat(`c${i}`, i, 64))),
    ).not.toThrow();
    expect(storedBytes()).toBeLessThanOrEqual(CAP);
    expect(loadConversations().map((c) => c.id)).toContain("c7");
  });
});
