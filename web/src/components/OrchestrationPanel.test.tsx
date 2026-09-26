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
    for (const expected of ["Capacity blocked", "Latest error:", "Selected model is at capacity", "Retry 1 scheduled", "gpt-5.6-terra", "Workspace retained"]) {
      expect(html).toContain(expected);
    }
    for (const removed of ["Last activity", "Last meaningful progress", "Saved the implementation", "Current operation"]) {
      expect(html).not.toContain(removed);
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
  it("asks for plan approval in the run, and only while it is pending", () => {
    const pending = structuredClone(snapshot);
    pending.runs[0].planApproval = { status: "pending", requestedAt: 1 };
    const render = (current: OrchestrationSnapshot) => renderToStaticMarkup(<OrchestrationPanel embedded
      project={{ id: "project", name: "OctiqFlow" }} coordinatorKey={current.runs[0].coordinatorChatKey}
      initialSnapshot={current} onOpenChat={() => {}} onClose={() => {}} />);
    // Plan mode: the review stands in for the task list.
    expect(render(pending)).toContain("Approve plan");
    expect(render(pending)).toContain("The tasks start once the plan above is approved.");
    expect(render(pending)).not.toContain('<span class="orch-task-title">');
    const approved = structuredClone(pending);
    approved.runs[0].planApproval = { status: "approved", requestedAt: 1 };
    expect(render(approved)).not.toContain("Approve plan");
    expect(render(approved)).toContain('<span class="orch-task-title">Build the host ledger</span>');
  });

  it("keeps acceptance unverified even when every task has completed", () => {
    const current = structuredClone(snapshot);
    current.runs[0].status = "completed";
    current.tasks[0].status = "completed";
    current.tasks[0].result = "Review completed: NOT RELEASE-READY";
    current.attempts[0].status = "completed";
    current.gates = [];
    const html = renderToStaticMarkup(<OrchestrationPanel project={{ id: "project", name: "OctiqFlow" }} coordinatorKey="chat:master"
      initialSnapshot={current} onOpenChat={() => {}} onClose={() => {}} />);
    expect(html).toContain("1/1 tasks · Completed");
    expect(html).toContain("Acceptance: unverified");
  });

  it.each([false, true])("keeps attention and ongoing work above settled tasks (embedded: %s)", (embedded) => {
    const statuses = ["completed", "pending", "running", "cancelled", "ready", "blocked", "running", "failed", "completed"] as const;
    const current: OrchestrationSnapshot = {
      ...snapshot,
      tasks: statuses.map((status, index) => ({
        ...snapshot.tasks[0], id: `task_${index}`, title: `Task ${index}`, status, activeAttemptId: undefined,
      })),
      attempts: [], gates: [],
    };
    const before = structuredClone(current);
    const html = renderToStaticMarkup(<OrchestrationPanel embedded={embedded}
      project={{ id: "project", name: "OctiqFlow" }} coordinatorKey="chat:master"
      initialSnapshot={current} onOpenChat={() => {}} onClose={() => {}} />);

    expect([...html.matchAll(/<span class="orch-task-title">(.*?)<\/span>/g)].map((match) => match[1])).toEqual([
      "Task 5", "Task 7", "Task 2", "Task 6", "Task 4", "Task 1", "Task 0", "Task 8", "Task 3",
    ]);
    expect(current).toEqual(before);
  });

  it("promotes execution problems and moves completed or retried tasks on the next snapshot", () => {
    const current: OrchestrationSnapshot = {
      ...snapshot,
      tasks: [
        { ...snapshot.tasks[0], id: "working", title: "Working task", status: "running", activeAttemptId: undefined },
        { ...snapshot.tasks[0], title: "Stalled task", status: "running" },
        { ...snapshot.tasks[0], id: "done", title: "Completed task", status: "completed", activeAttemptId: undefined },
      ],
      attempts: [{ ...snapshot.attempts[0], status: "running", execution: { state: "stalled", retryCount: 0 } }],
      gates: [],
    };
    const titles = () => {
      const html = renderToStaticMarkup(<OrchestrationPanel embedded
        project={{ id: "project", name: "OctiqFlow" }} coordinatorKey="chat:master"
        initialSnapshot={current} onOpenChat={() => {}} onClose={() => {}} />);
      return [...html.matchAll(/<span class="orch-task-title">(.*?)<\/span>/g)].map((match) => match[1]);
    };

    expect(titles()).toEqual(["Stalled task", "Working task", "Completed task"]);
    current.tasks[1].status = "completed";
    expect(titles()).toEqual(["Working task", "Stalled task", "Completed task"]);
    current.tasks[2].status = "running";
    expect(titles()).toEqual(["Working task", "Completed task", "Stalled task"]);
  });

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
    expect(html).not.toContain(">Stop<");
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
    // The standard plan card carries the worker selection as facts.
    expect(html).toMatch(/<dt>Model<\/dt><dd><span>Claude Sonnet latest<\/span>/);
    expect(html).toMatch(/<dt>Effort<\/dt><dd><span>high<\/span>/);
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

    // One line, and no percentage: done of total is what the ledger knows.
    expect(html).toContain("<span>1/1 tasks · Completed</span>");
    expect(html).not.toMatch(/(>\s*\d+|<\/span>)\s*%/);
    expect(html).not.toContain('role="progressbar"');
    // Nothing is owed, so no attention count — rather than five reading zero.
    expect(html).not.toContain('class="orch-attention"');
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
    expect(stuck).toContain("1 task needs attention");
    expect(stuck).toContain(">1 blocked</button>");
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
  it.each([false, true])("uses the goal disclosure as the run heading, including plan review (%s)", (planning) => {
    const ledger = structuredClone(snapshot);
    if (planning) ledger.runs[0].planApproval = { status: "pending", requestedAt: 1 };
    const html = renderToStaticMarkup(<OrchestrationPanel embedded sharedHeading
      allowManualRun={false}
      project={{ id: "project", name: "OctiqFlow" }} coordinatorKey="chat:master" currentChatKey="chat:master"
      initialSnapshot={ledger} onOpenChat={() => {}} onClose={() => {}} />);
    expect(html).not.toContain("Back to main chat");
    expect(html).not.toContain('id="orch-run-title"');
    expect(html).toContain('aria-label="Ship orchestration"');
    expect(html).toContain('class="orch-run-accordion-toggle" aria-expanded="true"');
    // The plan and the open decision are one count, beside the disclosure.
    if (planning) expect(html).toMatch(/<\/button><button type="button" class="orch-attention" data-tone="decision" aria-label="2 decisions waiting. Show"/);
  });

  it("keeps manual New run in regular coding mode and run settings one click away, shut", () => {
    const html = renderToStaticMarkup(<OrchestrationPanel embedded sharedHeading
      project={{ id: "project", name: "OctiqFlow" }} coordinatorKey="chat:master" currentChatKey="chat:master"
      initialSnapshot={snapshot} onOpenChat={() => {}} onClose={() => {}} />);
    expect(html).toContain("<span>Main agent chat</span>");
    expect(html).toContain("New run");
    const toggle = html.match(/<button type="button" class="orch-settings-toggle" aria-expanded="false" aria-controls="([^"]+)"/);
    expect(toggle).not.toBeNull();
    const region = html.slice(html.indexOf(`id="${toggle![1]}"`));
    expect(html).toContain(`class="orch-run-settings" id="${toggle![1]}" role="region" aria-label="Run settings" hidden=""`);
    // The controls moved with the configuration; they are shut, not gone.
    expect(region.slice(0, region.indexOf('role="tabpanel"'))).toContain(">Stop<");
    expect(html).not.toContain("Pause automatic dispatch");
    // Not every task is done, so the acceptance caveat waits in Settings.
    expect(html).not.toContain("Acceptance: unverified");
    expect(html).toContain("<dt>Acceptance</dt>");
  });

  it("marks the worker task current without duplicating the topbar return control", () => {
    const html = renderToStaticMarkup(<OrchestrationPanel embedded sharedHeading
      allowManualRun={false}
      project={{ id: "project", name: "OctiqFlow" }} coordinatorKey="chat:master" currentChatKey="chat:worker"
      initialSnapshot={snapshot} onOpenChat={() => {}} onClose={() => {}} />);
    expect(html).toContain('aria-current="page" aria-label="Open task chat: Build the host ledger"');
    expect(html).not.toContain("Back to main chat");
  });
  it("scopes the ledger to the current chat and keeps the surrounding app visible", () => {
    const html = renderToStaticMarkup(<OrchestrationPanel embedded project={{ id: "project", name: "OctiqFlow" }} coordinatorKey="chat:other"
      initialSnapshot={snapshot} onOpenChat={() => {}} onClose={() => {}} />);
    expect(html).toContain('aria-label="Runs for this chat"');
    expect(html).not.toContain("Ship orchestration");
    expect(html).not.toContain("Build the host ledger");
    expect(html).not.toContain('aria-modal="true"');
    expect(html).not.toContain('class="panel-scrim"');
  });
  it("keeps manual creation discoverable in regular mode and uses goal accordions in agents mode", () => {
    const one = renderToStaticMarkup(<OrchestrationPanel embedded project={{ id: "project", name: "OctiqFlow" }} coordinatorKey="chat:master"
      initialSnapshot={snapshot} onOpenChat={() => {}} onClose={() => {}} />);
    expect(one).toContain("New run");
    expect(one).toContain("orch-run-list");

    const two = {
      ...snapshot,
      runs: [...snapshot.runs, { ...snapshot.runs[0], id: "run_2", objective: "Second outcome" }],
    };
    const both = renderToStaticMarkup(<OrchestrationPanel embedded project={{ id: "project", name: "OctiqFlow" }} coordinatorKey="chat:master"
      initialSnapshot={two} onOpenChat={() => {}} onClose={() => {}} />);
    expect(both).toContain("orch-run-list");
    expect(both).toContain("Second outcome");

    const agents = renderToStaticMarkup(<OrchestrationPanel embedded allowManualRun={false}
      project={{ id: "project", name: "OctiqFlow" }} coordinatorKey="chat:master"
      initialSnapshot={two} onOpenChat={() => {}} onClose={() => {}} />);
    expect(agents).not.toContain("New run");
    expect(agents).not.toContain("orch-run-list");
    expect(agents.match(/<section class="orch-run-accordion/g)).toHaveLength(2);
    expect(agents).toContain("Second outcome");
  });

  it("keeps approval attention visible on a collapsed goal and hides Settings behind options", () => {
    const planning = { ...snapshot.runs[0], id: "run_2", objective: "Second goal", status: "planning" as const,
      planApproval: { status: "pending" as const, requestedAt: 2 } };
    const ledger = { ...snapshot, runs: [snapshot.runs[0], planning] };
    const html = renderToStaticMarkup(<OrchestrationPanel embedded sharedHeading allowManualRun={false}
      project={{ id: "project", name: "OctiqFlow" }} coordinatorKey="chat:master" currentChatKey="chat:master"
      initialSnapshot={ledger} onOpenChat={() => {}} onClose={() => {}} />);
    const second = html.slice(html.indexOf("Second goal"));
    expect(second).toContain("Approval needed");
    expect(second).toContain('id="orch-goal-run_2" hidden=""');
    expect(html).toContain('aria-label="Run options"');
    expect(html).not.toContain(">Settings</span>");
    const options = html.slice(html.indexOf('aria-label="Run options"'));
    expect(options).not.toContain('aria-label="Run settings"');
    expect(options).not.toContain("<dt>Folder</dt>");
  });

  it("keeps retry records inside the original task", () => {
    const retried = { ...snapshot, tasks: [{ ...snapshot.tasks[0], activeAttemptId: "attempt_2" }],
      attempts: [...snapshot.attempts, { ...snapshot.attempts[0], id: "attempt_2", number: 2, workerChatKey: "chat:second" }] };
    const html = renderToStaticMarkup(<OrchestrationPanel embedded project={{ id: "project", name: "OctiqFlow" }} coordinatorKey="chat:master"
      initialSnapshot={retried} onOpenChat={() => {}} onClose={() => {}} />);
    expect(html).toContain("Previous attempts (1)");
    expect(html).toContain("codex worker #2");
    expect(html).toContain("codex worker #1");
    expect(html.match(/<span class="orch-task-title">Build the host ledger<\/span>/g)).toHaveLength(1);
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

describe("compact run panel", () => {
  const agents = (ledger: OrchestrationSnapshot, currentChatKey = "chat:master") => renderToStaticMarkup(<OrchestrationPanel embedded sharedHeading
    allowManualRun={false} project={{ id: "project", name: "OctiqFlow" }} coordinatorKey="chat:master" currentChatKey={currentChatKey}
    initialSnapshot={ledger} onOpenChat={() => {}} onClose={() => {}} />);

  it("keeps Main agent chat outside every goal, so it is there with them collapsed", () => {
    const html = agents(snapshot, "chat:worker");
    const toolbar = html.indexOf('role="toolbar"');
    expect(toolbar).toBeGreaterThan(-1);
    expect(toolbar).toBeLessThan(html.indexOf('class="orch-content"'));
    expect(html.slice(toolbar, html.indexOf('class="orch-content"'))).toContain("<span>Main agent chat</span>");
    // Only the main chat itself is marked as the page you are on.
    expect(html).not.toContain('aria-current="page" aria-label="Main agent chat"');
    expect(agents(snapshot)).toContain('aria-current="page" aria-label="Main agent chat"');
    expect(html).not.toContain("Back to main chat");
  });

  it("carries waiting approvals on the way to the main chat", () => {
    const html = renderToStaticMarkup(<OrchestrationPanel embedded sharedHeading allowManualRun={false} pendingApprovals={2}
      project={{ id: "project", name: "OctiqFlow" }} coordinatorKey="chat:master" currentChatKey="chat:master"
      initialSnapshot={snapshot} onOpenChat={() => {}} onClose={() => {}} />);
    expect(html).toContain('aria-label="Main agent chat, 2 approvals waiting"');
  });

  it("shows Tasks, Notifications and the coordination log as tabs, with decisions above them", () => {
    const note = { id: "note", runId: "run_1", fromChatKey: "w", targetChatKey: "chat:master", source: "s", kind: "progress", body: "b",
      state: "pending" as const, attempts: 1, coalesced: 0, createdAt: 1, updatedAt: 2 };
    const message = { id: "m", runId: "run_1", fromChatKey: "chat:worker", toChatKey: "chat:master", kind: "status", subject: "Started", body: "On it", createdAt: 1 };
    const html = agents({ ...snapshot, notifications: [note], messages: [message] } as OrchestrationSnapshot);
    expect(html).toContain('role="tablist" aria-label="Run details"');
    expect(html).toMatch(/role="tab" id="[^"]+-tasks" aria-selected="true"[^>]+tabindex="0" aria-label="Tasks, 1"/);
    expect(html).toMatch(/role="tab" id="[^"]+-notifications" aria-selected="false"[^>]+tabindex="-1" aria-label="Notifications, 1, 1 awaiting receipt"/);
    expect(html).toContain('aria-label="Coordination log, 1 message"');
    // Inactive tabs keep their content, shut.
    expect(html).toMatch(/role="tabpanel" id="[^"]+-log-panel" aria-labelledby="[^"]+-log" hidden="">.*Started/);
    expect(html.indexOf("Needs you")).toBeLessThan(html.indexOf('role="tablist"'));
    expect(html).not.toContain('<details class="orch-notifications"');
  });

  it("offers Stop without Pause, and never a percentage or a full-width bar", () => {
    const automatic = { ...snapshot, runs: [{ ...snapshot.runs[0], workerDefaults: { access: "auto" } }] };
    const html = agents(automatic);
    expect(html).toContain(">Stop</button>");
    expect(html).not.toContain("Stop run");
    expect(html).not.toContain("Pause automatic dispatch");
    expect(html).not.toContain("task-meter");
    // The header carries count and state once.
    expect(html.match(/0\/1 tasks/g)).toHaveLength(1);
  });

  it("hides archived runs behind Archived, where each can be restored", () => {
    const archived = { ...snapshot.runs[0], id: "run_old", objective: "Old goal", status: "stopped" as const, archivedAt: 9 };
    const html = agents({ ...snapshot, runs: [snapshot.runs[0], archived] });
    expect(html).not.toContain("Old goal");
    expect(html).toMatch(/aria-pressed="false"[^>]*>.*<span>Archived<\/span><span class="orch-tool-count is-quiet">1<\/span>/);
    // With only archived runs, the list is empty but the way back is not.
    const only = agents({ ...snapshot, runs: [archived] });
    expect(only).not.toContain("Old goal");
    expect(only).toContain("<span>Archived</span>");
    expect(only).toContain("<span>Main agent chat</span>");
  });

  it("offers to archive a finished run behind a confirmation, never by default", () => {
    const done = { ...snapshot, runs: [{ ...snapshot.runs[0], status: "stopped" as const }], gates: [] };
    const html = agents(done);
    expect(html).toContain(">Archive run</button>");
    expect(html).not.toContain(">Stop</button>");
    expect(html).not.toContain('type="checkbox"');
  });
});
