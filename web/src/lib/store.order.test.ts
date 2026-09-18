// Pinned chats sit above the rest, whatever their age. Within each section the
// most recent meaningful user/agent activity wins.
import { describe, expect, it } from "vitest";
import { byProject, byTask, type Conversation } from "./store";

const chat = (id: string, createdAt: number, over: Partial<Conversation> = {}): Conversation => ({
  id,
  projectId: "p1",
  title: id,
  messages: [],
  createdAt,
  updatedAt: createdAt,
  ...over,
});

const order = (list: Conversation[]) => byProject(list).get("p1")!.map((c) => c.id);

describe("byProject", () => {
  it("puts the most recently active chat first", () => {
    expect(
      order([chat("old", 1, { updatedAt: 5 }), chat("new", 2, { updatedAt: 4 })]),
    ).toEqual(["old", "new"]);
  });

  it("puts a pinned chat above a newer one", () => {
    expect(order([chat("old", 1, { pinned: true }), chat("new", 2)])).toEqual(["old", "new"]);
  });

  it("keeps pinned chats most recently active first among themselves", () => {
    const list = [
      chat("a", 1, { pinned: true, updatedAt: 4 }),
      chat("b", 3),
      chat("c", 2, { pinned: true, updatedAt: 5 }),
    ];
    expect(order(list)).toEqual(["c", "a", "b"]);
  });

  it("treats an unpinned chat and one that was never pinned alike", () => {
    expect(order([chat("a", 1, { pinned: false }), chat("b", 2)])).toEqual(["b", "a"]);
  });
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
