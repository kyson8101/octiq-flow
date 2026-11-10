import { describe, expect, it } from "vitest";
import { PendingRequests } from "./pendingRequests";
import { applyCleanupEvent, cleanupAsk, cleanupOutcome, cleanupRequest, cleanupResult, type CleanupCard, type CleanupEvent } from "./workspaceCleanup";
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
    expect(cleanupAsk({ ...processing, items: [{ ...cleanupAsked.items[1], worktrees: [] }] })).toBe("Closing 1 mission…");
  });
});

describe("cleanup pending reconciliation", () => {
  it("takes the list on reconnect, including the host's processing state", () => {
    const store = new PendingRequests<CleanupCard>();
    const reloaded = { ...cleanupAsked, processing: true, approved: false, results: [cleanupSettled.items[0]] };
    store.finish(store.begin(), [reloaded]);
    expect(cleanupRequest(store.current.coordinator[0])).toEqual(reloaded);
    store.finish(store.begin(), []);
    expect(store.current).toEqual({});
  });

  it("keeps an appeared card over an older snapshot, without duplicating it", () => {
    const store = new PendingRequests<CleanupCard>();
    const token = store.begin();
    applyCleanupEvent(store, { state: "appeared", id: cleanupAsked.id, request: cleanupAsked });
    store.finish(token, [cleanupAsked]);
    expect(store.current.coordinator).toEqual([cleanupAsked]);
  });

  it("keeps settled results over a stale pending list and preserves every item title", () => {
    const store = new PendingRequests<CleanupCard>();
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
    const store = new PendingRequests<CleanupCard>();
    const token = store.begin();
    applyCleanupEvent(store, { state: "settled", id: cleanupAsked.id, chatKey: cleanupAsked.chatKey, result: cleanupSettled });
    store.finish(token, [cleanupAsked]);
    expect(cleanupResult(store.current.coordinator[0])).toEqual(cleanupSettled);
    expect(cleanupRequest(store.current.coordinator[0])).toBeUndefined();
  });

  it.each([true, false])("marks processing immediately with approved=%s and keeps it over a stale list", (approved) => {
    const store = new PendingRequests<CleanupCard>();
    store.add(cleanupAsked);
    const token = store.begin();
    applyCleanupEvent(store, { state: "processing", id: cleanupAsked.id, chatKey: cleanupAsked.chatKey, approved });
    store.finish(token, [cleanupAsked]);
    expect(store.current.coordinator).toEqual([{ ...cleanupAsked, processing: true, approved }]);
  });

  it("merges each completed item by id and retains the newest host reason", () => {
    const store = new PendingRequests<CleanupCard>();
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
    const store = new PendingRequests<CleanupCard>();
    store.add({ ...cleanupAsked, processing: true, approved: false, results: cleanupSettled.items });
    applyCleanupEvent(store, { state: "appeared", id: cleanupAsked.id, request: cleanupAsked });
    expect(cleanupRequest(store.current.coordinator[0])).toEqual({
      ...cleanupAsked, processing: true, approved: false, results: cleanupSettled.items,
    });
  });

  it("ignores progress and old proposals arriving after settlement", () => {
    const store = new PendingRequests<CleanupCard>();
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
    const store = new PendingRequests<CleanupCard>();
    store.add(cleanupAsked);
    const before = store.current;
    const token = store.begin();
    expect(applyCleanupEvent(store, { state: "future", id: cleanupAsked.id } as unknown as CleanupEvent)).toBe(before);
    store.finish(token, []);
    expect(store.current).toEqual({});
  });

  it("ignores progress for an unknown card without inventing its proposal", () => {
    const store = new PendingRequests<CleanupCard>();
    const before = store.current;
    expect(applyCleanupEvent(store, { state: "processing", id: cleanupAsked.id, chatKey: cleanupAsked.chatKey, approved: true })).toBe(before);
    expect(applyCleanupEvent(store, { state: "item", id: cleanupAsked.id, chatKey: cleanupAsked.chatKey, item: cleanupSettled.items[0] })).toBe(before);
  });
});
