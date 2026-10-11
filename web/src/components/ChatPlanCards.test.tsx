import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovedPlan, ChatPlanCards, RejectedPlan } from "./ChatPlanCards";
import { PlanReview } from "./PlanReview";
import { chatPlans } from "../lib/chatPlans";
import type { OrchestrationRun, OrchestrationSnapshot, OrchestrationTask, PlanApproval } from "../lib/orchestration";

const run = (id: string, planApproval: PlanApproval): OrchestrationRun => ({
  id, objective: "Ship", coordinatorChatKey: "chat:lead", workspaceId: "p", rootPath: "/r/app",
  status: "running", maxConcurrent: 1, createdAt: 1, updatedAt: 1, planApproval,
});
const task = (id: string, runId: string, extra: Partial<OrchestrationTask> = {}): OrchestrationTask => ({
  id, runId, title: `Task ${id}`, spec: "", dependsOn: [], status: "pending", createdAt: 1, updatedAt: 1, ...extra,
});
const render = (runs: OrchestrationRun[], tasks: OrchestrationTask[], drafting = false, startOpen = false) => renderToStaticMarkup(
  <ChatPlanCards plans={chatPlans({ runs, tasks, attempts: [], gates: [], messages: [], notifications: [] } as unknown as OrchestrationSnapshot, "chat:lead")}
    drafting={drafting} startOpen={startOpen} />);
/** The same cards with their one disclosure open. */
const renderOpen = (runs: OrchestrationRun[], tasks: OrchestrationTask[]) => render(runs, tasks, false, true);

describe("ChatPlanCards", () => {
  const waiting = [run("run_2278aa", { status: "pending", requestedAt: 1, revision: 3 })];
  const itsTasks = [
    task("a", "run_2278aa", {
      assignee: { id: "mango", name: "Mango Juice" },
      worker: { agent: "claude", access: "auto", model: "opus", effort: "high" },
      destination: { projectId: "octiq", projectName: "octiq-flow", repository: "/src/octiq-flow" },
      card: { problem: "Plans live outside the chat.", goal: "Show them in it.", acceptance: ["Card in chat"] },
    }),
    task("b", "run_2278aa", { assignee: { id: "kiwi", name: "Kiwi" }, spec: "Write the tests.\nRun them twice." }),
    task("c", "run_2278aa", { dependsOn: ["a", "b"], assignee: { id: "mango", name: "Mango Juice" } }),
  ];

  it("draws a waiting plan folded: named and versioned, each stage on one line, and the answers", () => {
    const html = render(waiting, itsTasks);
    expect(html).toContain('data-plan="run_2278aa"');
    expect(html).toContain('data-revision="3"');
    expect(html).toContain('data-folds="true"');
    expect(html).toContain("Plan 2278 · revision 3");
    expect(html).toContain("3 tasks in 2 stages");
    expect(html).toContain("Plan ready for review");
    // A stage: how many tasks, who does them, where they land.
    expect(html).toContain('<span class="plan-stage-title">Starts on approval</span>'
      + '<span class="plan-stage-note plan-stage-sum">2 tasks · Mango Juice, Kiwi · octiq-flow, app</span>');
    expect(html).toContain('<span class="plan-stage-title">After stage 1</span>'
      + '<span class="plan-stage-note plan-stage-sum">1 task · Mango Juice · app</span>');
    // The task rows and what the lead wrote are behind the one control.
    expect(html).not.toContain("plan-task");
    expect(html).not.toContain("Plans live outside the chat.");
    expect(html).not.toContain("Write the tests.");
    // One control, in the heading, that names the box under each stage and
    // the line on answering in chat; each box is there, shut and empty.
    const button = /<button type="button" class="card-fold-toggle" aria-expanded="false" aria-controls="([^"]+)" aria-describedby="([^"]+)" aria-label="Show the tasks" title="Show the tasks">/.exec(html);
    expect(button).not.toBeNull();
    const boxes = button![1].split(" ");
    expect(boxes).toHaveLength(3);
    for (const id of boxes) expect(html).toContain(`<div id="${id}" class="card-fold" hidden=""></div>`);
    expect(html).toContain(`<p class="plan-review-meta" id="${button![2]}">`);
    expect(html.match(/card-fold-toggle/g)).toHaveLength(1);
    // The answers, and the one line that matters beside them.
    expect(html).toContain("No worker starts until you approve.");
    expect(html).toContain("Approve plan");
    expect(html).toContain(">Reject<");
    // How to answer in chat is the line's tooltip, and in the opened card.
    expect(html).toContain('title="Reply &quot;approve this plan&quot; below, or ask for changes.');
    expect(html).not.toContain('<p class="plan-review-chat-hint">');
    expect(html).not.toContain("<textarea");
  });

  it("opens to every task under its stage, above the answers", () => {
    const html = renderOpen(waiting, itsTasks);
    expect(html).toContain('aria-expanded="true"');
    expect(html.match(/<li class="plan-task" data-whole="">/g)).toHaveLength(3);
    expect(html).toContain("Mango Juice");
    expect(html).toContain("Plans live outside the chat.");
    expect(html).toContain("Write the tests.\nRun them twice.");
    expect(html).toContain("after #1, #2");
    // The stage lines stay where they were.
    expect(html).toContain("2 tasks · Mango Juice, Kiwi · octiq-flow, app");
    // The chat's own message box is how to answer; no second one.
    expect(html).toContain('<p class="plan-review-chat-hint">Reply &quot;approve this plan&quot; below, or ask for changes.');
    expect(html).not.toContain("<textarea");
    expect(html.lastIndexOf("plan-task")).toBeLessThan(html.indexOf("plan-review-actions"));
    expect(html.indexOf("plan-review-chat-hint")).toBeLessThan(html.indexOf("plan-review-actions"));
    expect(html).toContain("Approve plan");
    expect(html).toContain(">Reject<");
  });

  it("shows the whole of every task in that one opening, with nothing a second press away", () => {
    // The reviewer's task: an unexpected agent, an unexpected place, and a
    // brief that says what it will really do.
    const plan = [
      ...itsTasks,
      task("e", "run_2278aa", {
        title: "Unexpected destructive job", spec: "DELETE ALL RECORDS AND PUSH\nThen tell nobody.",
        assignee: { id: "unexpected", name: "STAR MUSIC" },
        worker: { agent: "claude", access: "auto", model: "opus" },
        destination: { projectId: "prod", projectName: "Production", repository: "/prod/octiq-flow" },
        card: { problem: "p", goal: "g", acceptance: ["Destructive step"] },
      }),
    ];
    const html = renderOpen(waiting, plan);
    // No disclosure inside the one the card has.
    expect(html).not.toContain("<details");
    expect(html).not.toContain("<summary");
    expect(html.match(/aria-expanded=/g)).toHaveLength(1);
    // Title, who, and where as a whole path.
    expect(html).toContain('<span class="plan-task-title">Unexpected destructive job</span>');
    expect(html).toContain("STAR MUSIC");
    expect(html).toContain('<span class="plan-task-project">Production</span> · <span class="plan-task-repo">/prod/octiq-flow</span>');
    expect(html).toContain('<span class="plan-task-repo">/src/octiq-flow</span>');
    // Criteria, how its commands are approved, and every line of the brief.
    expect(html).toContain("<li>Destructive step</li>");
    expect(html).toContain("<legend>Command approval</legend>");
    expect(html).toContain('<div class="plan-task-brief-label">Full brief · 2 lines</div><div class="plan-task-spec">DELETE ALL RECORDS AND PUSH\nThen tell nobody.</div>');
    // One scroll for it, inside the card, and the answers under it.
    expect(html).toContain('data-folds="true" data-open="true"');
    expect(html.indexOf("plan-task-spec")).toBeLessThan(html.indexOf("plan-review-actions"));
    // Folded, the stage line names both places and both are told apart.
    const folded = render(waiting, plan);
    expect(folded).toContain("3 tasks · Mango Juice, Kiwi, STAR MUSIC · octiq-flow · octiq-flow, app, Production · octiq-flow");
    expect(folded).not.toContain("DELETE ALL RECORDS");
    expect(folded).not.toContain("data-open");
  });

  it("keeps a disclosure per task in the run panel, where a plan is browsed", () => {
    const html = renderToStaticMarkup(
      <PlanReview run={waiting[0]} tasks={itsTasks} drafting={false} onRequestChanges={() => {}} />);
    expect(html.match(/<details/g)!.length).toBeGreaterThanOrEqual(3);
    expect(html).not.toContain("data-whole");
    expect(html).toContain('<span class="plan-task-repo">octiq-flow</span>');
  });

  it("draws a new revision of an opened plan folded again", () => {
    // What the fold belongs to is the revision: `useFold` starts a card whose
    // id it has not seen folded (`lib/cardFold.planFoldId`, `foldPhase`).
    const next = [run("run_2278aa", { status: "pending", requestedAt: 1, revision: 4 })];
    const html = render(next, itsTasks);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("revision 4");
    expect(html).not.toContain("plan-task-title");
  });

  it("says how many tasks of a stage are new since the last approval", () => {
    const html = render([run("run_cccc33", { status: "pending", requestedAt: 1, revision: 5 })],
      [task("a", "run_cccc33", { approvedAt: 2 }), task("b", "run_cccc33"), task("c", "run_cccc33")]);
    expect(html).toContain('<span class="plan-task-new">2 new</span>');
  });

  it("keeps the warning about tasks that never start on the folded card", () => {
    const html = render([run("run_ffff66", { status: "pending", requestedAt: 1, revision: 1 })],
      [task("a", "run_ffff66", { dependsOn: ["b"] }), task("b", "run_ffff66", { dependsOn: ["a"] })]);
    expect(html).toContain('data-blocked="true"');
    expect(html).toContain("Waits on each other");
    expect(html).toContain("Some tasks wait on each other and will never start.");
  });

  it("removes a rejected plan from the transcript tail and folds its record in run history", () => {
    const rejected = run("run_abcd12", {
      status: "rejected", requestedAt: 1, revision: 0, decidedAt: 2,
      rejection: {
        by: "person", revision: 0, at: 2, reason: "Wrong direction", taskIds: ["a"], surface: "chat",
      },
    });
    const tasks = [task("a", "run_abcd12", { status: "cancelled" })];
    expect(render([rejected], tasks)).toBe("");
    const [plan] = chatPlans({ runs: [rejected], tasks, attempts: [], gates: [], messages: [], notifications: [] } as unknown as OrchestrationSnapshot, "chat:lead");
    const html = renderToStaticMarkup(<RejectedPlan plan={plan} />);
    expect(html).toMatch(/<details class="chat-plan chat-plan-approved chat-plan-rejected"><summary>/);
    expect(html).not.toContain("<details class=\"chat-plan chat-plan-approved chat-plan-rejected\" open");
    expect(html).toContain("Plan rejected · Wrong direction");
    expect(html).toContain("revision 0");
    expect(html).toContain("Reason: Wrong direction");
    expect(html).toContain("Withdrawn: Task a");
    expect(html).not.toContain("Approve plan");
  });

  it("distinguishes a restored approved task from work that was withdrawn", () => {
    const rejected = run("run_abcd12", {
      status: "rejected", requestedAt: 1, revision: 5, decidedAt: 2,
      rejection: {
        by: "person", revision: 5, at: 2, taskIds: ["a", "b"], restoredTaskIds: ["a"], surface: "panel",
      },
    });
    const tasks = [task("a", "run_abcd12", { approvedAt: 1, status: "ready" }), task("b", "run_abcd12", { status: "cancelled" })];
    const [plan] = chatPlans({ runs: [rejected], tasks, attempts: [], gates: [], messages: [], notifications: [] } as unknown as OrchestrationSnapshot, "chat:lead");
    const html = renderToStaticMarkup(<RejectedPlan plan={plan} />);
    expect(html).toContain("Restored to the approved plan: Task a");
    expect(html).toContain("Withdrawn: Task b");
    expect(html).not.toContain("Withdrawn: Task a");
  });

  it("with several plans waiting, each says its own handle", () => {
    const html = render([
      run("run_aaaa11", { status: "pending", requestedAt: 1, revision: 1 }),
      run("run_bbbb22", { status: "pending", requestedAt: 1, revision: 2 }),
    ], [task("a", "run_aaaa11"), task("b", "run_bbbb22")]);
    // In the heading of each folded card, and in what it says about chat.
    expect(html).toContain("Plan aaaa · revision 1");
    expect(html).toContain("Plan bbbb · revision 2");
    expect(html).toContain("&quot;approve plan aaaa&quot;");
    expect(html).toContain("&quot;approve plan bbbb&quot;");
  });

  it("a settled plan leaves the chat; a new revision waiting comes back", () => {
    // The person's screenshot: "Approved · revision 4" still a full row
    // above the message box after they had approved it.
    const approved = run("run_cccc33", {
      status: "approved", requestedAt: 1, revision: 4,
      consent: { via: "button", revision: 4, at: 2, surface: "chat", shownMs: 5000 },
    });
    expect(render([approved], [task("a", "run_cccc33", { approvedAt: 2 })])).toBe("");
    const reopened = run("run_cccc33", { status: "pending", requestedAt: 1, revision: 5 });
    const html = render([reopened, run("run_eeee55", { status: "approved", requestedAt: 1, revision: 2 })],
      [task("a", "run_cccc33", { approvedAt: 2 }), task("b", "run_cccc33"), task("c", "run_eeee55", { approvedAt: 2 })]);
    expect(html).toContain("Plan cccc · revision 5");
    expect(html).not.toContain("eeee");
  });

  it("the run panel keeps the approved plan, folded to how and which revision", () => {
    const [plan] = chatPlans({ runs: [run("run_cccc33", {
      status: "approved", requestedAt: 1, revision: 4,
      consent: { via: "conversation", revision: 4, at: 2, turnId: "user-1", words: "approve this plan" },
    })], tasks: [task("a", "run_cccc33", { approvedAt: 2 })], attempts: [], gates: [], messages: [], notifications: [] } as unknown as OrchestrationSnapshot, "chat:lead");
    const html = renderToStaticMarkup(<ApprovedPlan plan={plan} />);
    expect(html).toMatch(/<details class="chat-plan chat-plan-approved"><summary>/);
    expect(html).not.toContain("<details class=\"chat-plan chat-plan-approved\" open");
    expect(html).toContain("Approved in chat · revision 4");
    expect(html).toContain("Plan approved");
    expect(html).not.toContain("Approve plan");
  });

  it("a withdrawn task is not part of the plan shown", () => {
    const html = renderOpen([run("run_dddd44", { status: "pending", requestedAt: 1, revision: 5 })], [
      task("kept", "run_dddd44"),
      task("gone", "run_dddd44", { status: "cancelled" }),
    ]);
    expect(html).toContain("Task kept");
    expect(html).not.toContain("Task gone");
    expect(html).toContain("1 task in 1 stage");
  });

  it("draws nothing for a chat that leads no plan", () => {
    expect(render([], [])).toBe("");
  });
});
