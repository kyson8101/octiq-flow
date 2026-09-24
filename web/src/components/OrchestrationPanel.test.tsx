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
import { boardCounts, EXECUTION_LABELS } from "../lib/agentTaskBoard";
import type { ExecutionState } from "../lib/orchestration";
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

describe("host execution evidence", () => {
  it("shows a dispatch capacity failure without a worker report or an active-work count", () => {
    const failed = structuredClone(snapshot);
    failed.gates = [];
    failed.attempts[0].status = "failed";
    failed.attempts[0].execution = {
      state: "capacity_blocked", lastActivityAt: 1000, lastProgressAt: 500,
      lastProgress: "Saved the implementation", currentOperation: null, retryCount: 0,
      nextRetryAt: 6000, retryModel: "gpt-5.6-terra",
      latestError: { kind: "capacity", message: "Selected model is at capacity", at: 1000, retryable: true },
    };
    const html = renderToStaticMarkup(<OrchestrationPanel project={{ id: "project", name: "OctiqFlow" }} coordinatorKey="chat:master"
      initialSnapshot={failed} onOpenChat={() => {}} onClose={() => {}} />);
    for (const expected of ["Capacity blocked", "Last activity", "Last meaningful progress", "Saved the implementation", "Current operation", "Latest error:", "Selected model is at capacity", "Retry 1 scheduled", "gpt-5.6-terra", "Workspace retained"]) {
      expect(html).toContain(expected);
    }
    expect(html).not.toContain("of 4 working");
    expect(html).not.toContain("Reported checklist");
    expect(boardCounts(failed.tasks, failed)).toMatchObject({ running: 0, blocked: 1 });
  });

  it.each(Object.keys(EXECUTION_LABELS) as ExecutionState[])("keeps task outcome separate from %s execution", (state) => {
    const current = structuredClone(snapshot);
    current.gates = [];
    current.tasks[0].status = "running";
    current.attempts[0].status = "running";
    current.attempts[0].execution = { state, retryCount: 0 };
    const html = renderToStaticMarkup(<OrchestrationPanel project={{ id: "project", name: "OctiqFlow" }} coordinatorKey="chat:master"
      initialSnapshot={current} onOpenChat={() => {}} onClose={() => {}} />);
    expect(html).toContain(EXECUTION_LABELS[state]);
    expect(html).toContain("Task: Working");
    if (["capacity_blocked", "stalled", "disconnected", "retrying"].includes(state)) expect(boardCounts(current.tasks, current).running).toBe(0);
  });
});

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
    expect(html).toContain("main agent chooses a suitable worker");
    expect(html).toContain("Fable and Astra are reserved for orchestration");
    expect(html).not.toContain('aria-label="Worker provider"');
    expect(html).toContain('aria-modal="true"');
  });

  it("shows the main agent's task model selection with automatic dispatch", () => {
    const html = renderToStaticMarkup(<OrchestrationPanel
      project={{ id: "project", name: "OctiqFlow" }} coordinatorKey="chat:master"
      initialSnapshot={{ ...snapshot,
        runs: [{ ...snapshot.runs[0], workerDefaults: { access: "auto" } }],
        tasks: [{ ...snapshot.tasks[0], worker: { agent: "claude", model: "sonnet", effort: "high", access: "auto" } }],
      }} onOpenChat={() => {}} onClose={() => {}} />);
    expect(html).toContain("Chosen per task by the main agent");
    expect(html).toContain("Selected worker: Claude · Sonnet latest · high effort");
    expect(html).not.toContain("Automatic · undefined");
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

    expect(html).toContain("Tasks");
    expect(html).toContain("Build the host ledger");
    expect(html).toContain("Use the durable schema?");
    expect(html).toContain("codex worker #1");
    expect(html).toContain("feature/worker");
    expect(html).not.toContain("Start retry");
  });

  it("keeps the worker's brief out of the default view", () => {
    const html = renderToStaticMarkup(
      <OrchestrationPanel
        project={{ id: "project", name: "OctiqFlow", primary_path: "/repo" }}
        coordinatorKey="chat:master"
        initialSnapshot={snapshot}
        onOpenChat={() => {}}
        onClose={() => {}}
      />,
    );

    // The spec is the instruction block written FOR the worker, and runs to
    // tens of thousands of characters. It stays available and stays shut.
    expect(html).toContain('<details class="orch-task-brief"><summary>Brief</summary>');
    expect(html).toContain("Persist authoritative worker state.");
    expect(html).not.toContain('class="orch-task-brief" open');
    // Line one already says "Blocked"; the meta line must not repeat it.
    expect(html).not.toContain('class="orch-task-stage"');
  });

  it("leaves out every count that is zero", () => {
    const settled: OrchestrationSnapshot = {
      ...snapshot,
      runs: [{ ...snapshot.runs[0], status: "completed" }],
      tasks: [{ ...snapshot.tasks[0], status: "completed" }],
      attempts: [{ ...snapshot.attempts[0], status: "completed", finishedAt: 3 }],
      gates: [],
    };
    const html = renderToStaticMarkup(
      <OrchestrationPanel project={{ id: "project", name: "OctiqFlow" }} coordinatorKey="chat:master"
        initialSnapshot={settled} onOpenChat={() => {}} onClose={() => {}} />,
    );

    expect(html).toContain("<strong>1<span> / 1 tasks</span></strong>");
    expect(html).toContain("100%");
    // Nothing is owed, so no chip row at all — rather than five reading zero.
    expect(html).not.toContain("orch-progress-chips");
    for (const gone of ["working", "decision waiting", "needs attention", "queued", "cancelled"]) {
      expect(html).not.toContain(gone);
    }
    // The worker limit is configuration, not status: it moved out of the tiles.
    expect(html).toContain("<dt>Worker limit</dt>");
  });

  it("counts a task waiting on a decision once", () => {
    // The fixture's one task is blocked BY the open gate. Naming it as both a
    // waiting decision and a task needing attention reads as two problems.
    const html = renderToStaticMarkup(
      <OrchestrationPanel project={{ id: "project", name: "OctiqFlow" }} coordinatorKey="chat:master"
        initialSnapshot={snapshot} onOpenChat={() => {}} onClose={() => {}} />,
    );
    expect(html).toContain("1 decision waiting");
    expect(html).not.toContain("needs attention");

    // Blocked with no gate to explain it is the case that does need naming.
    const stuck = renderToStaticMarkup(
      <OrchestrationPanel project={{ id: "project", name: "OctiqFlow" }} coordinatorKey="chat:master"
        initialSnapshot={{ ...snapshot, gates: [] }} onOpenChat={() => {}} onClose={() => {}} />,
    );
    expect(stuck).toContain("1 needs attention");
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
it("says where the work got to in plain words, and hides the machinery behind them", () => {
  const unchecked = deliveryHtml({ ...workspace, delivery: null });
  expect(unchecked).toContain("Not checked yet");
  expect(unchecked).not.toContain("Workspace retained");
  expect(deliveryHtml({ ...workspace, delivery: { ...workspace.delivery!, merged: true } })).toContain("<strong>Merged</strong>");
  expect(deliveryHtml({ ...workspace, delivery: { ...workspace.delivery!, pushed: false } })).toContain("Committed, not pushed");
  // The absolute worktree path is a tooltip, never five wrapped lines of row.
  const pushed = deliveryHtml({ ...workspace, plan: { ...workspace.plan, cwd: "/Users/someone/code/project/.worktrees/Thing/feature/octiq-cc2541144f174ad492ba768b5b5671c1" } });
  expect(pushed).toContain("…/feature/octiq-cc2541144f174ad492ba768b5b5671c1<");
  expect(pushed).not.toContain(">/Users/someone/code/project/.worktrees");
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
  it("drops the run picker when the chat has only one run", () => {
    const one = renderToStaticMarkup(<OrchestrationPanel embedded project={{ id: "project", name: "OctiqFlow" }} coordinatorKey="chat:master"
      initialSnapshot={snapshot} onOpenChat={() => {}} onClose={() => {}} />);
    expect(one).toContain("New run");
    expect(one).not.toContain("orch-run-list");

    const two = {
      ...snapshot,
      runs: [...snapshot.runs, { ...snapshot.runs[0], id: "run_2", objective: "Second outcome" }],
    };
    const both = renderToStaticMarkup(<OrchestrationPanel embedded project={{ id: "project", name: "OctiqFlow" }} coordinatorKey="chat:master"
      initialSnapshot={two} onOpenChat={() => {}} onClose={() => {}} />);
    expect(both).toContain("orch-run-list");
    expect(both).toContain("Second outcome");
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
