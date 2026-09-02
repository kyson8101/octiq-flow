// Pinned chats sit above the rest of their project, whatever their age. Below
// them the order is still "newest started first", which never moves a row.
import { describe, expect, it } from "vitest";
import { byProject, type Conversation } from "./store";

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
  it("puts the newest chat first", () => {
    expect(order([chat("old", 1), chat("new", 2)])).toEqual(["new", "old"]);
  });

  it("puts a pinned chat above a newer one", () => {
    expect(order([chat("old", 1, { pinned: true }), chat("new", 2)])).toEqual(["old", "new"]);
  });

  it("keeps pinned chats newest first among themselves", () => {
    const list = [chat("a", 1, { pinned: true }), chat("b", 3), chat("c", 2, { pinned: true })];
    expect(order(list)).toEqual(["c", "a", "b"]);
  });

  it("treats an unpinned chat and one that was never pinned alike", () => {
    expect(order([chat("a", 1, { pinned: false }), chat("b", 2)])).toEqual(["b", "a"]);
  });
});
