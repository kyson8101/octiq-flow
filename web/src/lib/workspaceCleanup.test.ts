import { describe, expect, it } from "vitest";
import { PendingRequests } from "./pendingRequests";
import { applyCleanupEvent, cleanupAsk, cleanupOutcome, cleanupRequest, cleanupResult, type CleanupCard } from "./workspaceCleanup";
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
});

describe("cleanup pending reconciliation", () => {
  it("takes the list on reconnect, including the host's processing state", () => {
    const store = new PendingRequests<CleanupCard>();
    store.finish(store.begin(), [{ ...cleanupAsked, processing: true }]);
    expect(cleanupRequest(store.current.coordinator[0])?.processing).toBe(true);
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
});
