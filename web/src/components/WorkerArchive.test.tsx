import { describe, expect, it, vi } from "vitest";
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => null, on: () => () => {}, onState: () => () => {} } }));
import { renderToStaticMarkup } from "react-dom/server";
import { mergedWorkers } from "../lib/__fixtures__/workerArchive";
import { workerChatParents, type OrchestrationSnapshot } from "../lib/orchestration";
import type { Conversation } from "../lib/store";
import { Sidebar } from "./Sidebar";
import { AgentTaskBoard } from "./AgentTaskBoard";
import { OrchestrationPanel } from "./OrchestrationPanel";

const chats: Conversation[] = ["main", "previous", "worker"].map(id => ({ id, title: `Chat ${id}`, projectId: "project", messages: [], createdAt: 1, updatedAt: 2 }));
const panel = (snapshot: OrchestrationSnapshot, readOnly = false) => renderToStaticMarkup(<OrchestrationPanel initialSnapshot={snapshot} coordinatorKey="chat:main"
  project={{ id: "project", name: "Project" }} onOpenChat={() => {}} onClose={() => {}} readOnly={readOnly} />);

describe("worker archive controls", () => {
  it("offers bulk archiving only in completed runs with eligible workers", () => {
    const snapshot = mergedWorkers();
    expect(panel(snapshot)).toContain("Archive all merged workers (2)");
    snapshot.runs[0].status = "running";
    expect(panel(snapshot)).not.toContain("Archive all merged workers");
    snapshot.runs[0].status = "completed";
    snapshot.tasks[0].workspace!.delivery!.merged = false;
    expect(panel(snapshot)).not.toContain("Archive all merged workers");
    expect(panel(snapshot)).toContain('disabled="" title="Refresh delivery status');
  });

  it("preserves archived activity and restore actions in task history", () => {
    const snapshot = mergedWorkers();
    snapshot.attempts.forEach(attempt => { attempt.archivedAt = 3; });
    const out = panel(snapshot);
    expect(out.match(/>Restore worker</g)).toHaveLength(2);
    expect(out).toContain("Previous attempts (1)");
    expect(out).toContain("codex worker #1");
    expect(out).toContain("codex worker #2");
    expect(out.match(/>Archived</g)).toHaveLength(2);
    expect(out).not.toContain("Archive all merged workers");
    const readonly = panel(snapshot, true);
    expect(readonly).toContain("codex worker #2");
    expect(readonly).not.toContain("Restore worker");
  });

  it("marks the task whose worker chat is open", () => {
    const snapshot = mergedWorkers();
    const open = renderToStaticMarkup(<OrchestrationPanel initialSnapshot={snapshot} coordinatorKey="chat:main" currentChatKey="chat:worker"
      project={{ id: "project", name: "Project" }} onOpenChat={() => {}} onClose={() => {}} embedded />);
    expect(open.match(/orch-task is-[a-z]+ is-open/g)).toHaveLength(1);
    expect(open).toContain('aria-current="page"');
    expect(panel(snapshot)).not.toContain(" is-open");
  });

  it("hides archived workers from the chat list while keeping the run's totals", () => {
    const snapshot = mergedWorkers();
    snapshot.attempts.forEach(attempt => { attempt.archivedAt = 3; });
    const out = renderToStaticMarkup(<Sidebar orchestration={snapshot} projects={[]} shelved={[]}
      conversations={chats} chatParents={workerChatParents(snapshot)} currentConversation="worker" running={new Set()} busy={new Set()}
      onPickConversation={() => {}} onNewChat={() => {}} onDelete={() => {}} onPin={() => {}} onToggleDone={() => {}} onRename={() => {}}
      onArchiveWorker={async () => {}} />);
    expect(out.match(/class="chat-title"/g)).toHaveLength(1);
    expect(out).not.toContain('class="agent-task');
    expect(out).toContain("Completed · 1/1");
  });

  it("keeps a task with a restored worker in the board, and archiving in the Run column", () => {
    const snapshot = mergedWorkers();
    snapshot.attempts[1].archivedAt = 3;
    const out = renderToStaticMarkup(<AgentTaskBoard snapshot={snapshot} conversations={new Map(chats.map(c => [c.id, c]))}
      currentConversation={null} onOpenChat={() => {}} />);
    expect(out).toContain('class="agent-task"');
    // The sidebar navigates; archiving and attempt history are the dashboard's.
    expect(out).not.toContain("Archive worker");
    expect(out).not.toContain("Attempt 2");
    expect(panel(snapshot)).toContain(">Archive worker</button>");
    expect(panel(snapshot)).toContain("Previous attempts (1)");
  });
});
