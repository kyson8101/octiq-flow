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
  it("shows task counts, reported stages, workspace paths, and the activity escape hatch", () => {
    const out = renderToStaticMarkup(<AgentTaskBoard snapshot={taskBoardFixture()} conversations={new Map(chats.map((chat) => [chat.id, chat]))} currentConversation={null} onOpenChat={() => {}} />);
    expect(out).toContain('aria-valuetext="1 of 4 tasks completed"');
    expect(out).toContain("50%");
    expect(out).toContain("Run focused tests");
    expect(out).toContain("2/4 steps done · 2 to do");
    expect(out).toContain("/projects/.worktrees/reader-access");
    expect(out).toContain("Worktree · task/reader-access");
    expect(out).toContain("Current checkout · develop");
    expect(out).toContain("Workspace pending");
    expect(out).toContain("Needs a decision:");
    expect(out).toContain("Open activity");
  });
  it("replaces nested worker conversations with one row per task, including undispatched tasks", () => {
    const snapshot = taskBoardFixture();
    const out = renderToStaticMarkup(<Sidebar orchestration={snapshot} projects={[]} shelved={[]} onShowShelved={() => {}}
      conversations={chats} chatParents={workerChatParents(snapshot)} currentConversation={null} running={new Set()} busy={new Set()}
      onPickConversation={() => {}} onNewChat={() => {}} onDelete={() => {}} onPin={() => {}} onRename={() => {}}
      onNewProject={() => {}} searchChats={async () => []} />);
    expect(out.match(/class="chat-title"/g)).toHaveLength(1);
    expect(out.match(/class="agent-task"/g)).toHaveLength(4);
    expect(out).toContain("Document the access rules");
    expect(out).toContain("4 tasks");
  });
  it("keeps unavailable worker transcripts from becoming dead navigation buttons", () => {
    const out = renderToStaticMarkup(<AgentTaskBoard snapshot={taskBoardFixture()} conversations={new Map()} currentConversation={null} onOpenChat={() => {}} />);
    expect(out).not.toContain("Open activity");
    expect(out).toContain("Activity is unavailable for this attempt.");
  });
});
