import { describe, expect, it } from "vitest";
import { buildChatTree, type ChatNode } from "./chatTree";
import { EMPTY_ORCHESTRATION, isWorkerChat, mainChatId, workerChatParents } from "./orchestration";
import { byTask, type Conversation } from "./store";

const chat = (id: string, updatedAt = 1, pinned = false): Conversation => ({
  id, title: id, projectId: "project", messages: [], createdAt: 1, updatedAt, pinned,
});
const ids = (nodes: ChatNode[]): string[] => nodes.flatMap((node) => [node.chat.id, ...ids(node.children)]);

describe("orchestrated chat hierarchy", () => {
  it("keeps workers read-only before metadata loads and handles orphaned or cyclic parents", () => {
    expect(isWorkerChat("orch-loading", new Map())).toBe(true);
    expect(isWorkerChat("ordinary", new Map())).toBe(false);
    expect(isWorkerChat(null, new Map())).toBe(false);
    const parents = new Map([["worker", "main"], ["leaf", "worker"]]);
    expect(isWorkerChat("worker", parents)).toBe(true);
    expect(mainChatId("leaf", parents)).toBe("main");
    expect(mainChatId("main", parents)).toBeNull();
    expect(mainChatId("orch-loading", new Map())).toBeNull();
    expect(mainChatId("worker", new Map([["worker", "worker"]]))).toBeNull();
    expect(mainChatId("a", new Map([["a", "b"], ["b", "a"]]))).toBeNull();
  });
  it("keeps workers under their master and moves the group with its latest activity", () => {
    const tree = buildChatTree(byTask([chat("master"), chat("worker", 9), chat("other", 5)]),
      new Map([["worker", "master"]]));
    expect(tree.map((node) => node.chat.id)).toEqual(["master", "other"]);
    expect(tree[0].children.map((node) => node.chat.id)).toEqual(["worker"]);
    expect(ids(tree)).toEqual(["master", "worker", "other"]);
  });

  it("preserves ordinary pin ordering and pins an entire worker group together", () => {
    const chats = [chat("master"), chat("worker", 9), chat("pinned", 2, true), chat("other", 20)];
    const parents = new Map([["worker", "master"]]);
    expect(ids(buildChatTree(byTask(chats), parents))).toEqual(["pinned", "other", "master", "worker"]);
    expect(ids(buildChatTree(byTask(chats.map((c) => c.id === "worker" ? { ...c, pinned: true } : c)), parents)))
      .toEqual(["master", "worker", "pinned", "other"]);
  });

  it("keeps workers accessible when their master is deleted or not loaded", () => {
    expect(ids(buildChatTree([chat("worker"), chat("other")], new Map([["worker", "missing"]]))))
      .toEqual(["worker", "other"]);
  });

  it("supports a worker coordinating its own agents without duplicating descendants", () => {
    const tree = buildChatTree([chat("leaf"), chat("middle"), chat("root")],
      new Map([["leaf", "middle"], ["middle", "root"]]));
    expect(ids(tree)).toEqual(["root", "middle", "leaf"]);
    expect(tree[0].descendants.map((c) => c.id)).toEqual(["middle", "leaf"]);
  });

  it("does not lose chats to self references or cyclic metadata", () => {
    const tree = buildChatTree([chat("a"), chat("b"), chat("c"), chat("self")],
      new Map([["a", "b"], ["b", "c"], ["c", "a"], ["self", "self"]]));
    expect(ids(tree).sort()).toEqual(["a", "b", "c", "self"]);
  });

  it("retains every completed and retried worker from the durable ledger", () => {
    const snapshot = {
      ...EMPTY_ORCHESTRATION,
      runs: [{
        id: "run", objective: "Ship", coordinatorChatKey: "chat:master", workspaceId: "project",
        rootPath: "/repo", status: "completed" as const, maxConcurrent: 2, createdAt: 1, updatedAt: 5,
      }],
      attempts: ["old-worker", "new-worker"].map((id, index) => ({
        id, runId: "run", taskId: "task", number: index + 1, workerChatKey: `chat:${id}`,
        agent: "codex" as const, access: "auto", status: "completed" as const,
        cwd: "/repo", branch: "main", isWorktree: false, filesModified: [], createdAt: 1, updatedAt: 5,
      })),
    };
    expect([...workerChatParents(snapshot)]).toEqual([["old-worker", "master"], ["new-worker", "master"]]);
    expect([...workerChatParents({ ...snapshot, runs: [] })]).toEqual([]);
    expect([...workerChatParents({
      ...snapshot,
      attempts: snapshot.attempts.map((a) => ({ ...a, workerChatKey: "terminal:worker" })),
    })]).toEqual([]);
  });
});
