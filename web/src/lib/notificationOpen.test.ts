import { describe, expect, it, vi } from "vitest";

import type { IndexEntry } from "./chatIndex";
import { resolveNotificationConversation, type NotificationTarget } from "./notificationOpen";
import type { Conversation } from "./store";

const target = (conversationId: string, projectId: string | null): NotificationTarget => ({
  conversationId,
  projectId,
});

const conversation = (id: string, projectId: string): Conversation => ({
  id,
  projectId,
  title: id,
  messages: [],
  createdAt: 1,
  updatedAt: 2,
});

const entry = (id: string, projectId: string): IndexEntry => ({
  id,
  projectId,
  title: id,
  sessionId: null,
  modelId: "codex",
  access: "read",
  createdAt: 1,
  updatedAt: 2,
  pinned: false,
});

describe("resolveNotificationConversation", () => {
  it("opens a loaded chat in another project without consulting sidebar visibility", async () => {
    const wanted = conversation("chat-2", "project-2");
    const lookup = vi.fn(async () => []);

    await expect(
      resolveNotificationConversation(target("chat-2", "project-2"), [conversation("chat-1", "project-1"), wanted], lookup),
    ).resolves.toBe(wanted);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("resolves an unloaded General coordinator from the authoritative index", async () => {
    const lookup = vi.fn(async () => [entry("lead", "general")]);

    await expect(resolveNotificationConversation(target("lead", "general"), [], lookup)).resolves.toMatchObject({
      id: "lead",
      projectId: "general",
      messages: [],
      synced: true,
    });
    expect(lookup).toHaveBeenCalledOnce();
  });

  it("resolves a worker chat even when it is filtered out of the visible list", async () => {
    const lookup = vi.fn(async () => [entry("worker", "destination")]);

    await expect(resolveNotificationConversation(target("worker", "destination"), [], lookup)).resolves.toMatchObject({
      id: "worker",
      projectId: "destination",
    });
  });

  it("trusts the authoritative project when a stale notice carries another one", async () => {
    const lookup = vi.fn(async () => [entry("moved", "project-now")]);

    await expect(resolveNotificationConversation(target("moved", "project-before"), [], lookup)).resolves.toMatchObject({
      id: "moved",
      projectId: "project-now",
    });
  });

  it("reports a chat unavailable only after an authoritative lookup misses it", async () => {
    const lookup = vi.fn(async () => [entry("someone-else", "general")]);

    await expect(resolveNotificationConversation(target("missing", null), [], lookup)).resolves.toBeNull();
    expect(lookup).toHaveBeenCalledOnce();
  });
});
