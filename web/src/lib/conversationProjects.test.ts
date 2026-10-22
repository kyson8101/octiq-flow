import { describe, expect, it } from "vitest";
import type { OrchestrationRun, OrchestrationSnapshot, OrchestrationTask } from "./orchestration";
import {
  conversationColorProjectId, conversationProjectInfo, conversationProjectSummary, crossProjectChatKeys, projectConversationCounts,
  projectConversations,
} from "./conversationProjects";
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
  const projects = [{ id: "alpha", name: "Current Alpha" }, { id: "beta", name: "Beta" }];

  it("attributes tasks without destinations to their run's known project", () => {
    const ledger = snapshot([{ ...run("one"), workspaceId: "alpha", rootPath: "/work/alpha" }],
      [task("first", "one"), task("second", "one")]);
    const info = conversationProjectInfo(chat("cto", "beta"), ledger, new Set(), false, projects);
    expect(info).toEqual({
      status: "projects",
      destinations: [{ projectId: "alpha", projectName: "Current Alpha", repository: "/work/alpha" }],
      taskCount: 2,
      unknownTaskCount: 0,
    });
    expect(conversationColorProjectId(info, (id) => projects.some((project) => project.id === id))).toBe("alpha");
    expect(conversationProjectSummary(info, (id) => projects.find((project) => project.id === id)!.name))
      .toBe("Current Alpha, 2 tasks");
  });

  it("combines the run project and a cross-project destination without double counting", () => {
    const ledger = snapshot([{ ...run("one"), workspaceId: "alpha", rootPath: "/work/alpha" }],
      [task("first", "one"), task("second", "one"), task("cross", "one", "beta", 2)]);
    const info = conversationProjectInfo(chat("cto"), ledger, new Set(), false, projects);
    expect(info).toEqual({
      status: "projects",
      destinations: [
        { projectId: "beta", projectName: "BETA", repository: "/work/beta" },
        { projectId: "alpha", projectName: "Current Alpha", repository: "/work/alpha" },
      ],
      taskCount: 3,
      unknownTaskCount: 0,
    });
    expect(conversationColorProjectId(info, () => true)).toBeNull();
    expect(Object.fromEntries(projectConversationCounts([chat("cto")], ledger, new Set(), projects)))
      .toEqual({ beta: 1, alpha: 1 });
    expect(projectConversations([chat("cto")], "alpha", ledger, new Set(), projects).map((item) => item.id))
      .toEqual(["cto"]);
  });

  it.each(["", "removed"])("uses the chat's known project when the run project is %j", (workspaceId) => {
    const ledger = snapshot([{ ...run("one"), workspaceId }], [task("local", "one")]);
    expect(conversationProjectInfo(chat("cto", "alpha"), ledger, new Set(), false, projects)).toMatchObject({
      status: "projects", destinations: [{ projectId: "alpha", projectName: "Current Alpha" }],
      taskCount: 1, unknownTaskCount: 0,
    });
  });

  it("resolves each run separately and counts only tasks with no known project as unknown", () => {
    const ledger = snapshot(
      [{ ...run("one"), workspaceId: "alpha" }, { ...run("two"), workspaceId: "removed" }],
      [task("local", "one"), task("unknown", "two"), task("also-unknown", "two")],
    );
    expect(conversationProjectInfo(chat("cto"), ledger, new Set(), false, projects)).toMatchObject({
      status: "projects", destinations: [{ projectId: "alpha" }], taskCount: 3, unknownTaskCount: 2,
    });
    const unknown = conversationProjectInfo(chat("cto"), ledger, new Set(), false, [{ id: "other", name: "Other" }]);
    expect(unknown).toEqual({ status: "unknown", destinations: [], taskCount: 3, unknownTaskCount: 3 });
    expect(conversationProjectSummary(unknown, () => "Unused")).toBe("work project unknown");
  });

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

describe("crossProjectChatKeys", () => {
  const lead = (chatKey: string, leadId: string, crossProject?: boolean) => ({ chatKey, leadId, crossProject });

  it("counts only the head's cross-project conversations as coordinators", () => {
    const leads = [
      lead("chat:cto", "head", true),
      lead("chat:old-cto", "head"),
      lead("chat:routed", "dev"),
      lead("chat:past-head", "former-head", true),
    ];
    expect([...crossProjectChatKeys(leads, "head")]).toEqual(["chat:cto", "chat:old-cto", "chat:past-head"]);
    expect([...crossProjectChatKeys(leads, null)]).toEqual(["chat:cto", "chat:past-head"]);
  });

  it("keeps a project agent's chat with no runs in its own project, not a discussion", () => {
    const coordinators = crossProjectChatKeys([lead("chat:cto", "head", true), lead("chat:routed", "dev")], "head");
    expect(conversationProjectInfo(chat("routed", "octiq-flow"), snapshot([], []), coordinators)).toMatchObject({
      status: "home", homeProjectId: "octiq-flow",
    });
    expect(conversationProjectInfo(chat("cto"), snapshot([], []), coordinators).status).toBe("discussion");
    // Once it hands out tasks, its runs make it a coordinator either way.
    expect(conversationProjectInfo(chat("routed", "octiq-flow"), snapshot([run("r", "routed")], [task("t", "r", "beta")]), coordinators))
      .toMatchObject({ status: "projects", destinations: [{ projectId: "beta" }] });
  });
});

describe("conversationColorProjectId", () => {
  const registered = (id: string) => ["general", "alpha", "beta"].includes(id);
  const coordinators = new Set(["chat:cto"]);
  const colourOf = (tasks: OrchestrationTask[], ledger: OrchestrationSnapshot | null = snapshot([run("r")], tasks)) =>
    conversationColorProjectId(conversationProjectInfo(chat("cto"), ledger, coordinators), registered);

  it("takes a coordinator's one work project, never its General home", () => {
    expect(colourOf([task("t1", "r", "alpha"), task("t2", "r", "alpha")])).toBe("alpha");
    // A task with no recorded destination is shown as "+?", not a reason to drop the known one.
    expect(colourOf([task("t1", "r", "alpha"), task("t2", "r")])).toBe("alpha");
  });

  it("stays neutral across several projects and while the destination is not known", () => {
    expect(colourOf([task("t1", "r", "alpha"), task("t2", "r", "beta")])).toBeNull();
    expect(colourOf([task("t1", "r")])).toBeNull();
    expect(colourOf([], snapshot([run("r")], []))).toBeNull();
    expect(colourOf([], null)).toBeNull();
    expect(colourOf([task("t1", "r", "removed")])).toBeNull();
  });

  it("keeps an ordinary chat's own registered project", () => {
    const info = conversationProjectInfo(chat("plain", "beta"), snapshot([], []), coordinators);
    expect(conversationColorProjectId(info, registered)).toBe("beta");
    const gone = conversationProjectInfo(chat("plain", "removed"), snapshot([], []), coordinators);
    expect(conversationColorProjectId(gone, registered)).toBeNull();
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

  it("maps a restored index row by its stable chat id without copying its history", () => {
    const restored = chat("cto", "general", { pinned: true, customTitle: true, messages: [{ id: "kept", role: "assistant", streaming: false, blocks: [{ kind: "text", text: "History stays here" }] }] });
    const found = projectConversations([restored], "alpha", ledger, new Set(["chat:cto"]));
    expect(found).toHaveLength(1);
    expect(found[0]).toBe(restored);
    expect(found[0].messages[0].id).toBe("kept");
  });
});
