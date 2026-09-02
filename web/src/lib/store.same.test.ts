import { describe, expect, it } from "vitest";
import { sameIndex, type Conversation } from "./store";
import type { Message } from "./chat";

const said = (text: string): Message => ({
  id: "u0",
  role: "user",
  blocks: [{ kind: "text", text }],
  streaming: false,
});

const chat = (over: Partial<Conversation> = {}): Conversation => ({
  id: "c1",
  projectId: "p1",
  title: "yesterday's work",
  messages: [],
  createdAt: 10,
  updatedAt: 20,
  synced: true,
  ...over,
});

describe("sameIndex", () => {
  it("is true for the same chats in a different order", () => {
    // The server lists newest first; this page keeps whatever order it had.
    // Same chats, so there is nothing to write down.
    const a = [chat({ id: "c1" }), chat({ id: "c2" })];
    const b = [chat({ id: "c2" }), chat({ id: "c1" })];

    expect(sameIndex(a, b)).toBe(true);
  });

  it("ignores what was said in each chat", () => {
    // The index holds no messages. A row whose transcript grew is still the
    // same row as far as the list is concerned.
    expect(sameIndex([chat()], [chat({ messages: [said("hello")] })])).toBe(true);
  });

  it("is false when a chat arrives", () => {
    expect(sameIndex([chat({ id: "c1" })], [chat({ id: "c1" }), chat({ id: "c2" })])).toBe(false);
  });

  it("is false when a chat goes", () => {
    expect(sameIndex([chat({ id: "c1" }), chat({ id: "c2" })], [chat({ id: "c1" })])).toBe(false);
  });

  it("is false when a chat is pinned or unpinned", () => {
    // A pin moves the row, and the server's answer is how a pin made on
    // another device reaches this one.
    expect(sameIndex([chat()], [chat({ pinned: true })])).toBe(false);
    expect(sameIndex([chat({ pinned: true })], [chat({ pinned: true })])).toBe(true);
  });

  it("is false when a chat is renamed elsewhere", () => {
    expect(sameIndex([chat()], [chat({ title: "renamed on the phone" })])).toBe(false);
  });

  it("is false when the agent session behind a chat changes", () => {
    expect(sameIndex([chat()], [chat({ sessionId: "s2" })])).toBe(false);
  });

  it("is false when the server has now vouched for a chat", () => {
    // `synced` is what tells a missing row from a deleted one, so a change to
    // it has to be written down even though nothing on screen moves.
    expect(sameIndex([chat({ synced: undefined })], [chat({ synced: true })])).toBe(false);
  });
});
