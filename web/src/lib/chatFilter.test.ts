import { describe, expect, it } from "vitest";
import { chatFilterCount, chatFilterList, isChatDone, isChatFilter } from "./chatFilter";
import type { Conversation } from "./store";

function chat(id: string, updatedAt: number, doneAt?: number | null): Conversation {
  return {
    id,
    projectId: "p1",
    title: id,
    messages: [],
    createdAt: 0,
    updatedAt,
    ...(doneAt === undefined ? {} : { doneAt }),
  } as Conversation;
}

describe("isChatDone", () => {
  it("is false for a chat nobody ticked", () => {
    expect(isChatDone(chat("a", 100))).toBe(false);
    expect(isChatDone(chat("a", 100, null))).toBe(false);
  });

  it("is true while the tick is at least as new as the last activity", () => {
    expect(isChatDone(chat("a", 100, 100))).toBe(true);
    expect(isChatDone(chat("a", 100, 500))).toBe(true);
  });

  it("is false once something happened after the tick", () => {
    // The auto-clear, and the only mechanism there is for it: the message that
    // moved `updatedAt` un-ticked the chat by arriving.
    expect(isChatDone(chat("a", 900, 500))).toBe(false);
  });

  it("does not re-tick a chat that merely went quiet again", () => {
    const retired = chat("a", 900, 500);
    expect(isChatDone(retired)).toBe(false);
    // Time passing changes nothing — only a newer tick does.
    expect(isChatDone({ ...retired, doneAt: 1_000 })).toBe(true);
  });
});

describe("chatFilterList", () => {
  const list = [chat("open", 100), chat("ticked", 100, 200), chat("reopened", 900, 500)];

  it("hides ticked chats from the active list", () => {
    expect(chatFilterList(list, "active").map((c) => c.id)).toEqual(["open", "reopened"]);
  });

  it("shows only ticked chats in the done list", () => {
    expect(chatFilterList(list, "done").map((c) => c.id)).toEqual(["ticked"]);
  });

  it("shows pinned chats literally, ticked ones included", () => {
    // A pinned chat that has also been ticked off is still pinned. Hiding it
    // here would leave a row that no view in the menu lists at all.
    const pinned = [chat("open", 100), { ...chat("kept", 100, 200), pinned: true }];
    expect(chatFilterList(pinned, "pinned").map((c) => c.id)).toEqual(["kept"]);
  });

  it("shows everything under all, without reordering", () => {
    expect(chatFilterList(list, "all").map((c) => c.id)).toEqual(["open", "ticked", "reopened"]);
  });

  it("keeps the chat being read, in its own place, whatever the filter says", () => {
    // Ticking the chat you are looking at shows you the tick; it does not pull
    // the row out from under you. And it stays where it was: the tree ranks
    // rows by their position here, so a kept chat moved to the end would jump
    // to the bottom of the sidebar for as long as it was open.
    expect(chatFilterList(list, "active", "ticked").map((c) => c.id))
      .toEqual(["open", "ticked", "reopened"]);
    expect(chatFilterList(list, "done", "open").map((c) => c.id)).toEqual(["open", "ticked"]);
  });

  it("copies rather than filtering the caller's array in place", () => {
    expect(chatFilterList(list, "all")).not.toBe(list);
  });
});

describe("chatFilterCount", () => {
  it("counts what each view would show, so a zero chip is never offered", () => {
    const list = [chat("a", 100), chat("b", 100, 200), chat("c", 900, 500),
      { ...chat("d", 100), pinned: true }];
    expect(chatFilterCount(list, "done")).toBe(1);
    expect(chatFilterCount(list, "pinned")).toBe(1);
    expect(chatFilterCount(list, "active")).toBe(3);
  });
});

describe("isChatFilter", () => {
  it("accepts the four filters and nothing else", () => {
    expect(isChatFilter("active")).toBe(true);
    expect(isChatFilter("pinned")).toBe(true);
    expect(isChatFilter("done")).toBe(true);
    expect(isChatFilter("all")).toBe(true);
    expect(isChatFilter("archived")).toBe(false);
    expect(isChatFilter(null)).toBe(false);
  });
});
