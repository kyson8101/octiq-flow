// A handover record as the host sends it, for tests.
import type { Handover } from "./handover";

export const handover = (extra: Partial<Handover> = {}): Handover => ({
  id: "handover_1",
  sourceChatKey: "chat:source",
  sourceTitle: "Fix the login bug",
  sourceProject: "App",
  from: { agentId: "agent_potato", name: "Potato" },
  to: { agentId: "agent_mango", name: "Mango" },
  settings: { agent: "claude", model: "sonnet", effort: "high", access: "edits" },
  destination: { projectId: "p-app", projectName: "App", repository: "/src/app" },
  workspace: { mode: "continue", path: "/src/.worktrees/app/fix-login", branch: "fix/login", head: "abc1234", uncommitted: true, chosen: "source" },
  brief: { objective: "Finish the login fix", authorized: ["commit on the task branch"], notAuthorized: ["push"] },
  status: "pending",
  createdAt: 10,
  notice: "pending",
  ...extra,
});
