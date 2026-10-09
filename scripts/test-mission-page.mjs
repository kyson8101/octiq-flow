// App-shell regression for a mission's page. The socket is mocked, but every
// frame goes through App.tsx, the run column and the tab's one ledger feed.
//
// A mission run's column shows its board, then Goal (closed), Crew (open,
// lead first, each with the role they hold here) and Where (closed), then its
// tasks, each naming owner, kind and size. Reassigning a task from its row
// asks `orchestration_destinations` as the lead, then sends the lead's own
// `orchestration_task_reassign`, and the row follows the ledger. A run that is
// not a mission draws none of it. Desktop and 375px phone, no sideways scroll,
// no page errors.
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const artifacts = process.env.OCTIQ_EVIDENCE_DIR
  || await mkdtemp(join(tmpdir(), "octiq-mission-page-"));
await mkdir(artifacts, { recursive: true });

const now = Date.now();
const agent = (id, name, role, extra = {}) => ({
  id, name, role, agent: "claude", model: "opus", effort: "high", access: "auto",
  createdAt: now - 100_000, updatedAt: now - 100_000, ...extra,
});
const team = [
  agent("ada", "Ada", "CTO"),
  agent("maya", "Maya", "Full-stack developer", { reportsTo: "ada" }),
  agent("noah", "Noah", "Reviewer", { reportsTo: "ada" }),
  agent("zed", "Zed", "Backup developer", { reportsTo: "ada" }),
];
const chat = (id, title, over = {}) => ({
  id, projectId: "general", title, customTitle: true, modelId: "claude:opus", access: "auto",
  sessionId: `session-${id}`, createdAt: now - 60_000, updatedAt: now - 50_000, ...over,
});
const chats = [
  chat("lead", "Mission page for OctiqFlow", { updatedAt: now - 10_000 }),
  chat("plain", "Ordinary run", { updatedAt: now - 20_000 }),
];
const localChats = chats.map((item) => ({
  ...item,
  messages: [{ id: `m-${item.id}`, role: "assistant", streaming: false, blocks: [{ kind: "text", text: `${item.title}: plan is on the left.` }] }],
}));

const repo = "/Users/kyson/03-projects/octiq-flow";
const missionTree = `/Users/kyson/03-projects/.worktrees/octiq-flow/feature/mission-run_mission`;
const plan = {
  mode: "mission", cwd: missionTree, checkoutRoot: missionTree, repositoryRoot: repo,
  branch: "feature/mission-run_mission", baseBranch: "develop", baseSha: "25ab72d",
  managed: true, isRepo: true, warnings: [], initialStatus: "",
};
const card = (acceptance) => ({ problem: "The mission has no page.", goal: "Give it one.", acceptance });
const task = (id, runId, title, over = {}) => ({
  id, runId, title, spec: "", dependsOn: [], status: "pending", createdAt: now - 40_000, updatedAt: now - 20_000, ...over,
});
const missionRun = {
  id: "run_mission", coordinatorChatKey: "chat:lead", objective: "Give every mission a page with its goal, crew, tasks and branches",
  workspaceId: "general", rootPath: repo, status: "running", maxConcurrent: 3, workspaceMode: "mission",
  planApproval: { status: "approved", requestedAt: now - 45_000, decidedAt: now - 44_000, revision: 1 },
  createdAt: now - 45_000, updatedAt: now - 20_000,
};
const plainRun = {
  id: "run_plain", coordinatorChatKey: "chat:plain", objective: "Tidy the docs", workspaceId: "general", rootPath: repo,
  status: "running", maxConcurrent: 2, workspaceMode: "auto", createdAt: now - 45_000, updatedAt: now - 20_000,
};
const baseTasks = [
  task("t-server", "run_mission", "Derive crew and worktree facts", {
    assignee: { id: "maya", name: "Maya" }, status: "completed", size: "medium",
    workspace: { plan, state: "ready", abandoned: false, validationPaths: [] },
    card: card(["Crew roles come from the ledger", "No new persistence"]),
  }),
  task("t-page", "run_mission", "Build the Mission page", {
    assignee: { id: "maya", name: "Maya" }, status: "running", size: "large", activeAttemptId: "a-page",
    workspace: { plan, state: "ready", abandoned: false, validationPaths: [] },
    card: card(["Goal, crew, tasks, where and board on one page", "Reassign from a task row"]),
  }),
  task("t-review", "run_mission", "Review the Mission page", {
    assignee: { id: "noah", name: "Noah" }, kind: "review", size: "small", dependsOn: ["t-page"],
    card: card(["Independent review passes"]),
  }),
  task("p-docs", "run_plain", "Rewrite the README", { assignee: { id: "maya", name: "Maya" }, status: "running", activeAttemptId: "a-docs", size: "small" }),
];
const attempt = (id, taskId, runId, chatKey) => ({
  id, runId, taskId, number: 1, workerChatKey: chatKey, agent: "claude", model: "opus", effort: "high", access: "auto",
  status: "running", execution: { state: "executing", retryCount: 0, lastActivityAt: now - 5_000 },
  cwd: missionTree, branch: plan.branch, isWorktree: true, filesModified: [], createdAt: now - 30_000, updatedAt: now - 5_000,
});
let snapshot = {
  runs: [missionRun, plainRun],
  tasks: baseTasks,
  attempts: [attempt("a-page", "t-page", "run_mission", "chat:w-page"), attempt("a-docs", "p-docs", "run_plain", "chat:w-docs")],
  gates: [], messages: [],
};

const calls = [];
const errors = [];
const server = await createServer({
  root: new URL("../web", import.meta.url).pathname,
  configFile: new URL("../web/vite.config.ts", import.meta.url).pathname,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

function resultFor(request) {
  switch (request.cmd) {
    case "list_workspaces": return [{ id: "general", name: "General", primary_path: repo }];
    case "chat_index_list": return chats;
    case "chat_index_deleted": return [];
    case "chat_page": return { events: [], context: [], before: null };
    case "chat_list": return [];
    case "chat_activity": return [];
    case "chat_queue_state": return { live: false, queuedTurnIds: [] };
    case "orchestration_snapshot": return snapshot;
    case "sandbox_snapshot": return { defaultEnabled: false, environments: {} };
    case "permission_pending": return [];
    case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
    case "usage_summary": return {};
    case "agent_installs": return [{ id: "claude", installed: true, path: "/mock/claude" }];
    case "team_list": return team;
    case "team_head": return team[0];
    case "team_leads": return [
      { chatKey: "chat:lead", leadId: "ada", leadName: "Ada", projectId: "general", crossProject: true, createdAt: now - 60_000 },
      { chatKey: "chat:plain", leadId: "ada", leadName: "Ada", projectId: "general", crossProject: true, createdAt: now - 60_000 },
    ];
    case "team_home": return "general";
    case "chat_task": return { chatId: request.args?.chatId, projectId: "general" };
    case "codex_skills": return [];
    case "orchestration_destinations": return {
      scope: "every registered project",
      projects: [{ id: "general", name: "General", shelved: false, repositories: [], reports: [
        { id: "maya", name: "Maya", role: "Full-stack developer", scope: "any project" },
        { id: "noah", name: "Noah", role: "Reviewer", scope: "any project" },
        { id: "zed", name: "Zed", role: "Backup developer", scope: "any project" },
      ] }],
    };
    case "orchestration_task_reassign": {
      // What reassign_task does: the new owner, the handoff kept, and the
      // task back in front of the person.
      const at = Date.now();
      snapshot = {
        ...snapshot,
        runs: snapshot.runs.map((run) => run.id === "run_mission"
          ? { ...run, planApproval: { ...run.planApproval, status: "pending", requestedAt: at, decidedAt: undefined } } : run),
        tasks: snapshot.tasks.map((item) => item.id === request.args.taskId ? {
          ...item, assignee: { id: "zed", name: "Zed" }, approvedAt: undefined, status: "pending",
          handoffs: [{ from: item.assignee, to: { id: "zed", name: "Zed" }, reason: request.args.reason, at }],
        } : item),
      };
      return snapshot.tasks.find((item) => item.id === request.args.taskId);
    }
    default: return null;
  }
}

const row = (page, title) => page.locator(".sidebar .chat").filter({ has: page.locator(".chat-title", { hasText: title }) });
const runSurface = (page) => page.locator(".workflow-run-surface");
const taskRow = (page, title) => runSurface(page).locator(".orch-task")
  .filter({ has: page.locator(".orch-task-title", { hasText: new RegExp(`^${title}$`) }) });
const noSidewaysScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
async function waitFor(page, check, what) {
  for (let index = 0; index < 100; index += 1) {
    if (await check()) return;
    await page.waitForTimeout(50);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  const base = `http://127.0.0.1:${server.httpServer.address().port}/`;

  async function newContext(viewport) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2, reducedMotion: "reduce" });
    await context.addInitScript((seed) => {
      if (location.protocol === "about:") return;
      localStorage.setItem("octiq.agentsMode", "on");
      localStorage.setItem("octiq.v2.gitColumn", "0");
      localStorage.setItem("octiq.theme", "dark");
      localStorage.setItem("octiq.v2.conversations", JSON.stringify(seed));
    }, localChats);
    await context.route("**/token", (route) => route.fulfill({ body: "mock-token" }));
    await context.route("**/auth", (route) => route.fulfill({ body: "ok" }));
    await context.routeWebSocket(/.*/, (socket) => {
      socket.onMessage((raw) => {
        const request = JSON.parse(String(raw));
        if (request.t !== "invoke") return;
        calls.push(request);
        socket.send(JSON.stringify({ t: "reply", id: request.id, ok: true, result: resultFor(request) }));
      });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on("pageerror", (error) => errors.push(error.stack ?? String(error)));
    return { context, page };
  }
  async function openChat(page, title, phone = false) {
    if (phone) await page.getByRole("button", { name: "Show chats", exact: true }).click();
    await row(page, title).waitFor();
    await row(page, title).locator(".chat-btn").click();
    await waitFor(page, async () => await runSurface(page).count() > 0, `the run surface for ${title}`);
    if (phone) {
      const tasksTab = page.locator('[aria-label="Conversation view"] button', { hasText: "Tasks" });
      await tasksTab.waitFor();
      await tasksTab.click();
    }
    await waitFor(page, () => runSurface(page).isVisible(), "the run column");
    // The run's own disclosure, if it starts closed.
    const toggle = runSurface(page).locator(".orch-run-accordion-toggle").first();
    if (await toggle.count() && (await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  }

  // ── Desktop: the mission page, then a reassignment from a task row.
  {
    const { context, page } = await newContext({ width: 1440, height: 1000 });
    await page.goto(`${base}#/p/general`, { waitUntil: "domcontentloaded" });
    await openChat(page, "Mission page for OctiqFlow");
    const surface = runSurface(page);
    await surface.locator(".mission-page").waitFor();
    assert.equal(await surface.locator(".mission-track").count(), 1, "the board stays");
    const sections = surface.locator(".mission-section");
    assert.deepEqual(await sections.locator("summary > span").allInnerTexts(), ["Goal", "Crew", "Where"]);
    assert.deepEqual(await sections.evaluateAll((all) => all.map((el) => el.open)), [false, true, false],
      "crew open; goal and where closed");
    const crew = surface.locator(".mission-crew > li");
    assert.deepEqual(await crew.locator(".mission-crew-name").allInnerTexts(), ["Ada", "Maya", "Noah"], "lead first");
    assert.deepEqual(await crew.locator(".mission-crew-roles").allInnerTexts(), ["Lead", "Developer", "Reviewer"]);
    assert.equal(await surface.locator(".orch-task").count(), 3, "three tasks");
    const buildMeta = await taskRow(page, "Build the Mission page").locator(".orch-task-meta").innerText();
    for (const word of ["Maya", "Work", "Large"]) assert.match(buildMeta, new RegExp(word), `the row names ${word}`);
    assert.equal(await page.locator('.orch-tool', { hasText: "Main agent chat" }).count(), 1, "the pinned main chat stays");
    assert.equal(await noSidewaysScroll(page), true);
    await page.screenshot({ path: join(artifacts, "desktop-1440-mission.png") });

    // Goal and Where open on request.
    await sections.nth(0).locator("summary").click();
    await sections.nth(2).locator("summary").click();
    assert.match(await sections.nth(0).innerText(), /Reassign from a task row/);
    assert.match(await sections.nth(2).innerText(), /feature\/mission-run_mission[\s\S]*develop/);
    await page.screenshot({ path: join(artifacts, "desktop-1440-mission-goal-where.png") });
    await sections.nth(0).locator("summary").click();
    await sections.nth(2).locator("summary").click();

    // The running task cannot change hands; the review can.
    const building = taskRow(page, "Build the Mission page");
    assert.equal(await building.locator(".orch-task-reassign").isDisabled(), true);
    const review = taskRow(page, "Review the Mission page");
    await review.locator(".orch-task-reassign").click();
    const form = review.locator(".mission-reassign");
    await form.locator("select option[value='zed']").waitFor({ state: "attached" });
    const options = await form.locator("select option").allInnerTexts();
    assert.deepEqual(options, ["Choose a crew member", "Maya · Full-stack developer", "Zed · Backup developer"],
      "the current owner is not offered; crew first");
    const asked = calls.find((call) => call.cmd === "orchestration_destinations");
    assert.equal(asked.args.actorChatKey, "chat:lead", "asked as the lead");
    await form.locator("select").selectOption("zed");
    await form.locator("input").fill("Noah is out today; Zed reviews instead");
    await page.screenshot({ path: join(artifacts, "desktop-1440-reassign-form.png") });
    await form.getByRole("button", { name: "Reassign", exact: true }).click();
    await waitFor(page, async () => await review.locator(".mission-reassign").count() === 0, "the form to close");
    const sent = calls.find((call) => call.cmd === "orchestration_task_reassign");
    assert.deepEqual(sent.args, {
      actorChatKey: "chat:lead", taskId: "t-review", assignee: "zed",
      reason: "Noah is out today; Zed reviews instead (reassigned by the person from the Mission page)",
    });
    await waitFor(page, async () => (await crew.locator(".mission-crew-name").allInnerTexts()).includes("Zed"), "Zed on the crew");
    assert.deepEqual(await crew.locator(".mission-crew-name").allInnerTexts(), ["Ada", "Maya", "Zed"], "Noah left the crew");
    // The new owner waits for the person: the plan card is back.
    await surface.locator(".plan-review, [data-pending-keys^='plan:']").first().waitFor();
    await page.screenshot({ path: join(artifacts, "desktop-1440-after-reassign.png") });
    await context.close();
  }

  // ── Phone: the same page in the Tasks view.
  {
    snapshot = { ...snapshot, runs: [missionRun, plainRun], tasks: baseTasks };
    const { context, page } = await newContext({ width: 375, height: 812 });
    await page.goto(`${base}#/p/general`, { waitUntil: "domcontentloaded" });
    await openChat(page, "Mission page for OctiqFlow", true);
    await runSurface(page).locator(".mission-page").waitFor();
    assert.equal(await noSidewaysScroll(page), true, "no sideways scroll at 375px");
    await page.screenshot({ path: join(artifacts, "phone-375-mission.png") });
    const review = taskRow(page, "Review the Mission page");
    await review.locator(".orch-task-reassign").click();
    await review.locator(".mission-reassign select option[value='zed']").waitFor({ state: "attached" });
    await review.scrollIntoViewIfNeeded();
    assert.equal(await noSidewaysScroll(page), true, "the form fits at 375px");
    await page.screenshot({ path: join(artifacts, "phone-375-reassign-form.png") });
    await context.close();
  }

  // ── A run that is not a mission: unchanged, desktop and phone.
  for (const [viewport, phone, name] of [[{ width: 1440, height: 1000 }, false, "desktop-1440"], [{ width: 375, height: 812 }, true, "phone-375"]]) {
    const { context, page } = await newContext(viewport);
    await page.goto(`${base}#/p/general`, { waitUntil: "domcontentloaded" });
    await openChat(page, "Ordinary run", phone);
    const surface = runSurface(page);
    await surface.locator(".orch-task").first().waitFor();
    for (const absent of [".mission-track", ".mission-page", ".orch-task-reassign", ".orch-task-owner", ".orch-task-size"]) {
      assert.equal(await surface.locator(absent).count(), 0, `${absent} stays off a non-mission run`);
    }
    assert.equal(await noSidewaysScroll(page), true);
    await page.screenshot({ path: join(artifacts, `${name}-not-a-mission.png`) });
    await context.close();
  }

  assert.deepEqual(errors, []);
  console.log(`mission page: ok — evidence in ${artifacts}`);
} finally {
  await browser?.close();
  await server.close();
}
