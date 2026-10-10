import { describe, expect, it } from "vitest";
import { feedbackBrief, feedbackUpdatedBy, type FeedbackReport } from "./feedback";

const report: FeedbackReport = {
  id: "report-one", requestId: "r1", title: "Queue stalls", kind: "bug", severity: "high",
  description: "A queued turn never starts after Stop.", steps: "", expected: "", actual: "", workaround: "",
  source: { chatId: "one", chatTitle: "Investigation", projectId: "p1", projectName: "Example", modelId: "codex:test", appVersion: "0.3.6" },
  status: "resolved", note: "Fixed in abc1234", createdAt: 10, updatedAt: 20, revision: 2,
};

describe("who last updated a feedback report", () => {
  it("names an agent by its chat and the page's save as you", () => {
    expect(feedbackUpdatedBy({ updatedBy: { kind: "agent", chatId: "fixer", chatTitle: "Fix the queue" } })).toBe("Fix the queue (agent)");
    expect(feedbackUpdatedBy({ updatedBy: { kind: "agent", chatId: "fixer", chatTitle: " " } })).toBe("an untitled chat (agent)");
    expect(feedbackUpdatedBy({ updatedBy: { kind: "person", chatId: "", chatTitle: "" } })).toBe("you");
  });

  it("says nothing for a report saved before updates were attributed", () => {
    expect(feedbackUpdatedBy(report)).toBeNull();
    expect(feedbackUpdatedBy({ updatedBy: null })).toBeNull();
  });

  it("keeps the fix brief the same whoever updated the report", () => {
    const updated = { ...report, updatedBy: { kind: "agent" as const, chatId: "fixer", chatTitle: "Fix the queue" } };
    expect(feedbackBrief(updated)).toBe(feedbackBrief(report));
  });
});
