// Pinned chats sit above the rest, whatever their age. Within each section the
// most recent meaningful user/agent activity wins.
import { describe, expect, it } from "vitest";
import { byTask, type Conversation } from "./store";

const chat = (id: string, createdAt: number, over: Partial<Conversation> = {}): Conversation => ({
  id,
  projectId: "p1",
  title: id,
  messages: [],
  createdAt,
  updatedAt: createdAt,
  ...over,
});

describe("byTask", () => {
  it("puts every project in one auto-sorted task list", () => {
    const old = chat("old", 1, { projectId: "alpha", updatedAt: 5 });
    const fresh = chat("fresh", 3, { projectId: "beta", updatedAt: 4 });
    const pinned = chat("pinned", 2, { projectId: "gamma", pinned: true });
    expect(byTask([old, fresh, pinned]).map((item) => item.id)).toEqual([
      "pinned",
      "old",
      "fresh",
    ]);
  });
});
