// The deletion list: chats this browser threw away, remembered between visits.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DELETION_TTL_MS,
  MAX_DELETIONS,
  forgetDeletion,
  isDeleted,
  listDeletions,
  markDeleted,
  resetDeletions,
} from "./deletions";

/** A localStorage that lives in memory. The web tests run in node, which has
 *  none, and what this module is for is exactly what survives a reload. */
function fakeStorage() {
  const box = new Map<string, string>();
  return {
    box,
    getItem: (k: string) => box.get(k) ?? null,
    setItem: (k: string, v: string) => void box.set(k, v),
    removeItem: (k: string) => void box.delete(k),
  };
}

/** A fixed "now", so a tombstone's age is decided by the test and not by the
 *  clock the suite happens to run on. */
const NOW = 1_800_000_000_000;

let store = fakeStorage();

beforeEach(() => {
  store = fakeStorage();
  vi.stubGlobal("localStorage", store);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resetDeletions();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the deletion list", () => {
  it("remembers a deleted chat after the page is reloaded", () => {
    markDeleted("c1", "chat:c1");
    // A reload: nothing in memory, everything read back from storage.
    resetDeletions();

    expect(isDeleted("c1")).toBe(true);
  });

  it("says nothing about a chat nobody deleted", () => {
    markDeleted("c1", "chat:c1");

    expect(isDeleted("c2")).toBe(false);
  });

  it("keeps the key the transcript is filed under, so the delete can be retried", () => {
    markDeleted("c1", "chat:c1");
    resetDeletions();

    expect(listDeletions()).toEqual([{ id: "c1", key: "chat:c1", at: NOW }]);
  });

  it("writes a chat down once, however many times it is deleted", () => {
    markDeleted("c1", "chat:c1");
    markDeleted("c1", "chat:c1");

    expect(listDeletions()).toHaveLength(1);
  });

  it("forgets a tombstone once it is old enough that the delete has surely landed", () => {
    markDeleted("old", "chat:old", NOW - DELETION_TTL_MS - 1);
    markDeleted("new", "chat:new");

    expect(listDeletions().map((d) => d.id)).toEqual(["new"]);
    expect(isDeleted("old")).toBe(false);
  });

  it("drops the oldest when the list would grow without bound", () => {
    for (let i = 0; i <= MAX_DELETIONS; i++) markDeleted(`c${i}`, `chat:c${i}`, NOW - 1000 + i);

    expect(listDeletions()).toHaveLength(MAX_DELETIONS);
    expect(isDeleted("c0")).toBe(false);
    expect(isDeleted(`c${MAX_DELETIONS}`)).toBe(true);
  });

  it("lets a tombstone go when the chat it names is wanted back", () => {
    markDeleted("c1", "chat:c1");
    forgetDeletion("c1");
    resetDeletions();

    expect(isDeleted("c1")).toBe(false);
  });

  it("still answers when storage is blocked", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    resetDeletions();

    expect(() => markDeleted("c1", "chat:c1")).not.toThrow();
    // Nothing is remembered between visits, but the delete still holds for as
    // long as this page is open.
    expect(isDeleted("c1")).toBe(true);
  });

  it("ignores a stored list that is not a list", () => {
    store.setItem("octiq.v2.deletedChats", '{"nope":true}');
    resetDeletions();

    expect(listDeletions()).toEqual([]);
  });
});
