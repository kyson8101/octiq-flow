import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatWorkflowBar } from "./ChatWorkflowBar";
import { EMPTY_ORCHESTRATION } from "../lib/orchestration";

describe("ChatWorkflowBar", () => {
  it("starts as a normal conversation with no empty Run tab", () => {
    const html = renderToStaticMarkup(<ChatWorkflowBar snapshot={EMPTY_ORCHESTRATION} orchestrated={false} view="chat" onMode={() => {}} onView={() => {}} />);
    expect(html).toContain('value="normal" selected=""');
    expect(html).not.toContain('aria-label="Conversation view"');
  });
  it("does not let a view change silently end an active run and points approvals to Chat", () => {
    const snapshot = { ...EMPTY_ORCHESTRATION, runs: [{ id: "run", coordinatorChatKey: "chat:main", objective: "Fix", status: "running" as const, workspaceId: "project", rootPath: "/repo", createdAt: 1, updatedAt: 1, maxConcurrent: 2 }] };
    const html = renderToStaticMarkup(<ChatWorkflowBar snapshot={snapshot} orchestrated={false} view="run" pendingApprovals={2} onMode={() => {}} onView={() => {}} />);
    expect(html).toContain('value="normal" disabled=""');
    expect(html).toContain('aria-pressed="true">Run');
    expect(html).toContain("2 awaiting approval");
    expect(html).toContain("Open Run to pause dispatch or stop");
  });
});
