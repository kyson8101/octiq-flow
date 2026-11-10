import { describe, expect, it } from "vitest";
import { applyCleanupEvent, CleanupRequests, cleanupAsk, cleanupOutcome, cleanupRequest, cleanupResult, type CleanupEvent } from "./workspaceCleanup";
import { pendingReading, pendingLabel, pendingTone, WAIT_SOURCES } from "./pendingActions";
import { EMPTY_ORCHESTRATION } from "./orchestration";
import { waitingChats } from "./chatWait";

import { cleanupAsked, cleanupSettled } from "./__fixtures__/workspaceCleanup";

describe("cleanup card reading", () => {
  it("uses one batch identity for the badge, chat row and coordinator park", () => {
    const reading = pendingReading({ orchestration: EMPTY_ORCHESTRATION, parents: new Map(), cleanupRequests: { coordinator: [cleanupAsked, cleanupAsked] } });
    expect(reading.actions).toEqual([{ key: "cleanup:batch-1", kind: "cleanup", rowId: "coordinator", openChatId: "coordinator", surface: "chat", chatId: "coordinator", runId: undefined, taskId: undefined }]);
    expect(pendingLabel(reading.actions)).toBe("Cleanup approval");
    expect(pendingTone(reading.actions)).toBe("decide");
    expect([...waitingChats(reading.actions)]).toEqual([["coordinator", "approval"]]);
    expect(WAIT_SOURCES).toContain("orchestration_workspace_cleanup_request_pending");
  });

  it("does not badge or park a settled receipt", () => {
    const reading = pendingReading({ orchestration: EMPTY_ORCHESTRATION, parents: new Map(), cleanupRequests: { coordinator: [{ id: cleanupAsked.id, chatKey: cleanupAsked.chatKey, request: cleanupAsked, result: cleanupSettled }] } });
    expect(reading.actions).toEqual([]);
    expect(waitingChats(reading.actions).size).toBe(0);
  });

  it("counts every root, missions, and a mission that closes only its record", () => {
    expect(cleanupAsk(cleanupAsked)).toBe("Remove 3 finished worktrees and close 1 mission? Their work is merged.");
    expect(cleanupAsk({ ...cleanupAsked, items: [cleanupAsked.items[0]] })).toBe("Remove 1 finished worktree? Their work is merged.");
    expect(cleanupAsk({ ...cleanupAsked, items: [{ ...cleanupAsked.items[1], worktrees: [] }] })).toBe("Close 1 finished mission? Their work is merged.");
  });

  it("reports host outcomes and never calls a denial removed", () => {
    expect(cleanupOutcome(cleanupSettled)).toBe("1 removed · 1 kept");
    expect(cleanupOutcome({ ...cleanupSettled, approved: false })).toBe("Nothing removed · kept them all");
  });

  it("names the work in progress for removal, denial and record-only missions", () => {
    const processing = { ...cleanupAsked, processing: true, approved: true };
    expect(cleanupAsk(processing)).toBe("Removing 3 worktrees…");
    expect(cleanupAsk({ ...processing, items: [cleanupAsked.items[0]] })).toBe("Removing 1 worktree…");
    expect(cleanupAsk({ ...processing, approved: false })).toBe("Keeping them…");
    expect(cleanupAsk({ ...processing, approved: undefined })).toBe("Working…");
    expect(cleanupAsk({ ...processing, items: [{ ...cleanupAsked.items[1], worktrees: [] }] })).toBe("Closing 1 mission…");
  });
});

describe("cleanup pending reconciliation", () => {
  it("evicts orphan progress after successful empty reads, as in the review reproduction", () => {
    const store = new CleanupRequests();
    applyCleanupEvent(store, { state: "item", id: "orphan", chatKey: cleanupAsked.chatKey, item: cleanupSettled.items[0] });
    for (let read = 0; read < 10; read++) store.finish(store.begin(), []);
    expect(store["progress"].size).toBe(0);
    expect(store.current).toEqual({});
  });

  it("bounds 1000 unknown ids to 64 and evicts the first arrivals even after updates", () => {
    const store = new CleanupRequests();
    for (let index = 0; index < 1000; index++) {
      if (index === 64) {
        applyCleanupEvent(store, { state: "item", id: "orphan-0", chatKey: cleanupAsked.chatKey, item: cleanupSettled.items[1] });
      }
      applyCleanupEvent(store, { state: "item", id: `orphan-${index}`, chatKey: cleanupAsked.chatKey, item: cleanupSettled.items[0] });
      expect(store["progress"].size).toBeLessThanOrEqual(64);
      if (index === 64) expect(store["progress"].has("orphan-0")).toBe(false);
    }
    expect([...store["progress"].keys()]).toEqual(Array.from({ length: 64 }, (_, index) => `orphan-${936 + index}`));
    expect(store.current).toEqual({});
  });

  it.each([false, true])("retains progress arriving after begin until the next empty read (prior=%s)", (prior) => {
    const store = new CleanupRequests();
    if (prior) applyCleanupEvent(store, { state: "processing", id: cleanupAsked.id, chatKey: cleanupAsked.chatKey, approved: false });
    const token = store.begin();
    applyCleanupEvent(store, { state: "item", id: cleanupAsked.id, chatKey: cleanupAsked.chatKey, item: cleanupSettled.items[0] });
    store.finish(token, []);
    expect(store["progress"].size).toBe(1);
    expect(store.current).toEqual({});
    store.finish(store.begin(), []);
    expect(store["progress"].size).toBe(0);
  });

  it("does not evict progress on cancelled or obsolete reads", () => {
    const store = new CleanupRequests();
    applyCleanupEvent(store, { state: "item", id: cleanupAsked.id, chatKey: cleanupAsked.chatKey, item: cleanupSettled.items[0] });
    const cancelled = store.begin();
    store.cancel(cancelled);
    expect(store.finish(cancelled, [])).toBeNull();
    const token = store.begin();
    expect(store.finish(cancelled, [])).toBeNull();
    expect(store["progress"].size).toBe(1);
    store.finish(token, [cleanupAsked]);
    expect(cleanupRequest(store.current.coordinator[0])?.results).toEqual([cleanupSettled.items[0]]);
  });

  it("keeps processing and the first item received before the first stale pending list", () => {
    const store = new CleanupRequests();
    const token = store.begin();
    applyCleanupEvent(store, { state: "processing", id: cleanupAsked.id, chatKey: cleanupAsked.chatKey, approved: true });
    applyCleanupEvent(store, { state: "item", id: cleanupAsked.id, chatKey: cleanupAsked.chatKey, item: cleanupSettled.items[0] });
    expect(store.current).toEqual({}); // No proposal has arrived yet.
    store.finish(token, [cleanupAsked]);
    expect(cleanupRequest(store.current.coordinator[0])).toEqual({
      ...cleanupAsked, processing: true, approved: true, results: [cleanupSettled.items[0]],
    });
  });

  it.each([false, true])("unions a second early item with the snapshot's first item (appeared=%s)", (appeared) => {
    const store = new CleanupRequests();
    const token = store.begin();
    applyCleanupEvent(store, { state: "item", id: cleanupAsked.id, chatKey: cleanupAsked.chatKey, item: cleanupSettled.items[1] });
    if (appeared) applyCleanupEvent(store, { state: "appeared", id: cleanupAsked.id, request: cleanupAsked });
    store.finish(token, [{ ...cleanupAsked, processing: true, approved: false, results: [cleanupSettled.items[0]] }]);
    expect(cleanupRequest(store.current.coordinator[0])).toEqual({
      ...cleanupAsked, processing: true, approved: false, results: cleanupSettled.items,
    });
  });

  it("merges early progress into an appeared proposal and gives event approval priority", () => {
    const store = new CleanupRequests();
    applyCleanupEvent(store, { state: "processing", id: cleanupAsked.id, chatKey: cleanupAsked.chatKey, approved: false });
    applyCleanupEvent(store, { state: "item", id: cleanupAsked.id, chatKey: cleanupAsked.chatKey, item: cleanupSettled.items[1] });
    applyCleanupEvent(store, { state: "appeared", id: cleanupAsked.id, request: { ...cleanupAsked, processing: true, approved: true, results: [cleanupSettled.items[0]] } });
    expect(cleanupRequest(store.current.coordinator[0])).toEqual({
      ...cleanupAsked, processing: true, approved: false, results: cleanupSettled.items,
    });
    store.finish(store.begin(), [cleanupAsked]);
    expect(cleanupRequest(store.current.coordinator[0])?.approved).toBe(false);
    expect(cleanupRequest(store.current.coordinator[0])?.results).toEqual(cleanupSettled.items);
  });

  it("keeps progress across a failed read and reread, then clears it on a new connection", () => {
    const store = new CleanupRequests();
    const failed = store.begin();
    applyCleanupEvent(store, { state: "processing", id: cleanupAsked.id, chatKey: cleanupAsked.chatKey, approved: false });
    store.cancel(failed);
    store.finish(store.begin(), [cleanupAsked]);
    expect(cleanupRequest(store.current.coordinator[0])?.approved).toBe(false);
    store.resetProgress();
    store.finish(store.begin(), [cleanupAsked]);
    expect(store.current.coordinator).toEqual([cleanupAsked]);
  });

  it("clears early progress on settlement and ignores an obsolete list reply", () => {
    const store = new CleanupRequests();
    const obsolete = store.begin();
    applyCleanupEvent(store, { state: "processing", id: cleanupAsked.id, chatKey: cleanupAsked.chatKey, approved: true });
    applyCleanupEvent(store, { state: "settled", id: cleanupAsked.id, chatKey: cleanupAsked.chatKey, result: cleanupSettled });
    const token = store.begin();
    expect(store.finish(obsolete, [{ ...cleanupAsked, processing: true, results: cleanupSettled.items }])).toBeNull();
    store.finish(token, []);
    store.finish(store.begin(), [cleanupAsked]);
    expect(store.current.coordinator).toEqual([cleanupAsked]);
  });

  it.each([true, false, undefined])("takes the reload list with approved=%s, including legacy hosts without it", (approved) => {
    const store = new CleanupRequests();
    const reloaded = { ...cleanupAsked, processing: true, ...(approved === undefined ? {} : { approved }), results: [cleanupSettled.items[0]] };
    store.finish(store.begin(), [reloaded]);
    expect(cleanupRequest(store.current.coordinator[0])).toEqual(reloaded);
    store.finish(store.begin(), []);
    expect(store.current).toEqual({});
  });

  it("keeps an appeared card over an older snapshot, without duplicating it", () => {
    const store = new CleanupRequests();
    const token = store.begin();
    applyCleanupEvent(store, { state: "appeared", id: cleanupAsked.id, request: cleanupAsked });
    store.finish(token, [cleanupAsked]);
    expect(store.current.coordinator).toEqual([cleanupAsked]);
  });

  it("keeps settled results over a stale pending list and preserves every item title", () => {
    const store = new CleanupRequests();
    store.add(cleanupAsked);
    const token = store.begin();
    const event = { state: "settled" as const, id: cleanupAsked.id, chatKey: cleanupAsked.chatKey, result: cleanupSettled };
    applyCleanupEvent(store, event);
    applyCleanupEvent(store, event); // RPC reply and event are the same receipt.
    store.finish(token, [cleanupAsked]);
    expect(store.current.coordinator).toHaveLength(1);
    expect(cleanupResult(store.current.coordinator[0])).toEqual(cleanupSettled);
    expect(cleanupRequest(store.current.coordinator[0])).toEqual(cleanupAsked);
  });

  it("accepts settlement before the pending list arrives without inventing missing metadata", () => {
    const store = new CleanupRequests();
    const token = store.begin();
    applyCleanupEvent(store, { state: "settled", id: cleanupAsked.id, chatKey: cleanupAsked.chatKey, result: cleanupSettled });
    store.finish(token, [cleanupAsked]);
    expect(cleanupResult(store.current.coordinator[0])).toEqual(cleanupSettled);
    expect(cleanupRequest(store.current.coordinator[0])).toBeUndefined();
  });

  it.each([true, false])("marks processing immediately with approved=%s and keeps it over a stale list", (approved) => {
    const store = new CleanupRequests();
    store.add(cleanupAsked);
    const token = store.begin();
    applyCleanupEvent(store, { state: "processing", id: cleanupAsked.id, chatKey: cleanupAsked.chatKey, approved });
    store.finish(token, [cleanupAsked]);
    expect(store.current.coordinator).toEqual([{ ...cleanupAsked, processing: true, approved, results: [] }]);
  });

  it("merges each completed item by id and retains the newest host reason", () => {
    const store = new CleanupRequests();
    store.add(cleanupAsked);
    const token = store.begin();
    for (const item of cleanupSettled.items) {
      applyCleanupEvent(store, { state: "item", id: cleanupAsked.id, chatKey: cleanupAsked.chatKey, item });
    }
    const updated = { ...cleanupSettled.items[1], reason: "Still held by a task." };
    applyCleanupEvent(store, { state: "item", id: cleanupAsked.id, chatKey: cleanupAsked.chatKey, item: updated });
    // Processing may arrive after its first item, without clearing that item.
    applyCleanupEvent(store, { state: "processing", id: cleanupAsked.id, chatKey: cleanupAsked.chatKey, approved: true });
    store.finish(token, [cleanupAsked]);
    expect(cleanupRequest(store.current.coordinator[0])).toEqual({
      ...cleanupAsked, processing: true, approved: true, results: [cleanupSettled.items[0], updated],
    });
  });

  it("does not let a late appeared event clear ongoing progress", () => {
    const store = new CleanupRequests();
    store.add({ ...cleanupAsked, processing: true, approved: false, results: cleanupSettled.items });
    applyCleanupEvent(store, { state: "appeared", id: cleanupAsked.id, request: cleanupAsked });
    expect(cleanupRequest(store.current.coordinator[0])).toEqual({
      ...cleanupAsked, processing: true, approved: false, results: cleanupSettled.items,
    });
  });

  it("ignores progress and old proposals arriving after settlement", () => {
    const store = new CleanupRequests();
    store.add(cleanupAsked);
    applyCleanupEvent(store, { state: "settled", id: cleanupAsked.id, chatKey: cleanupAsked.chatKey, result: cleanupSettled });
    const settled = store.current;
    const late: CleanupEvent[] = [
      { state: "processing", id: cleanupAsked.id, chatKey: cleanupAsked.chatKey, approved: true },
      { state: "item", id: cleanupAsked.id, chatKey: cleanupAsked.chatKey, item: cleanupSettled.items[0] },
      { state: "appeared", id: cleanupAsked.id, request: cleanupAsked },
    ];
    for (const event of late) expect(applyCleanupEvent(store, event)).toBe(settled);
    expect(cleanupResult(store.current.coordinator[0])).toEqual(cleanupSettled);
  });

  it("ignores an unknown event without changing the store or journaling a receipt", () => {
    const store = new CleanupRequests();
    store.add(cleanupAsked);
    const before = store.current;
    const token = store.begin();
    expect(applyCleanupEvent(store, { state: "future", id: cleanupAsked.id } as unknown as CleanupEvent)).toBe(before);
    store.finish(token, []);
    expect(store.current).toEqual({});
  });

  it("holds progress for an unknown card without inventing its proposal", () => {
    const store = new CleanupRequests();
    const before = store.current;
    expect(applyCleanupEvent(store, { state: "processing", id: cleanupAsked.id, chatKey: cleanupAsked.chatKey, approved: true })).toBe(before);
    expect(applyCleanupEvent(store, { state: "item", id: cleanupAsked.id, chatKey: cleanupAsked.chatKey, item: cleanupSettled.items[0] })).toBe(before);
  });
});
