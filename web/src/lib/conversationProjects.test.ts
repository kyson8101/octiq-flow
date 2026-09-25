import { describe, expect, it } from "vitest";
import type { OrchestrationRun, OrchestrationSnapshot, OrchestrationTask } from "./orchestration";
import { conversationProjectInfo, projectConversationCounts, projectConversations } from "./conversationProjects";
import type { Conversation } from "./store";

const chat = (id: string, projectId = "general", extra: Partial<Conversation> = {}): Conversation => ({
  id, projectId, title: id, messages: [], createdAt: 1, updatedAt: 1, ...extra,
});

const run = (id: string, coordinator = "cto", createdAt = 1): OrchestrationRun => ({
  id, coordinatorChatKey: `chat:${coordinator}`, objective: id, workspaceId: "general",
  rootPath: "/work/General", status: "completed", maxConcurrent: 2, createdAt, updatedAt: createdAt,
});

const task = (
  id: string,
  runId: string,
  projectId?: string,
  updatedAt = 1,
): OrchestrationTask => ({
  id, runId, title: id, spec: id, dependsOn: [], status: "completed", createdAt: 1, updatedAt,
  destination: projectId ? { projectId, projectName: projectId.toUpperCase(), repository: `/work/${projectId}` } : undefined,
});

const snapshot = (runs: OrchestrationRun[], tasks: OrchestrationTask[]): OrchestrationSnapshot => ({
  runs, tasks, attempts: [], gates: [], messages: [],
});

describe("conversationProjectInfo", () => {
  it("collects unique task destinations across every run, including completed work", () => {
    const ledger = snapshot(
      [run("older", "cto", 1), run("newer", "cto", 2), run("other", "someone-else", 3)],
      [
        task("first", "older", "alpha", 2),
        task("repeat", "newer", "alpha", 4),
        task("second", "newer", "beta", 3),
        task("not-ours", "other", "gamma", 9),
      ],
    );

    expect(conversationProjectInfo(chat("cto"), ledger, new Set())).toEqual({
      status: "projects",
      destinations: [
        { projectId: "alpha", projectName: "ALPHA", repository: "/work/alpha" },
        { projectId: "beta", projectName: "BETA", repository: "/work/beta" },
      ],
      taskCount: 3,
      unknownTaskCount: 0,
    });
  });

  it("keeps known projects while saying that another task destination is unknown", () => {
    const ledger = snapshot([run("one")], [task("known", "one", "alpha"), task("unknown", "one")]);
    expect(conversationProjectInfo(chat("cto"), ledger, new Set())).toEqual({
      status: "projects",
      destinations: [{ projectId: "alpha", projectName: "ALPHA", repository: "/work/alpha" }],
      taskCount: 2,
      unknownTaskCount: 1,
    });
  });

  it("distinguishes discussion, unknown destination, ledger loading, and an ordinary chat", () => {
    const coordinators = new Set(["chat:cto"]);
    expect(conversationProjectInfo(chat("cto"), snapshot([], []), coordinators).status).toBe("discussion");
    expect(conversationProjectInfo(chat("cto"), snapshot([run("one")], [task("unknown", "one")]), coordinators).status).toBe("unknown");
    expect(conversationProjectInfo(chat("cto"), null, coordinators).status).toBe("loading");
    expect(conversationProjectInfo(chat("cto"), null, coordinators, true).status).toBe("unknown");
    expect(conversationProjectInfo(chat("plain", "alpha"), null, coordinators)).toMatchObject({
      status: "home", homeProjectId: "alpha",
    });
    expect(conversationProjectInfo(chat("plain", "alpha"), null, null).status).toBe("loading");
    expect(conversationProjectInfo(chat("plain", "alpha"), snapshot([], []), coordinators)).toMatchObject({
      status: "home", homeProjectId: "alpha", taskCount: 0,
    });
  });
});

describe("project conversation discovery", () => {
  const conversations = [
    chat("cto", "general", { updatedAt: 2, pinned: true }),
    chat("plain", "alpha", { updatedAt: 3 }),
    chat("other", "beta", { updatedAt: 4 }),
  ];
  const ledger = snapshot(
    [run("old"), run("done", "cto", 2)],
    [task("alpha-task", "old", "alpha"), task("beta-task", "done", "beta")],
  );

  it("finds the same canonical coordinator chat through each task destination", () => {
    const coordinators = new Set(["chat:cto"]);
    expect(projectConversations(conversations, "alpha", ledger, coordinators).map((item) => item.id))
      .toEqual(["plain", "cto"]);
    expect(projectConversations(conversations, "beta", ledger, coordinators).map((item) => item.id))
      .toEqual(["other", "cto"]);
    expect(projectConversations(conversations, "general", ledger, coordinators)).toEqual([]);
  });

  it("counts one canonical conversation per linked project without changing pin state", () => {
    const counts = projectConversationCounts(conversations, ledger, new Set(["chat:cto"]));
    expect(Object.fromEntries(counts)).toEqual({ alpha: 2, beta: 2 });
    expect(conversations[0].pinned).toBe(true);
  });
});
