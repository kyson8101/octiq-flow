// Getting a chat into the server's index — and, just as much, getting one OUT.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bridge } from "./bridge";
import {
  type IndexEntry,
  indexBacklog,
  removeIndexEntry,
  resetIndexQueue,
  saveIndexEntry,
} from "./chatIndex";

// The real one opens a socket the moment it is imported.
vi.mock("./bridge", () => ({ bridge: { invoke: vi.fn(), onState: vi.fn() } }));

const invoke = vi.mocked(bridge.invoke);

const entry = (id: string): IndexEntry => ({
  id,
  projectId: "p1",
  title: "a chat",
  sessionId: null,
  modelId: null,
  access: null,
  createdAt: 1,
  updatedAt: 2,
  pinned: false,
});

/** A call the server never answers — a socket that closed with it in flight. */
const unanswered = () => new Promise<never>(() => {});

beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockReset();
  resetIndexQueue();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("removing a chat from the index", () => {
  it("sends the removal, and stops once the server has answered", async () => {
    invoke.mockResolvedValue(undefined);
    removeIndexEntry("c1", "chat:c1");
    await vi.advanceTimersByTimeAsync(0);

    expect(invoke).toHaveBeenCalledWith("chat_index_remove", { id: "c1", key: "chat:c1" });
    expect(indexBacklog()).toBe(0);
  });

  it("keeps trying when the call is never answered", async () => {
    invoke.mockReturnValue(unanswered());
    removeIndexEntry("c1", "chat:c1");
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledTimes(1);

    // The deadline passes with no reply, so it is treated as lost and sent
    // again — the delete is not allowed to quietly not happen.
    await vi.advanceTimersByTimeAsync(20_000);

    expect(invoke.mock.calls.length).toBeGreaterThan(1);
    expect(indexBacklog()).toBe(1);
  });

  it("does not pile up when the same chat is asked about again and again", async () => {
    invoke.mockReturnValue(unanswered());
    removeIndexEntry("c1", "chat:c1");
    await vi.advanceTimersByTimeAsync(0);
    invoke.mockClear();

    // Every reconnection re-reads the index and finds the chat still listed.
    removeIndexEntry("c1", "chat:c1");
    removeIndexEntry("c1", "chat:c1");
    await vi.advanceTimersByTimeAsync(0);

    expect(invoke).not.toHaveBeenCalled();
    expect(indexBacklog()).toBe(1);
  });

  it("beats a save of the same chat that has not landed yet", async () => {
    invoke.mockReturnValue(unanswered());
    saveIndexEntry(entry("c1"));
    await vi.advanceTimersByTimeAsync(0);
    removeIndexEntry("c1", "chat:c1");
    await vi.advanceTimersByTimeAsync(0);

    expect(indexBacklog()).toBe(1);
    // Whatever is retried from here on is the removal, never the save that was
    // queued behind it — that save is what used to put the chat back.
    invoke.mockClear();
    await vi.advanceTimersByTimeAsync(20_000);
    for (const call of invoke.mock.calls) expect(call[0]).toBe("chat_index_remove");
  });

  it("refuses to write a chat back once its removal is queued", async () => {
    invoke.mockReturnValue(unanswered());
    removeIndexEntry("c1", "chat:c1");
    await vi.advanceTimersByTimeAsync(0);
    invoke.mockClear();

    saveIndexEntry(entry("c1"));
    await vi.advanceTimersByTimeAsync(0);

    for (const call of invoke.mock.calls) expect(call[0]).toBe("chat_index_remove");
    expect(indexBacklog()).toBe(1);
  });
});
