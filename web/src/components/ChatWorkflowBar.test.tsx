import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatWorkflowBar } from "./ChatWorkflowBar";
import { EMPTY_ORCHESTRATION } from "../lib/orchestration";

describe("ChatWorkflowBar", () => {
  it("keeps the selected run title above task and chat navigation in a worker chat", () => {
    const run = { id: "run", coordinatorChatKey: "chat:main", objective: "Ship the unified workspace", status: "running" as const, workspaceId: "project", rootPath: "/repo", createdAt: 1, updatedAt: 1, maxConcurrent: 2 };
    const html = renderToStaticMarkup(<ChatWorkflowBar unified worker selectedRun={run}
      snapshot={{ ...EMPTY_ORCHESTRATION, runs: [run] }} orchestrated view="chat" onView={() => {}} />);
    expect(html).toMatch(/<h1 class="workflow-title" id="[^"]+">Ship the unified workspace<\/h1>/);
    expect(html).toMatch(/<button[^>]+workflow-title-toggle[^>]+hidden=""[^>]+aria-expanded="false"[^>]+aria-controls="[^"]+"[^>]+aria-label="Show full objective details"/);
    expect(html).toContain("Show details</button>");
    expect(html).toContain('aria-pressed="false">Tasks');
    expect(html).toContain('aria-pressed="true">Chat');
    expect(html).not.toContain('aria-label="Execution mode"');
    expect(html.indexOf("Ship the unified workspace")).toBeLessThan(html.indexOf('aria-label="Conversation view"'));
  });

  it("shows the selected historical run title without duplicating status from task details", () => {
    const run = { id: "history", coordinatorChatKey: "chat:main", objective: "Earlier work", status: "completed" as const, workspaceId: "project", rootPath: "/repo", createdAt: 1, updatedAt: 1, maxConcurrent: 2 };
    const html = renderToStaticMarkup(<ChatWorkflowBar unified selectedRun={run}
      snapshot={{ ...EMPTY_ORCHESTRATION, runs: [{ ...run, id: "active", objective: "Current work", status: "running" }, run] }}
      orchestrated view="chat" onView={() => {}} />);
    expect(html).toContain("Earlier work");
    expect(html).not.toContain("Completed · 0/0");
    expect(html).not.toContain("Current work");
  });
  it("draws nothing over a chat with no run: there is no execution mode to pick", () => {
    const html = renderToStaticMarkup(<ChatWorkflowBar snapshot={EMPTY_ORCHESTRATION} orchestrated={false} view="chat" onView={() => {}} />);
    expect(html).toBe("");
  });
  it("offers Tasks and Chat once the person opens the run surface, still without a mode picker", () => {
    const html = renderToStaticMarkup(<ChatWorkflowBar snapshot={EMPTY_ORCHESTRATION} orchestrated view="run" onView={() => {}} />);
    expect(html).toContain('aria-label="Conversation view"');
    expect(html).not.toContain("<select");
    expect(html).not.toContain("Execution");
  });
  it("does not let a view change silently end an active run and points approvals to Chat", () => {
    const snapshot = { ...EMPTY_ORCHESTRATION, runs: [{ id: "run", coordinatorChatKey: "chat:main", objective: "Fix", status: "running" as const, workspaceId: "project", rootPath: "/repo", createdAt: 1, updatedAt: 1, maxConcurrent: 2 }] };
    const html = renderToStaticMarkup(<ChatWorkflowBar snapshot={snapshot} orchestrated={false} view="run" pendingApprovals={2} onView={() => {}} />);
    expect(html).not.toContain("<select");
    expect(html).toContain('aria-pressed="true">Run');
    expect(html).not.toContain("2 awaiting approval");
    expect(html).not.toContain("Open Run to pause dispatch or stop");
  });
  it("keeps the way back to a run in focus mode, and draws nothing without one", () => {
    const plain = renderToStaticMarkup(<ChatWorkflowBar focusMode snapshot={EMPTY_ORCHESTRATION} orchestrated={false} view="chat" onView={() => {}} />);
    expect(plain).toBe("");

    const snapshot = { ...EMPTY_ORCHESTRATION, runs: [{ id: "run", coordinatorChatKey: "chat:main", objective: "Fix", status: "running" as const, workspaceId: "project", rootPath: "/repo", createdAt: 1, updatedAt: 1, maxConcurrent: 2 }] };
    const running = renderToStaticMarkup(<ChatWorkflowBar focusMode snapshot={snapshot} orchestrated view="chat" onView={() => {}} />);
    expect(running).not.toContain('aria-label="Execution mode"');
    expect(running).not.toContain("Execution");
    expect(running).toContain('aria-label="Conversation view"');
    expect(running).not.toContain('class="chat-run-summary"');
  });
  it("drops the view tabs once both columns are on screen", () => {
    const snapshot = { ...EMPTY_ORCHESTRATION, runs: [{ id: "run", coordinatorChatKey: "chat:main", objective: "Fix", status: "running" as const, workspaceId: "project", rootPath: "/repo", createdAt: 1, updatedAt: 1, maxConcurrent: 2 }] };
    const html = renderToStaticMarkup(<ChatWorkflowBar split snapshot={snapshot} orchestrated view="chat" pendingApprovals={2} onView={() => {}} />);
    // Nothing to switch between, so no switch. Approval counts stay in the
    // run/task details instead of duplicating status in the navigation bar.
    expect(html).not.toContain('aria-label="Conversation view"');
    expect(html).not.toContain('aria-label="Execution mode"');
    expect(html).not.toContain("2 awaiting approval");
    expect(html).not.toContain('class="chat-run-summary"');
  });

  it("puts one compact worker return control beside the run title", () => {
    const run = { id: "run", coordinatorChatKey: "chat:main", objective: "Ship the unified workspace", status: "running" as const, workspaceId: "project", rootPath: "/repo", createdAt: 1, updatedAt: 1, maxConcurrent: 2 };
    const html = renderToStaticMarkup(<ChatWorkflowBar unified worker selectedRun={run}
      snapshot={{ ...EMPTY_ORCHESTRATION, runs: [run] }} orchestrated view="chat" onView={() => {}} onBackToMain={() => {}} />);
    expect(html).toMatch(/class="workflow-back-main"[^>]+aria-label="Back to main chat"/);
    expect(html.indexOf("workflow-back-main")).toBeLessThan(html.indexOf("Ship the unified workspace"));
    expect(html.match(/Back to main chat/g)).toHaveLength(2);
  });
});
