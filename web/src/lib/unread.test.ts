import { describe, expect, it } from "vitest";
import { isUnread } from "./unread";
import type { Conversation } from "./store";

const conversation = (over: Partial<Conversation> = {}): Conversation => ({
  id: "c1",
  projectId: "p1",
  title: "a chat",
  messages: [],
  createdAt: 100,
  updatedAt: 100,
  ...over,
});

describe("isUnread", () => {
  it("is unread when activity moved past the last read mark", () => {
    expect(isUnread(conversation({ readAt: 100, updatedAt: 200 }), null)).toBe(true);
  });

  it("is not unread once the read mark has caught up", () => {
    expect(isUnread(conversation({ readAt: 200, updatedAt: 200 }), null)).toBe(false);
  });

  it("falls back to when the chat started for one never marked read", () => {
    // A chat from before this field shipped, or simply never opened.
    expect(isUnread(conversation({ createdAt: 100, updatedAt: 100 }), null)).toBe(false);
    expect(isUnread(conversation({ createdAt: 100, updatedAt: 200 }), null)).toBe(true);
  });

  it("never reads the chat on screen as unread, whatever its readAt says", () => {
    // The race `lib/unread.ts` documents: `updatedAt` can outrun a queued
    // read mark while this exact chat is the one being watched.
    expect(isUnread(conversation({ id: "open", readAt: 100, updatedAt: 999 }), "open")).toBe(
      false,
    );
  });

  it("still reads a DIFFERENT chat as unread while another one is open", () => {
    expect(isUnread(conversation({ id: "c1", readAt: 100, updatedAt: 200 }), "c2")).toBe(true);
  });
});
