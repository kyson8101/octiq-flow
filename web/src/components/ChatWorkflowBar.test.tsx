import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatWorkflowBar } from "./ChatWorkflowBar";
import { EMPTY_ORCHESTRATION } from "../lib/orchestration";

describe("ChatWorkflowBar", () => {
  it("keeps the selected run title above task and chat navigation in a worker chat", () => {
    const run = { id: "run", coordinatorChatKey: "chat:main", objective: "Ship the unified workspace", status: "running" as const, workspaceId: "project", rootPath: "/repo", createdAt: 1, updatedAt: 1, maxConcurrent: 2 };
    const html = renderToStaticMarkup(<ChatWorkflowBar unified worker selectedRun={run}
      snapshot={{ ...EMPTY_ORCHESTRATION, runs: [run] }} orchestrated view="chat" onMode={() => {}} onView={() => {}} />);
    expect(html).toContain('<h1 class="workflow-title">Ship the unified workspace</h1>');
    expect(html).toContain('aria-pressed="false">Tasks');
    expect(html).toContain('aria-pressed="true">Chat');
    expect(html).not.toContain('aria-label="Execution mode"');
    expect(html.indexOf("Ship the unified workspace")).toBeLessThan(html.indexOf('aria-label="Conversation view"'));
  });

  it("shows the selected historical run instead of the active run's title and status", () => {
    const run = { id: "history", coordinatorChatKey: "chat:main", objective: "Earlier work", status: "completed" as const, workspaceId: "project", rootPath: "/repo", createdAt: 1, updatedAt: 1, maxConcurrent: 2 };
    const html = renderToStaticMarkup(<ChatWorkflowBar unified selectedRun={run}
      snapshot={{ ...EMPTY_ORCHESTRATION, runs: [{ ...run, id: "active", objective: "Current work", status: "running" }, run] }}
      orchestrated view="chat" onMode={() => {}} onView={() => {}} />);
    expect(html).toContain("Earlier work");
    expect(html).toContain("Completed · 0/0");
    expect(html).not.toContain("Current work");
  });
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
  it("drops the execution control in focus mode, and the whole bar with nothing left in it", () => {
    const plain = renderToStaticMarkup(<ChatWorkflowBar focusMode snapshot={EMPTY_ORCHESTRATION} orchestrated={false} view="chat" onMode={() => {}} onView={() => {}} />);
    expect(plain).toBe("");

    const snapshot = { ...EMPTY_ORCHESTRATION, runs: [{ id: "run", coordinatorChatKey: "chat:main", objective: "Fix", status: "running" as const, workspaceId: "project", rootPath: "/repo", createdAt: 1, updatedAt: 1, maxConcurrent: 2 }] };
    const running = renderToStaticMarkup(<ChatWorkflowBar focusMode snapshot={snapshot} orchestrated view="chat" onMode={() => {}} onView={() => {}} />);
    // Configuration goes; the way back to a run in flight stays.
    expect(running).not.toContain('aria-label="Execution mode"');
    expect(running).not.toContain("Execution");
    expect(running).toContain('aria-label="Conversation view"');
    expect(running).toContain('class="chat-run-summary"');
  });
  it("drops the view tabs once both columns are on screen", () => {
    const snapshot = { ...EMPTY_ORCHESTRATION, runs: [{ id: "run", coordinatorChatKey: "chat:main", objective: "Fix", status: "running" as const, workspaceId: "project", rootPath: "/repo", createdAt: 1, updatedAt: 1, maxConcurrent: 2 }] };
    const html = renderToStaticMarkup(<ChatWorkflowBar split snapshot={snapshot} orchestrated view="chat" pendingApprovals={2} onMode={() => {}} onView={() => {}} />);
    // Nothing to switch between, so no switch — but the approvals that used to
    // ride on the Chat tab still have to be said somewhere.
    expect(html).not.toContain('aria-label="Conversation view"');
    expect(html).toContain('aria-label="Execution mode"');
    expect(html).toContain("2 awaiting approval");
    expect(html).toContain('class="chat-run-summary"');
  });
});
