import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../lib/bridge", () => ({ bridge: { invoke: vi.fn(), on: () => () => {}, onState: () => () => {} } }));

import { FeedbackDetail } from "./FeedbackInbox";
import type { FeedbackReport } from "../lib/feedback";

const report: FeedbackReport = {
  id: "report-one", requestId: "r1", title: "Queue stalls", kind: "bug", severity: "high",
  description: "A queued turn never starts after Stop.", steps: "", expected: "", actual: "", workaround: "",
  source: { chatId: "one", chatTitle: "Investigation", projectId: "p1", projectName: "Example", modelId: "codex:test", appVersion: "0.3.6" },
  status: "resolved", note: "Fixed in abc1234", createdAt: 10, updatedAt: 20, revision: 2,
};
const detail = (shown: FeedbackReport) => renderToStaticMarkup(
  <FeedbackDetail report={shown} available onOpenChat={() => {}} onBack={() => {}} onSaved={() => {}} />);

describe("a feedback report's last update", () => {
  it("names the agent chat that changed the status", () => {
    const html = detail({ ...report, updatedBy: { kind: "agent", chatId: "fixer", chatTitle: "Fix the queue" } });
    expect(html).toMatch(/Last updated [^<]* by Fix the queue \(agent\)/);
  });

  it("says you for a save from the page", () => {
    expect(detail({ ...report, updatedBy: { kind: "person", chatId: "", chatTitle: "" } })).toMatch(/Last updated [^<]* by you</);
  });

  it("draws no line for a report nobody has updated", () => {
    const html = detail(report);
    expect(html).not.toContain("Last updated");
    expect(html).toContain("Reported ");
  });
});
