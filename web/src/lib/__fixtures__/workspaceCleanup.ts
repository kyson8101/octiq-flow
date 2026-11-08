import type { CleanupAsked, CleanupSettled } from "../workspaceCleanup";

export const cleanupAsked: CleanupAsked = {
  id: "batch-1", chatKey: "chat:coordinator", runIds: ["run-1"], processing: false,
  items: [{ id: "task-1", kind: "task-worktree", title: "Finish the client", taskId: "t1", runId: "run-1",
    worktrees: [{ branch: "feature/client", path: "/repos/client", headCommit: "1234567890abcdef", baseBranch: "develop", ignoredFileCount: 0 }] },
  { id: "mission-1", kind: "mission", title: "Finish the mission", runId: "run-1", worktrees: [
    { branch: "feature/mission", path: "/repos/mission", headCommit: "abcdef1234567890", baseBranch: "develop", ignoredFileCount: null },
    { branch: "feature/second-root", path: "/repos/second-root", headCommit: "full-merged-head", baseBranch: "develop", ignoredFileCount: 2 },
  ] }],
};
export const cleanupSettled: CleanupSettled = { id: "batch-1", approved: true, items: [
  { id: "task-1", status: "removed", reason: "The merged worktree was removed." },
  { id: "mission-1", status: "kept", reason: "A task still holds this mission. All folders remain." },
] };
