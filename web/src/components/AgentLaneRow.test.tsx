import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [], on: () => () => {}, onState: () => () => {} } }));
import { AgentLaneRow } from "./AgentsDashboard";
import { batchLine } from "./OrchestrationPanel";
import type { OrchestrationSnapshot } from "../lib/orchestration";
const snapshot: OrchestrationSnapshot = {
  runs: [{ id: "r", objective: "Bound the machine's worker count", coordinatorChatKey: "chat:c", workspaceId: "p", rootPath: "/repo", status: "running", maxConcurrent: 2, createdAt: 1, updatedAt: 1 }],
  tasks: [], gates: [], messages: [],
  attempts: [{ id: "a", runId: "r", taskId: "t", number: 1, workerChatKey: "chat:w", agent: "codex", access: "auto", status: "running", batchId: "b",
    cwd: "/w", branch: "feature/batch", isWorktree: true, filesModified: [], createdAt: 1, updatedAt: 1, execution: { state: "executing", retryCount: 0, lastActivityAt: 1 } }],
  batches: [{ id: "b", agentId: "fe", runId: "r", repository: "/repo", baseBranch: "develop", branch: "feature/batch", worktree: "/w", taskIds: ["t", "u"], status: "working", createdAt: 1 }],
};
const lane = { agentId: "fe", state: "working" as const, queued: 3, batch: { id: "b", runId: "r", branch: "feature/batch", taskIds: ["t", "u"] } };
it("names the working batch and queue, folding its branch", () => {
  const html = renderToStaticMarkup(<AgentLaneRow lane={lane} snapshot={snapshot} />);
  expect(html).toContain("Working · batch of 2 tasks"); expect(html).toContain("3 queued");
  expect(html).toContain('data-executing="true"');
  expect(html).toMatch(/<details><summary>Batch details<\/summary>.*feature\/batch<\/p><\/details>/);
  expect(html).toContain("Bound the machine&#x27;s worker count");
});
it("uses no execution accent for a waiting, idle or stale lane", () => {
  for (const props of [{ snapshot: { ...snapshot, attempts: [] } }, { snapshot: { ...snapshot, attempts: snapshot.attempts.map(attempt => ({ ...attempt, status: "completed" as const })) } }, { stale: true }, { lane: { ...lane, state: "idle" as const } }]) {
    expect(renderToStaticMarkup(<AgentLaneRow lane={lane} snapshot={snapshot} {...props} />)).not.toContain('data-executing="true"');
  }
});
it("puts a blocked reason directly on the row", () => {
  const html = renderToStaticMarkup(<AgentLaneRow lane={{ agentId: "fe", state: "blocked", queued: 2, blockedReason: "Restore the repository folder." }} snapshot={snapshot} />);
  expect(html).toContain('data-state="blocked"'); expect(html).toContain("<p>Restore the repository folder.</p>");
});
it("reads the batch detail from the ledger without inventing missing counts", () => {
  expect(batchLine(snapshot, snapshot.attempts[0])).toBe("Batch · 2 tasks · feature/batch");
  expect(batchLine({}, snapshot.attempts[0])).toBe("Batch · — tasks · feature/batch");
});
