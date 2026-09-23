import { EMPTY_ORCHESTRATION, type OrchestrationSnapshot } from "../orchestration";

export const mergedWorkers = (): OrchestrationSnapshot => ({
  ...EMPTY_ORCHESTRATION,
  runs: [{ id: "run", objective: "Ship", coordinatorChatKey: "chat:main", workspaceId: "project", rootPath: "/repo", status: "completed", maxConcurrent: 2, createdAt: 1, updatedAt: 2 }],
  tasks: [{ id: "task", runId: "run", title: "Merged task", spec: "Implement", dependsOn: [], status: "completed", activeAttemptId: "worker", createdAt: 1, updatedAt: 2,
    workspace: { plan: { mode: "direct", cwd: "/repo", checkoutRoot: "/repo", repositoryRoot: "/repo", branch: "develop", baseBranch: "develop", baseSha: "base", managed: false, isRepo: true, warnings: [], initialStatus: "" }, state: "retained", abandoned: false, validationPaths: [],
      delivery: { headSha: "merged", dirty: false, hasCommits: true, pushed: true, merged: true, checkedAt: 2, notes: [] } } }],
  attempts: [1, 2].map((number) => ({ id: number === 1 ? "previous" : "worker", workerChatKey: number === 1 ? "chat:previous" : "chat:worker", runId: "run", taskId: "task", number, agent: "codex", access: "auto", status: number === 1 ? "failed" : "completed", cwd: "/repo", branch: "develop", isWorktree: false, filesModified: [], createdAt: 1, updatedAt: 2 })),
});
