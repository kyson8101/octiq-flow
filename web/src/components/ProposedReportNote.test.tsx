import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProposedReportNote } from "./ProposedReportNote";
import { taskStateLabel } from "../lib/agentTaskBoard";
import type { OrchestrationAttempt, OrchestrationTask } from "../lib/orchestration";

const attempt = (over: Partial<OrchestrationAttempt> = {}) => ({
  id: "attempt_1", runId: "r1", taskId: "t1", number: 2, workerChatKey: "chat:orch-w",
  agent: "codex", access: "read", status: "running", cwd: "", branch: "", isWorktree: false,
  filesModified: [], createdAt: 1, updatedAt: 1,
  execution: { state: "awaiting_report" },
  proposedReport: { id: "proposal_abc", text: "README says hello. Verdict: pass.", capturedAt: 10 },
  ...over,
}) as OrchestrationAttempt;

const task = { id: "t1", runId: "r1", title: "Review", spec: "", dependsOn: [], status: "running",
  kind: "review", activeAttemptId: "attempt_1", createdAt: 1, updatedAt: 1 } as unknown as OrchestrationTask;

const draw = (a: OrchestrationAttempt) => renderToStaticMarkup(<ProposedReportNote attempt={a} ago={() => "just now"} />);

describe("a read-only worker's proposed report (e15fabde)", () => {
  it("names the exact attempt and says nothing is settled yet, words behind a disclosure", () => {
    const html = draw(attempt());
    expect(html).toContain("closing words of codex worker #2 (read-only)");
    expect(html).toContain("Not settled until the coordinator confirms it");
    expect(html).toContain('data-proposal="proposal_abc"');
    expect(html).toMatch(/<details>.*README says hello/);
    expect(taskStateLabel(task, attempt())).toBe("Report proposed · coordinator to confirm");
  });

  it("reads as settled only once the coordinator confirmed it, and never infers a verdict", () => {
    const confirmed = attempt({ status: "completed", proposedReport: { id: "proposal_abc", text: "x", capturedAt: 10, confirmedAt: 20, confirmedBy: "chat:master" } });
    expect(draw(confirmed)).toContain("confirmed by the coordinator");
    // A completed review without a verdict is still "no verdict".
    expect(taskStateLabel({ ...task, status: "completed" }, confirmed)).toBe("Done · no verdict");
  });

  it("draws nothing for an attempt that reported for itself", () => {
    expect(draw(attempt({ proposedReport: null }))).toBe("");
  });
});
