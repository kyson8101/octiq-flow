// Whether the page may start a task, and what it calls a task's state.
//
// One reader decides both (`lib/taskHold`): a control that would start an
// attempt is offered enabled only when the host would take the start, and a
// task something holds is never called by its ledger status alone. The
// ledgers are the host's own (`__fixtures__/host`).
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import panelSource from "../components/OrchestrationPanel.tsx?raw";
import planPanelSource from "../components/PlanPanel.tsx?raw";
import planViewSource from "./planView.ts?raw";

/** Every component file, as text: what a row draws inside its tabs is
 *  followed into the helpers that draw it. */
const componentSources = import.meta.glob("../components/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

vi.mock("./bridge", () => ({
  bridge: { invoke: async () => null, on: () => () => {}, onState: () => () => {} },
}));

import { hostFacts } from "./__fixtures__/hostFacts";
import type { OrchestrationSnapshot, TaskWorkspace } from "./orchestration";
import {
  PLAN_DETAIL, PLAN_LABEL, REOPEN_DETAIL, REOPEN_LABEL, startBlocker, startControl, statusLine, STOPPED_LABEL,
} from "./taskHold";
import { taskTabKey } from "./runPanel";
import { OrchestrationPanel } from "../components/OrchestrationPanel";

afterEach(() => vi.useRealTimers());

const panel = (snapshot: OrchestrationSnapshot) => {
  vi.useFakeTimers();
  vi.setSystemTime(Math.max(...snapshot.tasks.map((task) => task.updatedAt)) + 5_000);
  const run = snapshot.runs[0];
  return renderToStaticMarkup(<OrchestrationPanel embedded allowManualRun={false} project={{ id: run.workspaceId, name: "Project" }}
    coordinatorKey={run.coordinatorChatKey} initialSnapshot={snapshot} onOpenChat={() => {}} onClose={() => {}} />);
};
const rows = (html: string) => html.split('<article class="orch-task').slice(1).map((part) => part.slice(0, part.indexOf("</article>")));
/** Every control of a row that starts an attempt, as it is drawn. */
const starts = (row: string) => [...row.matchAll(/<button type="button" class="task-start"[^>]*>([^<]*)<\/button>/g)].map((match) => match[0]);
const control = (snapshot: OrchestrationSnapshot, index = 0) => {
  const task = snapshot.tasks[index];
  const run = snapshot.runs.find((item) => item.id === task.runId)!;
  return startControl(task, run, snapshot.tasks, snapshot.attempts.filter((attempt) => attempt.taskId === task.id), false);
};

describe("a reopened task whose notice is not confirmed", () => {
  const held = hostFacts.heldByReopen();

  it("has a next attempt the host would refuse, and the reader says so with the host's reason", () => {
    const [task] = held.tasks;
    expect(task).toMatchObject({ status: "ready", heldByReopen: true });
    expect(held.attempts[0]).toMatchObject({ id: task.activeAttemptId, status: "completed" });
    expect(startBlocker(task, held.runs[0], held.tasks)).toBe(REOPEN_DETAIL);
    expect(control(held)).toMatchObject({ kind: "next", label: "Start next attempt", attempt: held.attempts[0], blocked: REOPEN_DETAIL });
  });

  it("is never called Ready in its details, and its ledger status is said as the ledger's beside what holds it", () => {
    const [row] = rows(panel(held));
    expect(row).not.toMatch(/>Task: Ready</);
    expect(row).not.toMatch(/>Ready(?: to start)?</);
    expect(row).toContain(`<p class="orch-task-ledger">Task: ${REOPEN_LABEL} · ledger status: Ready</p>`);
    expect(statusLine(held.tasks[0], REOPEN_LABEL)).toBe(`Task: ${REOPEN_LABEL} · ledger status: Ready`);
  });

  it("offers Start next attempt switched off, with the reason beside it", () => {
    const [row] = rows(panel(held));
    const [button, ...more] = starts(row);
    expect(more).toEqual([]);
    expect(button).toContain(">Start next attempt</button>");
    expect(button).toContain('aria-disabled="true"');
    const why = /aria-describedby="([^"]+)"/.exec(button)![1];
    expect(row).toContain(`<span id="${why}" class="task-start-why">${REOPEN_DETAIL.replace(/'/g, "&#x27;")}</span>`);
  });

  it("offers it enabled once the notice is confirmed", () => {
    const told = hostFacts.reopenNoticeDelivered();
    expect(control(told)).toMatchObject({ kind: "next", blocked: null });
    const [button] = starts(rows(panel(told))[0]);
    expect(button).toContain(">Start next attempt</button>");
    expect(button).not.toContain("aria-disabled");
    expect(rows(panel(told))[0]).toContain('<p class="orch-task-ledger">Ledger status: Ready</p>');
  });
});

describe("a task the plan holds", () => {
  it("has no start while it never ran: there is no attempt to retry", () => {
    const snapshot = hostFacts.planAfterFailed();
    expect(snapshot.tasks[1]).toMatchObject({ status: "ready", heldByPlan: true });
    expect(control(snapshot, 1)).toBeNull();
    expect(startBlocker(snapshot.tasks[1], snapshot.runs[0], snapshot.tasks)).toBe(PLAN_DETAIL);
  });

  it("does not hold the approved task beside it, whose retry the host starts", () => {
    for (const snapshot of [hostFacts.planAfterFailed(), hostFacts.planAfterBlocked()]) {
      expect(control(snapshot)).toMatchObject({ kind: "retry", label: "Start retry", blocked: null });
      const [button] = starts(rows(panel(snapshot))[0]);
      expect(button).toContain(">Start retry</button>");
      expect(button).not.toContain("aria-disabled");
    }
  });

  it("switches a failed task's retry off when the host says the plan holds it", () => {
    // Changed for this test: A changed hands after it failed, so its
    // approval was cleared and the host says the plan holds it.
    const snapshot = hostFacts.planAfterFailed();
    delete snapshot.tasks[0].approvedAt;
    snapshot.tasks[0].heldByPlan = true;
    expect(control(snapshot)).toMatchObject({ kind: "retry", blocked: PLAN_DETAIL });
    const [button] = starts(rows(panel(snapshot))[0]);
    expect(button).toContain('aria-disabled="true"');
  });

  it("keeps a mission's retry off while its plan is pending on a host that does not say what the plan holds", () => {
    // Changed for this test: a mission, and no task carries `heldByPlan`.
    const snapshot = hostFacts.planAfterFailed();
    snapshot.runs[0].workspaceMode = "mission";
    for (const task of snapshot.tasks) delete task.heldByPlan;
    expect(control(snapshot)).toMatchObject({ kind: "retry", blocked: PLAN_DETAIL });
    snapshot.runs[0].workspaceMode = "auto";
    expect(control(snapshot)).toMatchObject({ kind: "retry", blocked: null });
  });
});

describe("a task the person stopped", () => {
  it("has one way back, their own Start of the attempt they stopped", () => {
    const { snapshot } = hostFacts.taskStopped();
    const index = snapshot.tasks.findIndex((task) => task.stopped);
    const task = snapshot.tasks[index];
    expect(control(snapshot, index)).toMatchObject({ kind: "again", label: "Start it again", blocked: null, attempt: { id: task.stopped!.attemptId } });
    const row = rows(panel(snapshot)).find((item) => item.includes('data-hold="stopped"'))!;
    const buttons = starts(row);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toContain(">Start it again</button>");
    expect(buttons[0]).not.toContain("aria-disabled");
  });

  it("is said as stopped in its details, never as Failed alone", () => {
    const { snapshot } = hostFacts.taskStopped();
    const row = rows(panel(snapshot)).find((item) => item.includes('data-hold="stopped"'))!;
    expect(row).not.toMatch(/>Task: Failed</);
    expect(row).toContain(`<p class="orch-task-ledger">Task: ${STOPPED_LABEL} · ledger status: Failed</p>`);
  });

  it("has that Start switched off while the plan holds it or its reopen is not told", () => {
    // Changed for this test: the stopped task was put back on the plan.
    const planned = hostFacts.planAfterStopped();
    planned.tasks[0].heldByPlan = true;
    expect(control(planned)).toMatchObject({ kind: "again", blocked: PLAN_DETAIL });
    const [button] = starts(rows(panel(planned)).find((item) => item.includes(">Start it again<"))!);
    expect(button).toContain('aria-disabled="true"');
    // Changed for this test: it was reopened and the notice is not saved.
    const reopened = hostFacts.planAfterStopped();
    reopened.tasks[0].heldByReopen = true;
    expect(control(reopened)).toMatchObject({ kind: "again", blocked: REOPEN_DETAIL });
  });

  it("has no start at all in a run that takes none", () => {
    for (const status of ["stopped", "closed", "completed"] as const) {
      const snapshot = hostFacts.planAfterStopped();
      snapshot.runs[0].status = status;
      expect(control(snapshot)).toBeNull();
    }
    const archived = hostFacts.planAfterStopped();
    archived.runs[0].archivedAt = 1;
    expect(control(archived)).toBeNull();
  });
});

describe("a task that was replaced, or is parked on a decision", () => {
  it("offers its retry switched off and names what replaced it", () => {
    // Changed for this test: B replaced the failed A.
    const snapshot = hostFacts.planAfterFailed();
    snapshot.tasks[0].supersededBy = snapshot.tasks[1].id;
    expect(control(snapshot)).toMatchObject({ kind: "retry" });
    expect(control(snapshot)!.blocked).toBe('This task was replaced by "Implement" and no longer starts. Start that task instead; this one keeps its history.');
  });

  it("offers nothing while an open decision holds the blocked task", () => {
    const snapshot = hostFacts.planAfterBlocked();
    const [task] = snapshot.tasks;
    expect(startControl(task, snapshot.runs[0], snapshot.tasks, snapshot.attempts, true)).toBeNull();
  });
});

describe("the ledger's status in a task's details", () => {
  it("is always said as the ledger's, and is led by the hold when something holds the task", () => {
    const [task] = hostFacts.reopenNoticeDelivered().tasks;
    expect(statusLine(task, null)).toBe("Ledger status: Ready");
    expect(statusLine({ status: "running" }, null)).toBe("Ledger status: Working");
    expect(statusLine({ status: "failed" }, STOPPED_LABEL)).toBe(`Task: ${STOPPED_LABEL} · ledger status: Failed`);
    expect(statusLine({ status: "ready" }, PLAN_LABEL)).toBe(`Task: ${PLAN_LABEL} · ledger status: Ready`);
  });
});

/** An opened row in its three parts: what stands above the tabs, and what
 *  each tab holds. */
const parts = (row: string) => {
  const tabs = row.indexOf('role="tablist"');
  const steps = row.indexOf('role="tabpanel"');
  const details = row.indexOf('role="tabpanel"', steps + 1);
  expect(tabs).toBeGreaterThan(-1);
  expect(details).toBeGreaterThan(steps);
  return { above: row.slice(row.indexOf('class="orch-task-detail"'), tabs), steps: row.slice(steps, details), details: row.slice(details) };
};

describe("an opened row's tabs", () => {
  const ledgers: [string, () => OrchestrationSnapshot, string][] = [
    ["a next attempt the host would refuse", hostFacts.heldByReopen, "Start next attempt"],
    ["a next attempt it would take", hostFacts.reopenNoticeDelivered, "Start next attempt"],
    ["a retry", hostFacts.planAfterFailed, "Start retry"],
    ["a retry of a blocked task", hostFacts.planAfterBlocked, "Start retry"],
    ["the person's own Start", () => hostFacts.taskStopped().snapshot, "Start it again"],
  ];

  it.each(ledgers)("keep %s above both, in neither", (_name, ledger, label) => {
    const row = rows(panel(ledger())).find((item) => item.includes(`>${label}</button>`))!;
    const { above, steps, details } = parts(row);
    // The one start, with its reason when it is switched off, stands above
    // the tablist: on screen whichever tab is open.
    expect(starts(above)).toHaveLength(1);
    expect(starts(above)[0]).toContain(`>${label}</button>`);
    const why = /aria-describedby="([^"]+)"/.exec(starts(above)[0])?.[1];
    if (why) expect(above).toContain(`<span id="${why}" class="task-start-why">`);
    for (const tab of [steps, details]) {
      expect(tab).not.toContain("task-start");
      expect(tab).not.toContain("orch-attempt-retry");
    }
  });

  it("keep a hold's sentence above both", () => {
    for (const ledger of [hostFacts.heldByReopen(), hostFacts.taskStopped().snapshot]) {
      const row = rows(panel(ledger)).find((item) => item.includes('class="orch-task-hold"'))!;
      const { above, steps, details } = parts(row);
      expect(above).toContain('class="orch-task-hold"');
      expect(steps + details).not.toContain("orch-task-hold");
    }
  });

  it("keep the decision a task waits on above both", () => {
    // Changed for this test: an open gate on the blocked task.
    const snapshot = hostFacts.planAfterBlocked();
    const [task] = snapshot.tasks;
    snapshot.gates = [{
      id: "gate_x", runId: task.runId, taskId: task.id, createdByChatKey: "chat:w", targetChatKey: "chat:m",
      question: "Use the durable schema?", options: [], status: "open", awaits: "person", createdAt: 1, updatedAt: 2,
    }];
    const row = rows(panel(snapshot)).find((item) => item.includes("Use the durable schema?"))!;
    const { above, steps, details } = parts(row);
    expect(above).toContain('<p class="orch-task-blocker orch-task-gate">Waiting on a decision: Use the durable schema?</p>');
    expect(steps + details).not.toContain("Use the durable schema?");
  });

  it("put nothing that sends a start, an answer or a stop only inside a tab", () => {
    // What the two panels hold in the source: between the tablist and the
    // end of the row's detail there is no start and no decision's answer,
    // and none in any helper drawn there (`inTabs`, below).
    expect(sentFromTabs(panelSource)).toEqual([]);
    const from = panelSource.indexOf('className="orch-task-tabs"');
    expect(from).toBeGreaterThan(-1);
    // The one place a row draws its starts is above that.
    expect(panelSource.slice(0, from).match(/<StartButton /g)).toHaveLength(2);
    expect(panelSource.match(/<StartButton /g)).toHaveLength(2);
  });

  it("remember the press that switched them, and drop a held key", () => {
    // Switching changes what is under the pointer, so a tab's press is
    // remembered by the cards' guard like a disclosure's: one that repeats
    // it cannot land on a start.
    expect(panelSource).toMatch(/className="orch-task-tab"\s+onClick=\{\(event\) => \{\s*notePress\(event\);\s*setTab\(key\);/);
    // Keys go through the one reader, which moves a held key once.
    expect(panelSource).toMatch(/role="tablist"[^>]*onKeyDown=\{onTabKey\}/);
    expect(panelSource).toMatch(/const \{ to, drop \} = taskTabKey\(tab, event\);\s*if \(drop\) event\.preventDefault\(\);\s*if \(!to\) return;/);
    for (const key of ["Enter", " ", "Spacebar", "ArrowRight", "ArrowLeft", "Home", "End"]) {
      expect(taskTabKey("steps", { key, repeat: true }), key).toEqual({ to: null, drop: true });
      expect(taskTabKey("details", { key, repeat: true }), key).toEqual({ to: null, drop: true });
    }
    // A key pressed once on a tab is the browser's to turn into its click.
    expect(taskTabKey("steps", { key: "Enter", repeat: false })).toEqual({ to: null, drop: false });
    expect(taskTabKey("steps", { key: " ", repeat: false })).toEqual({ to: null, drop: false });
    // Tab leaves the tablist, held or not.
    expect(taskTabKey("steps", { key: "Tab", repeat: true })).toEqual({ to: null, drop: false });
  });
});

/** The source of everything an opened row draws inside its two tabs: the
 *  row's own JSX from the tablist to its end, then the body of every
 *  component drawn there, and of every component those draw. A helper of
 *  the panel's own file is cut out of it by name; one in a file of its own
 *  is that file. Stopping at the row's `</article>` was how the delivery
 *  actions, which a helper drew, were missed. */
function inTabs(source: string): { text: string; components: string[] } {
  const from = source.indexOf('className="orch-task-tabs"');
  const own = source.slice(from, source.indexOf("</article>", from));
  /** A component of the panel's file: from its `function Name(` to the next
   *  thing declared at the start of a line. */
  const local = (name: string) => {
    const at = source.search(new RegExp(`^(?:export )?function ${name}\\(`, "m"));
    if (at < 0) return null;
    const rest = source.slice(at + 1);
    const end = rest.search(/^(?:export )?(?:function|const|type) /m);
    return source.slice(at, end < 0 ? undefined : at + 1 + end);
  };
  const seen = new Map<string, string>();
  const follow = (text: string) => {
    for (const [, name] of text.matchAll(/<([A-Z][A-Za-z]+)\b/g)) {
      if (seen.has(name)) continue;
      const body = local(name) ?? componentSources[`../components/${name}.tsx`] ?? null;
      if (body === null) continue;
      seen.set(name, body);
      follow(body);
    }
  };
  follow(own);
  return { text: [own, ...seen.values()].join("\n"), components: [...seen.keys()].sort() };
}

/** What the tabs hold that sends something: a start, a command of the
 *  ledger's by name, or a call of one of the row's senders. The one sender
 *  allowed there is counted by `archiveControl` below. */
function sentFromTabs(source: string): string[] {
  const { text } = inTabs(source);
  return [
    ...text.matchAll(/<StartButton\b|"orchestration_[a-z_]+"|\bon(?:Workspace)?Action\(|\bonRetry\(|\bbridge\.invoke\b/g),
  ].map((match) => match[0]);
}

describe("what decides a task's workspace", () => {
  // Hand-written from `TaskWorkspace`: the host's fixtures hold no task with
  // a managed worktree and a delivery. A check that settled, in a worktree
  // that is pushed and clean.
  const retained = (merged: boolean, validationPaths: string[] = []): TaskWorkspace => ({
    plan: {
      mode: "worktree", cwd: "/test/tree", checkoutRoot: "/test/tree", repositoryRoot: "/test", branch: "feature/probe",
      baseBranch: "develop", baseSha: "12345678", managed: true, isRepo: true, warnings: [], initialStatus: "",
    },
    state: "retained", abandoned: false, validationPaths,
    delivery: { headSha: "abcdef12345678", dirty: false, hasCommits: true, pushed: true, merged, checkedAt: 1, notes: [] },
  });
  const settled = (workspace: TaskWorkspace) => {
    const snapshot = hostFacts.planAfterCheckFailed();
    expect(snapshot.tasks[0]).toMatchObject({ status: "completed" });
    snapshot.tasks[0].workspace = workspace;
    return rows(panel(snapshot))[0];
  };
  const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)/g)].map((match) => match[1]);

  it("is a row of buttons above both tabs, and no button of either", () => {
    for (const [merged, labels] of [
      [false, ["Refresh delivery status", "Continue after review", "Abandon workspace…"]],
      [true, ["Refresh delivery status", "Clean up worktree"]],
    ] as const) {
      const { above, steps, details } = parts(settled(retained(merged)));
      const row = /<div class="orch-delivery-actions"[^>]*>(.*?)<\/div>/.exec(above)?.[1] ?? "";
      expect(buttons(row)).toEqual(labels);
      // It follows the start's place and comes before the tablist.
      expect(above.indexOf("orch-delivery-actions")).toBeGreaterThan(above.indexOf("orch-task-meta"));
      for (const tab of [steps, details]) {
        expect(tab).not.toContain("orch-delivery-actions");
        for (const label of ["Refresh delivery status", "Continue after review", "Clean up worktree", "Abandon workspace", "Reopen task", "Confirm removal", "Remove validation checkout"]) {
          expect(buttons(tab).filter((text) => text.includes(label)), label).toEqual([]);
        }
      }
      // The facts stay in Details: the delivery's word, the path, what git said.
      expect(details).toMatch(merged ? /<summary><span>Delivery<\/span><strong>Merged/ : /<summary><span>Delivery<\/span><strong>Pushed · awaiting review<\/strong>/);
      expect(details).toContain("<code title=\"/test/tree\">");
      expect(details).toContain("abcdef12");
    }
  });

  it("removes a validation checkout from that row, named by its path when there are several", () => {
    const one = parts(settled(retained(false, ["/tmp/octiq-validation-1"])));
    expect(buttons(one.above)).toContain("Remove validation checkout");
    expect(one.details).toContain("Validation: <code>/tmp/octiq-validation-1</code>");
    expect(one.details).not.toContain("Remove validation checkout");
    const two = parts(settled(retained(false, ["/tmp/octiq-validation-1", "/tmp/octiq-validation-2"])));
    expect(two.above.match(/Remove validation checkout/g)).toHaveLength(2);
    expect(two.above).toContain("octiq-validation-2</code>");
  });

  it("offers nothing for a worktree already removed", () => {
    const gone = retained(true);
    gone.state = "cleaned";
    expect(settled(gone)).not.toContain("orch-delivery-actions");
  });

  it("is found by the scan through the helpers the tabs draw", () => {
    // The scan reads the tabs' own JSX and every component drawn in them.
    const { components } = inTabs(panelSource);
    expect(components).toEqual(expect.arrayContaining(["PeerHelpLog", "ProposedReportNote", "TaskLifecycleEvidence", "TaskPlanCard", "WorkerExecutionEvidence", "WorkspaceDelivery"]));
    expect(components).not.toContain("DeliveryActions");
    expect(sentFromTabs(panelSource)).toEqual([]);
    // The one sender the tabs keep: hiding a worker's chat from the list
    // and bringing it back, which starts, stops and removes nothing and is
    // undone by the same button. Counted, so a third is a decision.
    expect(inTabs(panelSource).text.match(/\barchiveControl\(/g)).toHaveLength(2);
  });

  it("fails that scan when one of its controls is put back inside a tab", () => {
    // The row of actions moved from above the tablist into Details.
    const element = /\{task\.workspace && !readOnly && <DeliveryActions [\s\S]*?\/>\}\n/.exec(panelSource)![0];
    const moved = panelSource.replace(element, "").replace("<TaskPlanCard task={task}", `${element}<TaskPlanCard task={task}`);
    expect(moved).not.toBe(panelSource);
    expect(sentFromTabs(moved)).toEqual(expect.arrayContaining(['"orchestration_task_reopen"', '"orchestration_workspace_cleanup"', '"orchestration_validation_remove"']));
    // A button sending a cleanup written straight into the helper that
    // draws the facts, which is where they were.
    const helper = panelSource.replace(
      "{delivery?.notes.map((note) => <p key={note}>{note}</p>)}",
      `{delivery?.notes.map((note) => <p key={note}>{note}</p>)}<button onClick={() => onAction("orchestration_workspace_cleanup", {})}>Confirm removal</button>`,
    );
    expect(helper).not.toBe(panelSource);
    expect(sentFromTabs(helper)).toEqual(["onAction(", '"orchestration_workspace_cleanup"']);
    // A second start, drawn in Steps.
    const start = panelSource.replace('<ol className="orch-task-steps"', '<StartButton start={start!} busy={busy} onStart={begin} /><ol className="orch-task-steps"');
    expect(sentFromTabs(start)).toEqual(["<StartButton"]);
    // The scan that stopped at the row's end saw none of the first two.
    const stopsAtRow = (source: string) => {
      const from = source.indexOf('className="orch-task-tabs"');
      return /orchestration_(worker_start|gate_resolve|plan_approve|task_stop)|<StartButton/.test(source.slice(from, source.indexOf("</article>", from)));
    };
    expect(stopsAtRow(moved)).toBe(false);
    expect(stopsAtRow(helper)).toBe(false);
  });

  it("guards each control that opens a question or answers one", () => {
    // The three that open a question are replaced where they stand by it,
    // so their press is remembered.
    expect(panelSource.match(/className="orch-delivery-opener" onClick=\{\(event\) => \{ notePress\(event\); setAsking\("(reopen|merged|abandon)"\); \}\}/g)).toHaveLength(3);
    // The way out of a question brings the row back under the pointer.
    expect(panelSource.match(/className="orch-delivery-keep" onClick=\{\(event\) => \{ notePress\(event\); onCancel\(\); \}\}/g)).toHaveLength(2);
    // The two answers that reopen or remove: a held key is dropped, and a
    // press that repeats the one the question was opened with.
    expect(panelSource).toMatch(/className="orch-delivery-go" disabled=\{busy \|\| !spec\.trim\(\)\} onKeyDown=\{careful\.keys\} onClick=\{careful\.confirm\}>Reopen task in this workspace</);
    expect(panelSource).toMatch(/className="orch-delivery-go" disabled=\{busy \|\| !allowed\} onClick=\{careful\.confirm\}>Confirm removal</);
    expect(panelSource).toMatch(/className="orch-cleanup-confirm"[^>]*\n\s*onKeyDown=\{\(event\) => \{ careful\.keys\(event\);/);
    expect(panelSource.match(/const careful = useCarefulAnswer\(/g)).toHaveLength(2);
    // A question puts the focus on its safe answer: the box, where Enter is
    // a new line, and `Keep worktree`.
    expect(panelSource).toMatch(/useEffect\(\(\) => \{ box\.current\?\.focus\(\); \}, \[\]\);/);
    expect(panelSource).toMatch(/useEffect\(\(\) => \{ keep\.current\?\.focus\(\); \}, \[\]\);/);
    expect(panelSource).toMatch(/<button ref=\{keep\} type="button" className="orch-delivery-keep"/);
    // Removing a validation checkout has no question: a held key is dropped.
    expect(panelSource).toMatch(/onKeyDown=\{dropHeld\}\s*onClick=\{\(\) => onAction\("orchestration_validation_remove"/);
    // One place sends each.
    for (const command of ["orchestration_task_reopen", "orchestration_workspace_cleanup", "orchestration_validation_remove", "orchestration_workspace_refresh"]) {
      expect(panelSource.match(new RegExp(`"${command}"`, "g")), command).toHaveLength(1);
    }
  });
});

describe("every control that starts an attempt", () => {
  it("is drawn by the one component that asks the reader", () => {
    // One place sends the start, and one place calls it.
    expect(panelSource.match(/"orchestration_worker_start"/g)).toHaveLength(1);
    expect(panelSource.match(/onRetry\(/g)).toHaveLength(1);
    expect(panelSource).toMatch(/const start = startControl\(/);
    // No label of a start is written anywhere but the reader.
    expect(panelSource).not.toMatch(/>Start (retry|next attempt|it again)</);
    expect(panelSource).not.toMatch(/"Start (retry|next attempt|it again)"/);
  });

  it("is not the Plan panel's Start, which starts a plan and no attempt", () => {
    // The person's Start on a chat's plan (`chat_plan_start`) hands the
    // agent a turn; the tasks it then creates are started through the run
    // panel's door like any other. The panel sends no worker start, offers
    // no start of an attempt, and its one label comes from its own reader
    // (`planView.planStart`), which asks the host's `awaitsStart`.
    expect(planPanelSource).not.toMatch(/orchestration_worker_start|onRetry|startControl\(|task-start/);
    expect(planPanelSource).not.toMatch(/>Start(?: [a-z ]+)?<|"Start(?: [a-z ]+)?"|>Tell the agent<|"Tell the agent"/);
    expect(planPanelSource.match(/className="cplan-start"/g)).toHaveLength(1);
    expect(planPanelSource).toMatch(/className="cplan-start"[\s\S]{0,160}?>\{start\.label\}<\/button>/);
    expect(planViewSource).toMatch(/if \(!plan\.awaitsStart\) return /);
    expect(planViewSource.match(/label: "Start"/g)).toHaveLength(2); // the type, and the one place it is made
  });
});
