import { describe, expect, it } from "vitest";
import { workerArchiveChatList, workerArchiveDisabledReason } from "./workerArchive";
import { workflowChatList } from "./chatWorkflow";
import { mergedWorkers } from "./__fixtures__/workerArchive";
import type { Conversation } from "./store";

const chat = (id: string): Conversation => ({ id, title: id, projectId: "project", messages: [], createdAt: 1, updatedAt: 2 });

describe("worker archive navigation", () => {
  it("hides selected, pinned and orphaned archived chats without deleting them", () => {
    const snapshot = mergedWorkers();
    snapshot.attempts.forEach((attempt) => { attempt.archivedAt = 3; });
    const chats = [chat("main"), chat("previous"), { ...chat("worker"), pinned: true }, chat("ordinary")];
    expect(workflowChatList(chats, snapshot, "worker").map(c => c.id)).toEqual(["main", "ordinary"]);
    expect(workerArchiveChatList(chats, snapshot, true).map(c => c.id)).toEqual(["previous", "worker"]);
    expect(workerArchiveChatList(chats.slice(1), snapshot).map(c => c.id)).toEqual(["ordinary"]);
    expect(chats).toHaveLength(4);
    // Restore remains scoped to the chosen attempt; opening history alone does not restore it.
    snapshot.attempts[1].archivedAt = null;
    expect(workflowChatList(chats, snapshot, null).map(c => c.id)).toEqual(["main", "worker", "ordinary"]);
    expect(workerArchiveChatList(chats, snapshot, true).map(c => c.id)).toEqual(["previous"]);
  });

  it("requires recorded merge evidence, not just completion or a push", () => {
    const snapshot = mergedWorkers();
    expect(workerArchiveDisabledReason(snapshot, snapshot.attempts[0])).toBeNull();
    const workspace = snapshot.tasks[0].workspace!;
    workspace.state = "cleaned";
    expect(workerArchiveDisabledReason(snapshot, snapshot.attempts[1])).toBeNull();
    workspace.delivery!.merged = false;
    expect(workerArchiveDisabledReason(snapshot, snapshot.attempts[1])).toContain("verify");
    workspace.delivery!.merged = true;
    workspace.delivery!.dirty = true;
    expect(workerArchiveDisabledReason(snapshot, snapshot.attempts[1])).toContain("clean");
    workspace.delivery = null;
    expect(workerArchiveDisabledReason(snapshot, snapshot.attempts[1])).not.toBeNull();
  });

  it("keeps live workers and open decisions visible, including during retry", () => {
    const snapshot = mergedWorkers();
    snapshot.attempts[1].status = "running";
    expect(workerArchiveDisabledReason(snapshot, snapshot.attempts[0])).toContain("settle");
    snapshot.attempts[1].status = "completed";
    snapshot.gates = [{ id: "gate", runId: "run", createdByChatKey: "chat:main", targetChatKey: "chat:main", question: "Choose", options: [], status: "open", createdAt: 1, updatedAt: 1 }];
    expect(workerArchiveDisabledReason(snapshot, snapshot.attempts[0])).toContain("decision");
    snapshot.gates[0].status = "resolved";
    snapshot.tasks[0].status = "ready";
    expect(workerArchiveDisabledReason(snapshot, snapshot.attempts[0])).toContain("Complete");
  });
});
