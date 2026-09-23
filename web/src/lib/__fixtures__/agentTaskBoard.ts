import type { OrchestrationSnapshot } from "../orchestration";

/** Synthetic ledger for task-board rendering; no agent transcript is fabricated. */
export function taskBoardFixture(now = 1_000_000): OrchestrationSnapshot {
  const createdAt = now - 600_000;
  return {
    runs: [{ id: "run", objective: "Make agent work easier to follow", coordinatorChatKey: "chat:main", workspaceId: "project", rootPath: "/projects/octiq-flow", status: "running", maxConcurrent: 3, createdAt, updatedAt: now }],
    tasks: [
      { id: "auth", runId: "run", title: "Lightweight auth checks", spec: "Implement the auth checks and verify the request paths.", dependsOn: [], status: "completed", activeAttemptId: "a-auth", createdAt, updatedAt: now - 120_000 },
      { id: "reader", runId: "run", title: "Reader access checks", spec: "Add reader access checks. Cover allowed and denied requests, then run the focused tests.", dependsOn: [], status: "running", activeAttemptId: "a-reader", createdAt, updatedAt: now - 60_000 },
      { id: "export", runId: "run", title: "Training export controls", spec: "Confirm the export format with the main agent before implementing the change.", dependsOn: [], status: "blocked", activeAttemptId: "a-export", createdAt, updatedAt: now - 180_000 },
      { id: "docs", runId: "run", title: "Document the access rules", spec: "Document the completed access rules and examples.", dependsOn: ["reader"], status: "pending", createdAt, updatedAt: createdAt },
    ],
    attempts: [
      { id: "a-auth", runId: "run", taskId: "auth", number: 1, workerChatKey: "chat:w-auth", agent: "codex", model: "gpt-5.6-sol", access: "auto", status: "completed", cwd: "/projects/.worktrees/lightweight-auth", branch: "task/lightweight-auth", isWorktree: true, filesModified: [], createdAt, updatedAt: now - 120_000 },
      { id: "a-reader", runId: "run", taskId: "reader", number: 1, workerChatKey: "chat:w-reader", agent: "codex", model: "gpt-5.6-sol", access: "auto", status: "running", cwd: "/projects/.worktrees/reader-access", branch: "task/reader-access", isWorktree: true, filesModified: [], createdAt: now - 360_000, updatedAt: now - 60_000 },
      { id: "a-export", runId: "run", taskId: "export", number: 1, workerChatKey: "chat:w-export", agent: "codex", model: "gpt-5.6-sol", access: "auto", status: "blocked", cwd: "/projects/octiq-flow", branch: "develop", isWorktree: false, filesModified: [], createdAt: now - 420_000, updatedAt: now - 180_000 },
    ],
    reports: { "chat:w-reader": { objective: "Reader access checks", nextStep: "Verify denied requests", steps: [{ title: "Inspect request paths", state: "done" }, { title: "Implement access checks", state: "done" }, { title: "Run focused tests", state: "active" }, { title: "Review the change", state: "pending" }], reportedAt: now - 20_000, reportedBy: "codex" } },
    gates: [{ id: "gate", runId: "run", taskId: "export", createdByChatKey: "chat:w-export", targetChatKey: "chat:main", question: "Which export format should this task support?", options: [], status: "open", createdAt: now - 180_000, updatedAt: now - 180_000 }],
    messages: [],
  };
}
