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
  it("replaces nested worker conversations with one row per task, including undispatched tasks", () => {
    const snapshot = taskBoardFixture();
    const out = renderToStaticMarkup(<Sidebar orchestration={snapshot} projects={[]} shelved={[]} onShowShelved={() => {}}
      conversations={chats} chatParents={workerChatParents(snapshot)} currentConversation={null} running={new Set()} busy={new Set()}
      onPickConversation={() => {}} onNewChat={() => {}} onDelete={() => {}} onPin={() => {}} onToggleDone={() => {}} onRename={() => {}}
      onNewProject={() => {}} searchChats={async () => []} />);
    expect(out.match(/class="chat-title"/g)).toHaveLength(1);
    expect(out.match(/class="agent-task"/g)).toHaveLength(4);
    expect(out).toContain("Document the access rules");
    expect(out).toContain("4 tasks");
  });
  it("keeps compact subagent status in the chat list beside the run column", () => {
    const snapshot = taskBoardFixture();
    const out = renderToStaticMarkup(<Sidebar orchestration={snapshot} projects={[]} shelved={[]} onShowShelved={() => {}}
      conversations={chats} chatParents={workerChatParents(snapshot)} currentConversation={null} running={new Set()} busy={new Set()}
      onPickConversation={() => {}} onNewChat={() => {}} onDelete={() => {}} onPin={() => {}} onToggleDone={() => {}} onRename={() => {}}
      onNewProject={() => {}} searchChats={async () => []} />);
    // Worker transcripts stay folded away, while their status rows remain a
    // useful navigation index beside the detailed run dashboard.
    expect(out.match(/class="chat-title"/g)).toHaveLength(1);
    expect(out.match(/class="agent-task"/g)).toHaveLength(4);
    expect(out).toContain("Document the access rules");
    expect(out).toContain("Run focused tests");
  });
  it("keeps an undispatched task from becoming a dead navigation button", () => {
    const out = renderToStaticMarkup(<AgentTaskBoard snapshot={taskBoardFixture()} conversations={new Map()} currentConversation={null} onOpenChat={() => {}} />);
    expect(out).not.toContain('class="agent-task-row"');
    expect(out.match(/class="agent-task-row is-static"/g)).toHaveLength(4);
  });
});
