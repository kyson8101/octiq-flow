import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

vi.mock("../lib/bridge", () => ({
  bridge: { invoke: async () => null, on: () => () => {}, onState: () => () => {} },
}));

import type { Conversation } from "../lib/store";
import { workerChatParents, type OrchestrationSnapshot } from "../lib/orchestration";
import { pendingActions, pendingByRow, pendingByTask, type PendingActionInput } from "../lib/pendingActions";
import { PendingActionBadge, PendingActionsContext, type PendingActionsView } from "./PendingActionBadge";
import { Sidebar } from "./Sidebar";
import { ProjectsPage } from "./ProjectsPage";
import { ChatSearchPage } from "./ChatSearchPage";
import { ChatRequests } from "./ChatRequests";
import { ChatPlanCards } from "./ChatPlanCards";
import { OrchestrationPanel } from "./OrchestrationPanel";

const chat = (id: string, over: Partial<Conversation> = {}): Conversation => ({
  id, projectId: "p1", title: `Chat ${id}`, messages: [], createdAt: 1, updatedAt: 1, ...over,
});

/** A main chat whose run has one worker; the worker's chat is in the list
 *  data but never listed. */
const ledger: OrchestrationSnapshot = {
  runs: [{
    id: "run_1", objective: "Ship", coordinatorChatKey: "chat:main", workspaceId: "p1", rootPath: "/r",
    status: "running", maxConcurrent: 2, createdAt: 1, updatedAt: 1,
    planApproval: { status: "pending", requestedAt: 1, revision: 4 },
  }],
  tasks: [{ id: "task_1", runId: "run_1", title: "Build it", spec: "", dependsOn: [], status: "running", activeAttemptId: "a1", createdAt: 1, updatedAt: 1 }],
  attempts: [{
    id: "a1", runId: "run_1", taskId: "task_1", number: 1, workerChatKey: "chat:worker", agent: "claude", access: "auto",
    status: "running", cwd: "/r", branch: "b", isWorktree: true, filesModified: [], createdAt: 1, updatedAt: 1,
    execution: { state: "waiting_tool", retryCount: 0 },
  }],
  gates: [], messages: [],
};

function view(input: Partial<PendingActionInput> = {}): PendingActionsView {
  const actions = pendingActions({ orchestration: ledger, parents: workerChatParents(ledger), ...input });
  const rows = pendingByRow(actions);
  const tasks = pendingByTask(actions);
  return { forRow: (id) => rows.get(id) ?? [], forTask: (id) => tasks.get(id) ?? [], reveal: () => {} };
}
const withView = (value: PendingActionsView, element: ReactElement) =>
  renderToStaticMarkup(<PendingActionsContext.Provider value={value}>{element}</PendingActionsContext.Provider>);

const sidebar = (value: PendingActionsView, over: Partial<Parameters<typeof Sidebar>[0]> = {}) => withView(value, <Sidebar
  projects={[{ id: "p1", name: "octiq-flow" }]} shelved={[]} orchestration={ledger}
  conversations={[chat("main"), chat("worker"), chat("quiet")]} chatParents={workerChatParents(ledger)}
  currentConversation={null} running={new Set(["main"])} busy={new Set(["main"])}
  onPickConversation={() => {}} onNewChat={() => {}} onDelete={() => {}} onPin={() => {}}
  onToggleDone={() => {}} onRename={() => {}} {...over} />);

/** The markup of one sidebar row, from its opening tag to the next row's. */
function row(html: string, id: string): string {
  const start = html.indexOf(`>Chat ${id}<`);
  if (start < 0) return "";
  const open = html.lastIndexOf('<li class="chat-row">', start);
  const next = html.indexOf('<li class="chat-row">', start);
  return html.slice(open, next < 0 ? undefined : next);
}

describe("pending action badge", () => {
  it("rolls a hidden worker's permission and the plan into the main row", () => {
    const html = sidebar(view({ asks: { worker: [{ id: "perm-1" }] } }));
    expect(html).not.toContain(">Chat worker<"); // the worker stays out of the list
    const main = row(html, "main");
    expect(main).toContain("has-pending");
    expect(main).toContain(">Action needed · 2</span>");
    expect(main).toContain('aria-label="Action needed · 2 for Chat main: 1 permission request, 1 plan to approve. Show the first one"');
    // The row's own button still opens the chat and names the need.
    expect(main).toMatch(/class="chat-btn"[^>]*aria-label="[^"]*, Action needed · 2/);
    expect(row(html, "quiet")).not.toContain("pending-action-badge");
  });

  it("is a button of its own, not inside the row's button", () => {
    const main = row(sidebar(view()), "main");
    const rowButtonEnd = main.indexOf("</button>");
    expect(main.indexOf("pending-action-badge")).toBeGreaterThan(rowButtonEnd);
    expect(main).toContain('data-kind="plan"');
    expect(main).toContain(">Plan approval</span>");
  });

  it("keeps a running chat's working signal beside the badge", () => {
    const main = row(sidebar(view()), "main");
    expect(main).toMatch(/class="chat [^"]*is-busy[^"]*has-pending/);
    expect(main).toContain("chat-badge-ring");
  });

  it("shows on a pinned row", () => {
    const html = sidebar(view(), { conversations: [chat("main", { pinned: true }), chat("worker")] });
    expect(row(html, "main")).toContain(">Plan approval</span>");
  });

  it("is shown on Projects and Search rows too", () => {
    const value = view({ questions: { quiet: [{ id: "q1" }] } });
    const projects = withView(value, <ProjectsPage projects={[{ id: "p1", name: "octiq-flow" }]} shelved={[]}
      conversations={[chat("quiet")]} selectedProjectId="p1" busy={new Set()} chatParents={new Map()}
      onSelectProject={() => {}} onOpenChat={() => {}} onNewTask={() => {}} onNewProject={() => {}}
      onProjectSettings={() => {}} onClose={() => {}} />);
    expect(projects).toContain(">Answer needed</span>");
    expect(projects).toContain('aria-label="Chat quiet, Answer needed"');
    const search = withView(value, <ChatSearchPage conversations={[chat("quiet")]} projects={[{ id: "p1", name: "octiq-flow" }]}
      searchChats={async () => []} onOpenChat={() => {}} onClose={() => {}} />);
    expect(search).toContain(">Answer needed</span>");
  });

  it("marks the task row that holds the card", () => {
    // Approved, so the task list is drawn rather than the plan.
    const approved = { ...ledger, runs: [{ ...ledger.runs[0], planApproval: { status: "approved" as const, requestedAt: 1, revision: 4 } }] };
    const html = withView(view({ asks: { worker: [{ id: "perm-1" }] } }), <OrchestrationPanel embedded
      project={{ id: "p1", name: "octiq-flow" }} coordinatorKey="chat:main" initialSnapshot={approved}
      allowManualRun={false} onOpenChat={() => {}} onClose={() => {}} />);
    expect(html).toContain('class="pending-action-badge orch-task-pending"');
    expect(html).toContain(">Permission needed</span>");
  });

  it("renders nothing with nothing pending", () => {
    expect(renderToStaticMarkup(<PendingActionBadge actions={[]} subject="x" />)).toBe("");
  });
});

describe("cards carry the identity a badge looks for", () => {
  const callbacks = {
    onPermissionAnswered: () => {}, onSafetyAnswered: () => {}, onQuestionsAnswered: () => {}, onContinue: async () => {},
  };
  it("labels each request card, and one question card with every batch", () => {
    const html = renderToStaticMarkup(<ChatRequests asks={[{ id: "p1" }]} safetyBlocks={[{ id: "s1", title: "Blocked", reason: "r" } as never]}
      questions={[{ id: "q1", batch: "b1", question: "One?" }, { id: "q2", batch: "b1", question: "Two?" }, { id: "q3", question: "Three?" }]}
      {...callbacks} />);
    expect(html).toContain('data-pending-keys="permission:p1"');
    expect(html).toContain('data-pending-keys="safety:s1"');
    expect(html).toContain('data-pending-keys="question:b1 question:q3"');
  });

  it("labels a waiting plan by its revision", () => {
    const html = renderToStaticMarkup(<ChatPlanCards drafting={false} plans={[{
      run: ledger.runs[0], tasks: ledger.tasks, handle: "0001", revision: 4, pending: true,
    }]} />);
    expect(html).toContain('data-pending-keys="plan:run_1:4"');
  });
});
