import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/bridge", () => ({
  bridge: {
    invoke: async () => null,
    on: () => () => {},
    onState: () => () => {},
  },
}));

import { OrchestrationPanel, type OrchestrationSnapshot } from "./OrchestrationPanel";

const snapshot: OrchestrationSnapshot = {
  runs: [{
    id: "run_1",
    objective: "Ship orchestration",
    coordinatorChatKey: "chat:master",
    workspaceId: "project",
    rootPath: "/repo",
    status: "waiting",
    maxConcurrent: 4,
    createdAt: 1,
    updatedAt: 2,
  }],
  tasks: [{
    id: "task_1",
    runId: "run_1",
    title: "Build the host ledger",
    spec: "Persist authoritative worker state.",
    dependsOn: [],
    status: "blocked",
    activeAttemptId: "attempt_1",
    createdAt: 1,
    updatedAt: 2,
  }],
  attempts: [{
    id: "attempt_1",
    runId: "run_1",
    taskId: "task_1",
    number: 1,
    workerChatKey: "chat:worker",
    agent: "codex",
    access: "auto",
    status: "blocked",
    cwd: "/worktree",
    branch: "feature/worker",
    isWorktree: true,
    filesModified: [],
    createdAt: 1,
    updatedAt: 2,
  }],
  gates: [{
    id: "gate_1",
    runId: "run_1",
    taskId: "task_1",
    createdByChatKey: "chat:worker",
    targetChatKey: "chat:master",
    question: "Use the durable schema?",
    options: ["Yes", "No"],
    status: "open",
    createdAt: 1,
    updatedAt: 2,
  }],
  messages: [],
};

describe("OrchestrationPanel", () => {
  it("starts a master from the current chat", () => {
    const html = renderToStaticMarkup(
      <OrchestrationPanel
        project={{ id: "project", name: "OctiqFlow", primary_path: "/repo" }}
        coordinatorKey="chat:master"
        onOpenChat={() => {}}
        onClose={() => {}}
      />,
    );

    expect(html).toContain("Start master run");
    expect(html).toContain("This chat becomes the master.");
    expect(html).toContain('aria-modal="true"');
  });

  it("shows authoritative task state and decisions", () => {
    const html = renderToStaticMarkup(
      <OrchestrationPanel
        project={{ id: "project", name: "OctiqFlow", primary_path: "/repo" }}
        coordinatorKey="chat:master"
        initialSnapshot={snapshot}
        onOpenChat={() => {}}
        onClose={() => {}}
      />,
    );

    expect(html).toContain("Execution ledger");
    expect(html).toContain("Build the host ledger");
    expect(html).toContain("Use the durable schema?");
    expect(html).toContain("codex worker #1");
    expect(html).toContain("feature/worker");
  });
});
