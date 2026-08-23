// Card 66 — room mode has to survive being put down and picked up again.
//
// The switch is stored on the conversation for the reason `store.ts` already
// gives about the model and the permission: reopening a chat must not silently
// change what it was held under. A room that quietly became an ordinary chat
// overnight is exactly that failure.
import { beforeEach, describe, expect, it } from "vitest";

import type { Conversation } from "./store";
import { loadConversations, saveConversations } from "./store";

// vitest runs this suite in the node environment (no jsdom — see the repo
// CLAUDE.md), so there is no localStorage. The store only ever calls these
// three, and a Map is a truthful stand-in for all of them.
beforeEach(() => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});

const chat = (over: Partial<Conversation> = {}): Conversation => ({
  id: "c1",
  projectId: "p1",
  title: "a chat",
  messages: [],
  createdAt: 1,
  updatedAt: 2,
  ...over,
});

describe("room mode on a conversation", () => {
  it("is absent by default, so an ordinary chat says nothing about rooms", () => {
    saveConversations([chat()]);
    expect(loadConversations()[0].room).toBeUndefined();
  });

  it("comes back on after a reload", () => {
    saveConversations([chat({ room: true })]);
    expect(loadConversations()[0].room).toBe(true);
  });

  it("comes back OFF once it has been turned off", () => {
    saveConversations([chat({ room: true })]);
    saveConversations([chat({ room: false })]);
    expect(loadConversations()[0].room).toBe(false);
  });

  it("does not spread to the other chats in the list", () => {
    saveConversations([chat({ id: "c1", room: true }), chat({ id: "c2" })]);
    const back = loadConversations();
    expect(back.find((c) => c.id === "c1")?.room).toBe(true);
    expect(back.find((c) => c.id === "c2")?.room).toBeUndefined();
  });
});
