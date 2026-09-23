import { describe, expect, it, vi } from "vitest";
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => null, on: () => () => {}, onState: () => () => {} } }));
import { renderToStaticMarkup } from "react-dom/server";
import { mergedWorkers } from "../lib/__fixtures__/workerArchive";
import { workerChatParents, type OrchestrationSnapshot } from "../lib/orchestration";
import type { Conversation } from "../lib/store";
import { Sidebar } from "./Sidebar";
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

  it("hides selected archived workers from the active sidebar", () => {
    const snapshot = mergedWorkers();
    snapshot.attempts.forEach(attempt => { attempt.archivedAt = 3; });
    const out = renderToStaticMarkup(<Sidebar orchestration={snapshot} projects={[]} shelved={[]} onShowShelved={() => {}}
      conversations={chats} chatParents={workerChatParents(snapshot)} currentConversation="worker" running={new Set()} busy={new Set()}
      onPickConversation={() => {}} onNewChat={() => {}} onDelete={() => {}} onPin={() => {}} onRename={() => {}}
      onArchiveWorker={async () => {}} onNewProject={() => {}} searchChats={async () => []} />);
    expect(out.match(/class="chat-title"/g)).toHaveLength(1);
    expect(out).not.toContain('class="chat-title">Chat worker');
    expect(out).not.toContain('class="chat-title">Chat previous');
  });

});
