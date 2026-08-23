// Rewriting a saved chat must not forget what it already knew.
import { describe, expect, it } from "vitest";

import type { Conversation } from "./store";
import { rewriteConversation } from "./store";

const before: Conversation = {
  id: "c1",
  projectId: "p1",
  title: "an older title",
  messages: [],
  createdAt: 1,
  updatedAt: 2,
  room: true,
  sessionId: "sess-1",
  seq: 7,
  synced: true,
};

const fresh = {
  id: "c1",
  projectId: "p1",
  title: "a newer title",
  messages: [],
  modelId: "claude:opus",
  permission: "auto",
  createdAt: 1,
  updatedAt: 99,
};

describe("rewriting a saved chat", () => {
  it("keeps it a room", () => {
    // Reported 2026-08-23: turning group chat on, then sending a message, put
    // the chat back to Single. The debounced save rebuilt the row field by
    // field and `room` was not one of the fields.
    expect(rewriteConversation(before, fresh).room).toBe(true);
  });

  it("keeps every other thing the row already knew", () => {
    const after = rewriteConversation(before, fresh);

    expect(after.sessionId).toBe("sess-1");
    expect(after.seq).toBe(7);
    expect(after.synced).toBe(true);
  });

  it("still takes the new values for what actually changed", () => {
    const after = rewriteConversation(before, fresh);

    expect(after.title).toBe("a newer title");
    expect(after.updatedAt).toBe(99);
  });

  it("does not invent anything for a chat it has never seen", () => {
    const after = rewriteConversation(undefined, fresh);

    expect(after.room).toBeUndefined();
    expect(after.sessionId).toBeUndefined();
    expect(after.title).toBe("a newer title");
  });

  it("lets the caller deliberately clear something", () => {
    // A field explicitly set to undefined in the fresh row is a decision, not
    // an omission — that is how a reset empties `seq`.
    const after = rewriteConversation(before, { ...fresh, seq: 0 });

    expect(after.seq).toBe(0);
  });
});
