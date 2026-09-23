import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/bridge", () => ({
  bridge: {
    invoke: async () => null,
    on: () => () => {},
    onState: () => () => {},
  },
}));

import type { TaskWorkspace } from "../lib/orchestration";
import { OrchestrationPanel, retryLaunchArgs, type OrchestrationSnapshot } from "./OrchestrationPanel";

const snapshot: OrchestrationSnapshot = {
  runs: [{
    id: "run_1",
    objective: "Ship orchestration",
    coordinatorChatKey: "chat:master",
    workspaceId: "project",
    rootPath: "/repo",
    status: "waiting",
    maxConcurrent: 4,
    createdAt: 1,
    updatedAt: 2,
  }],
  tasks: [{
    id: "task_1",
    runId: "run_1",
    title: "Build the host ledger",
    spec: "Persist authoritative worker state.",
    dependsOn: [],
    status: "blocked",
    activeAttemptId: "attempt_1",
    createdAt: 1,
    updatedAt: 2,
  }],
  attempts: [{
    id: "attempt_1",
    runId: "run_1",
    taskId: "task_1",
    number: 1,
    workerChatKey: "chat:worker",
    agent: "codex",
    access: "auto",
    status: "blocked",
    cwd: "/worktree",
    branch: "feature/worker",
    isWorktree: true,
    filesModified: [],
    createdAt: 1,
    updatedAt: 2,
  }],
  gates: [{
    id: "gate_1",
    runId: "run_1",
    taskId: "task_1",
    createdByChatKey: "chat:worker",
    targetChatKey: "chat:master",
    question: "Use the durable schema?",
    options: ["Yes", "No"],
    status: "open",
    createdAt: 1,
    updatedAt: 2,
  }],
  messages: [],
};

describe("OrchestrationPanel", () => {
  it("keeps the ledger visible without decision inputs or run controls in worker chats", () => {
    const html = renderToStaticMarkup(<OrchestrationPanel
      project={{ id: "project", name: "OctiqFlow" }} coordinatorKey={null} readOnly
      initialSnapshot={snapshot} onOpenChat={() => {}} onClose={() => {}}
    />);
    expect(html).toContain("This agent chat is read-only");
    expect(html).toContain("Build the host ledger");
    expect(html).toContain("Use the durable schema?");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain(">Stop run<");
    expect(html).not.toContain(">Yes<");
  });
  it("starts a master from the current chat", () => {
    const html = renderToStaticMarkup(
      <OrchestrationPanel
        project={{ id: "project", name: "OctiqFlow", primary_path: "/repo" }}
        coordinatorKey="chat:master"
        onOpenChat={() => {}}
        onClose={() => {}}
      />,
    );

    expect(html).toContain("Start master run");
    expect(html).toContain("This chat becomes the master.");
    expect(html).toContain("Workspace mode");
    expect(html).toContain("Current checkout");
    expect(html).toContain("New worktree");
    expect(html).toContain("Automatically start ready tasks");
    expect(html).toContain('aria-modal="true"');
  });

  it("shows authoritative task state and decisions", () => {
    const html = renderToStaticMarkup(
      <OrchestrationPanel
        project={{ id: "project", name: "OctiqFlow", primary_path: "/repo" }}
        coordinatorKey="chat:master"
        initialSnapshot={snapshot}
        onOpenChat={() => {}}
        onClose={() => {}}
      />,
    );

    expect(html).toContain("Execution ledger");
    expect(html).toContain("Build the host ledger");
    expect(html).toContain("Use the durable schema?");
    expect(html).toContain("codex worker #1");
    expect(html).toContain("feature/worker");
    expect(html).not.toContain("Start retry");
  });

  it("offers a new authoritative attempt for a settled block", () => {
    const html = renderToStaticMarkup(
      <OrchestrationPanel
        project={{ id: "project", name: "OctiqFlow", primary_path: "/repo" }}
        coordinatorKey="chat:master"
        initialSnapshot={{ ...snapshot, gates: [] }}
        onOpenChat={() => {}}
        onClose={() => {}}
      />,
    );

    expect(html).toContain("This attempt settled.");
    expect(html).toContain("Start retry");
    expect(retryLaunchArgs(snapshot.tasks[0], snapshot.attempts[0])).toMatchObject({
      taskId: "task_1",
      agent: "codex",
      access: "auto",
      newWorktree: false,
    });
  });
});

const workspace: TaskWorkspace = {
  plan: { mode: "worktree", cwd: "/repo-task", checkoutRoot: "/repo-task", repositoryRoot: "/repo", branch: "feature/task", baseBranch: "main", baseSha: "a".repeat(40), managed: true, isRepo: true, warnings: [], initialStatus: "" },
  state: "retained", abandoned: false, validationPaths: [],
  delivery: { headSha: "b".repeat(40), dirty: false, hasCommits: true, pushed: true, merged: false, checkedAt: 2, notes: [] },
};
function deliveryHtml(ws: TaskWorkspace, readOnly = false) {
  return renderToStaticMarkup(<OrchestrationPanel project={{ id: "project", name: "Project" }} coordinatorKey="chat:master"
    initialSnapshot={{ ...snapshot, gates: [], tasks: [{ ...snapshot.tasks[0], status: "completed", workspace: ws }], attempts: [{ ...snapshot.attempts[0], status: "completed" }] }}
    onOpenChat={() => {}} onClose={() => {}} readOnly={readOnly} />);
}
it("keeps pushed work available for review without offering merged cleanup", () => {
  const html = deliveryHtml(workspace);
  expect(html).toContain("Pushed · awaiting review");
  expect(html).toContain("Continue after review");
  expect(html).not.toContain(">Clean up worktree<");
  expect(html).toContain("Abandon workspace");
});
it("offers cleanup only for a clean managed worktree with verified merge", () => {
  const merged = { ...workspace, delivery: { ...workspace.delivery!, merged: true } };
  expect(deliveryHtml(merged)).toContain(">Clean up worktree<");
  expect(deliveryHtml({ ...merged, delivery: { ...merged.delivery, dirty: true } })).not.toContain(">Clean up worktree<");
  expect(deliveryHtml({ ...merged, plan: { ...merged.plan, mode: "direct", managed: false } })).not.toContain(">Clean up worktree<");
});
it("keeps every workspace mutation hidden in read-only worker chats", () => {
  const html = deliveryHtml(workspace, true);
  expect(html).toContain("Pushed · awaiting review");
  for (const action of ["Refresh delivery status", "Continue after review", "Abandon workspace", "Start retry", "Reopen task"]) expect(html).not.toContain(action);
});
it("makes workspace removal distinct from a worker completing", () => {
  const html = deliveryHtml({ ...workspace, state: "cleaned", abandoned: true });
  expect(html).toContain("Abandoned · workspace removed");
  expect(html).not.toContain("Refresh delivery status");
});


describe("embedded chat runs", () => {
  it("scopes the ledger to the current chat and keeps the surrounding app visible", () => {
    const html = renderToStaticMarkup(<OrchestrationPanel embedded project={{ id: "project", name: "OctiqFlow" }} coordinatorKey="chat:other"
      initialSnapshot={snapshot} onOpenChat={() => {}} onClose={() => {}} />);
    expect(html).toContain('aria-label="Runs for this chat"');
    expect(html).not.toContain("Ship orchestration");
    expect(html).not.toContain("Build the host ledger");
    expect(html).not.toContain('aria-modal="true"');
    expect(html).not.toContain('class="panel-scrim"');
  });
  it("keeps retry records inside the original task", () => {
    const retried = { ...snapshot, tasks: [{ ...snapshot.tasks[0], activeAttemptId: "attempt_2" }],
      attempts: [...snapshot.attempts, { ...snapshot.attempts[0], id: "attempt_2", number: 2, workerChatKey: "chat:second" }] };
    const html = renderToStaticMarkup(<OrchestrationPanel embedded project={{ id: "project", name: "OctiqFlow" }} coordinatorKey="chat:master"
      initialSnapshot={retried} onOpenChat={() => {}} onClose={() => {}} />);
    expect(html).toContain("Previous attempts (1)");
    expect(html).toContain("codex worker #2");
    expect(html).toContain("codex worker #1");
    expect(html.match(/<h4>Build the host ledger<\/h4>/g)).toHaveLength(1);
  });
});

it("distinguishes notification receipt from completed work and shows retry errors", () => {
  const notification = { id: "note", runId: snapshot.runs[0].id, fromChatKey: "worker", targetChatKey: "chat:master", source: "message:one", kind: "progress", body: "update", state: "pending" as const, attempts: 1, coalesced: 2, createdAt: 1, updatedAt: 2, nextAttemptAt: 3, lastError: "Provider unavailable" };
  const html = renderToStaticMarkup(<OrchestrationPanel project={{ id: "project", name: "Project" }} coordinatorKey="chat:master" initialSnapshot={{ ...snapshot, notifications: [notification, { ...notification, id: "received", state: "acknowledged" }] }} onOpenChat={() => {}} onClose={() => {}} />);
  expect(html).toContain("Received by agent");
  expect(html).toContain("Queued");
  expect(html).toContain("Provider unavailable");
  expect(html.match(/Delivery will retry automatically/g)).toHaveLength(1);
});
