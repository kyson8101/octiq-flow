import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { taskBoardFixture } from "../lib/__fixtures__/agentTaskBoard";
import type { Conversation } from "../lib/store";
import { AgentTaskBoard } from "./AgentTaskBoard";
import { Sidebar } from "./Sidebar";
import { workerChatParents } from "../lib/orchestration";

const conversation = (id: string): Conversation => ({ id, projectId: "project", title: `Worker ${id}`, createdAt: 1, updatedAt: 1, messages: [] });
const chats = [conversation("main"), conversation("w-auth"), conversation("w-reader"), conversation("w-export")];

describe("compact agent task board", () => {
  it("labels task completion separately from unverified product acceptance", () => {
    const snapshot = taskBoardFixture();
    snapshot.tasks.forEach(task => { task.status = "completed"; task.result = "NOT RELEASE-READY"; });
    const out = renderToStaticMarkup(<AgentTaskBoard snapshot={snapshot} conversations={new Map()} currentConversation={null} onOpenChat={() => {}} />);
    expect(out).toContain("Tasks completed");
    expect(out).toContain("100%");
    expect(out).toContain("Acceptance: unverified");
  });

  it("puts attention and active work above settled tasks without changing ledger order", () => {
    const snapshot = taskBoardFixture();
    const statuses = ["completed", "pending", "running", "cancelled", "ready", "blocked", "running", "failed", "completed"] as const;
    snapshot.tasks = statuses.map((status, index) => ({
      ...snapshot.tasks[0], id: `task-${index}`, title: `Task ${index}`, status, activeAttemptId: undefined,
    }));
    snapshot.attempts = [];
    const before = structuredClone(snapshot);
    const out = renderToStaticMarkup(<AgentTaskBoard snapshot={snapshot} conversations={new Map()} currentConversation={null} onOpenChat={() => {}} />);
    expect([...out.matchAll(/<strong title="([^"]+)">/g)].map(match => match[1])).toEqual([
      "Task 5", "Task 7", "Task 2", "Task 6", "Task 4", "Task 1", "Task 0", "Task 8", "Task 3",
    ]);
    expect(snapshot).toEqual(before);
  });

  it("reorders live updates and ignores stale attention evidence on completed tasks", () => {
    const snapshot = taskBoardFixture();
    snapshot.tasks = [snapshot.tasks[0], snapshot.tasks[1]];
    const [completed, working] = snapshot.tasks;
    snapshot.attempts[0].execution = { state: "stalled", retryCount: 0 };
    snapshot.attempts[1].execution = { state: "waiting_tool", retryCount: 0 };
    const titles = () => {
      const out = renderToStaticMarkup(<AgentTaskBoard snapshot={snapshot} conversations={new Map()} currentConversation={null} onOpenChat={() => {}} />);
      return [...out.matchAll(/<strong title="([^"]+)">/g)].map(match => match[1]);
    };
    expect(titles()).toEqual([working.title, completed.title]);
    completed.status = "running";
    expect(titles()).toEqual([completed.title, working.title]);
    completed.status = "completed";
    expect(titles()).toEqual([working.title, completed.title]);
  });

  it("shows the run's shape and one tappable line per task", () => {
    const out = renderToStaticMarkup(<AgentTaskBoard snapshot={taskBoardFixture()} conversations={new Map(chats.map((chat) => [chat.id, chat]))} currentConversation={null} onOpenChat={() => {}} />);
    expect(out).toContain('aria-valuetext="1 of 4 tasks completed"');
    expect(out).toContain("50%");
    expect(out).toContain("Run focused tests");
    expect(out).toContain("Document the access rules");
    expect(out.match(/class="agent-task-row"/g)).toHaveLength(3);
  });
  it("keeps everything that explains a task out of the sidebar", () => {
    // This is a chat list, not a dashboard. Briefs, checklists, workspace
    // paths, earlier attempts and archive controls live in the Run column.
    const out = renderToStaticMarkup(<AgentTaskBoard snapshot={taskBoardFixture()} conversations={new Map(chats.map((chat) => [chat.id, chat]))} currentConversation="w-reader" onOpenChat={() => {}} />);
    for (const gone of ["<details", "Brief", "Workspace", "Checkout root", "Archive worker", "Open activity",
      "Add reader access checks", "Inspect request paths", "Needs a decision"]) {
      expect(out).not.toContain(gone);
    }
    // The step count survives only as a tooltip on the percentage.
    expect(out).toContain('title="2 of 4 reported steps done"');
    expect(out).toContain('aria-current="page"');
  });
  it("leaves a run's tasks to the run column and keeps one summary row in the chat list", () => {
    // The task list opens beside the chat list, so the sidebar no longer
    // carries a second copy of it: one row for the main chat, with the run's
    // one-line summary, and no worker transcripts or task rows under it.
    const snapshot = taskBoardFixture();
    const out = renderToStaticMarkup(<Sidebar orchestration={snapshot} projects={[]} shelved={[]}
      conversations={chats} chatParents={workerChatParents(snapshot)} currentConversation={null} running={new Set()} busy={new Set()}
      onPickConversation={() => {}} onNewChat={() => {}} onDelete={() => {}} onPin={() => {}} onToggleDone={() => {}} onRename={() => {}}
      />);
    expect(out.match(/class="chat-title"/g)).toHaveLength(1);
    expect(out).not.toContain('class="agent-task');
    expect(out).not.toContain("chat-children-toggle");
    expect(out).toContain('class="chat-workflow-status"');
    expect(out).not.toContain("is-worker-on");
  });
  it("outlines the main chat while one of its workers is open", () => {
    const snapshot = taskBoardFixture();
    const out = renderToStaticMarkup(<Sidebar orchestration={snapshot} projects={[]} shelved={[]}
      conversations={chats} chatParents={workerChatParents(snapshot)} currentConversation="w-reader" running={new Set()} busy={new Set()}
      onPickConversation={() => {}} onNewChat={() => {}} onDelete={() => {}} onPin={() => {}} onToggleDone={() => {}} onRename={() => {}}
      />);
    expect(out.match(/class="chat-title"/g)).toHaveLength(1);
    expect(out).toContain("is-worker-on");
  });
  it("keeps an undispatched task from becoming a dead navigation button", () => {
    const out = renderToStaticMarkup(<AgentTaskBoard snapshot={taskBoardFixture()} conversations={new Map()} currentConversation={null} onOpenChat={() => {}} />);
    expect(out).not.toContain('class="agent-task-row"');
    expect(out.match(/class="agent-task-row is-static"/g)).toHaveLength(4);
  });
});
