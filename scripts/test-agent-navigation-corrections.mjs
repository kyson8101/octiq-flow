// Actual App-shell regression for agents-mode navigation. The socket is mocked,
// but every interaction goes through App.tsx, Sidebar, the top bar and Composer.
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const artifacts = process.env.OCTIQ_EVIDENCE_DIR
  || await mkdtemp(join(tmpdir(), "octiq-agent-navigation-"));
await mkdir(artifacts, { recursive: true });

const now = Date.now();
const longCwd = "/Users/kyson/03-projects/.worktrees/octiq-flow/feature/a-very-long-navigation-correction-branch-for-mobile-evidence";
const primaryRoot = "/Users/kyson/03-projects/octiq-flow";
const head = {
  id: "maya", name: "Maya", role: "CTO", agent: "codex", model: "gpt-5.6-sol",
  effort: "high", access: "auto", createdAt: now - 100_000, updatedAt: now - 100_000,
};
const worker = {
  id: "noah", name: "Noah", role: "Frontend engineer", agent: "codex", model: "gpt-5.6-sol",
  effort: "high", access: "auto", projectId: "octiq", reportsTo: "maya",
  createdAt: now - 90_000, updatedAt: now - 90_000,
};
const chats = [
  {
    id: "head-old", projectId: "general", title: "Earlier CTO conversation", customTitle: true,
    modelId: "codex:sol", access: "auto", sessionId: "session-head-old",
    createdAt: now - 80_000, updatedAt: now - 70_000,
  },
  {
    id: "worker-current", projectId: "octiq", title: "Simplify agent navigation", customTitle: true,
    modelId: "codex:sol", access: "auto", sessionId: "session-worker", cwd: longCwd,
    createdAt: now - 60_000, updatedAt: now - 50_000,
    launch: {
      projectId: "octiq", projectName: "OctiqFlow", path: primaryRoot, baseBranch: "develop",
      newWorktree: true, useSandbox: true, prepare: true, chosenBy: "auto",
      reason: "A project task gets an isolated worktree and sandbox.", decidedAt: now - 60_000,
    },
  },
];
const localChats = chats.map((chat) => ({
  ...chat,
  messages: [{
    id: `message-${chat.id}`, role: "assistant", streaming: false,
    blocks: [{ kind: "text", text: chat.id === "head-old"
      ? "Existing CTO answer stays here."
      : "Navigation correction is ready for review." }],
  }],
}));
const workspacePlan = {
  mode: "worktree", cwd: longCwd, checkoutRoot: longCwd, repositoryRoot: primaryRoot,
  branch: "feature/navigation-corrections", baseBranch: "develop", baseSha: "ba25b3b",
  managed: true, isRepo: true, warnings: [], initialStatus: "",
};
const task = {
  id: "task-navigation", runId: "run-navigation", title: "Simplify agent navigation",
  spec: "Restore verified task details and start a fresh CTO conversation.", dependsOn: [],
  status: "running", activeAttemptId: "attempt-current", assignee: { id: "noah", name: "Noah" },
  destination: { projectId: "octiq", projectName: "OctiqFlow", repository: primaryRoot },
  workspace: { plan: workspacePlan, state: "ready", abandoned: false, validationPaths: [] },
  createdAt: now - 60_000, updatedAt: now - 20_000,
};
const attempt = {
  id: "attempt-current", runId: "run-navigation", taskId: task.id, number: 2,
  workerChatKey: "chat:worker-current", agent: "codex", model: "gpt-5.6-sol",
  effort: "high", access: "auto", status: "running", cwd: longCwd,
  branch: "feature/navigation-corrections", isWorktree: true, filesModified: [],
  createdAt: now - 55_000, updatedAt: now - 20_000,
};
const snapshot = {
  runs: [{
    id: "run-navigation", coordinatorChatKey: "chat:head-old", objective: "Refine agent navigation",
    workspaceId: "general", rootPath: primaryRoot, status: "running", maxConcurrent: 2,
    createdAt: now - 65_000, updatedAt: now - 20_000,
  }],
  tasks: [task], attempts: [attempt], gates: [], messages: [],
};
const taskStatus = {
  chatId: "worker-current", projectId: "octiq",
  report: {
    objective: "Restore verified task details and fresh CTO conversations",
    nextStep: "Capture full App acceptance evidence",
    steps: [
      { title: "Audit wiring", state: "done" },
      { title: "Restore details", state: "active" },
      { title: "Verify", state: "pending" },
    ],
    reportedAt: now - 15_000, reportedBy: "Noah",
  },
  target: { branch: "develop", setAt: now - 50_000, setBy: "agent" },
  workspace: {
    cwd: longCwd, exists: true, isRepo: true, repoRoot: longCwd, primaryRoot,
    branch: "feature/navigation-corrections", isWorktree: true, changed: 3,
    ahead: 1, behind: 0, hasUpstream: false,
  },
  delivery: {
    target: "develop", head: "abcdef123456", onTarget: false, commits: 1, uncommitted: 3,
    pushed: false, merged: false, mergedRemote: false, released: null,
    releaseNote: "No release check is configured for this project.", stale: false,
    checkedAt: now - 10_000,
  },
};
const staleTaskStatus = {
  ...taskStatus,
  workspace: { ...taskStatus.workspace, exists: false, changed: 0, ahead: 0 },
  delivery: { ...taskStatus.delivery, uncommitted: 0, stale: true, checkedAt: now - 5_000 },
};
const sandbox = {
  id: "sandbox-worker", chatKey: "chat:worker-current", enabled: true, locked: true,
  cwd: longCwd, state: "ready", checkedAt: now - 12_000, error: null,
  urls: {}, sourceRevision: "abcdef123456", sourceDirty: true, fixtureVersion: "mock-v1",
};

const calls = [];
const errors = [];
let appSocket;
const server = await createServer({
  root: new URL("../web", import.meta.url).pathname,
  configFile: new URL("../web/vite.config.ts", import.meta.url).pathname,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

function resultFor(request) {
  switch (request.cmd) {
    case "list_workspaces": return [
      { id: "general", name: "General", primary_path: "/Users/kyson/General" },
      { id: "octiq", name: "OctiqFlow", primary_path: primaryRoot },
    ];
    case "chat_index_list": return chats;
    case "chat_index_deleted": return [];
    case "chat_page": return { events: [], context: [], before: null };
    case "chat_list": return [];
    case "chat_queue_state": return { live: false, queuedTurnIds: [] };
    case "orchestration_snapshot": return snapshot;
    case "sandbox_snapshot": return { defaultEnabled: true, environments: { [sandbox.id]: sandbox } };
    case "permission_pending": return [];
    case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
    case "usage_summary": return {};
    case "git_status": return { branch: "feature/navigation-corrections", files: [] };
    case "git_local_branches": return { is_repo: true, current: "develop", branches: ["develop"], is_worktree: false };
    case "agent_installs": return [{ id: "codex", installed: true, path: "/mock/codex" }];
    case "team_list": return request.args?.all ? [head, worker] : request.args?.projectId === "octiq" ? [worker] : [head];
    case "team_head": return head;
    case "team_leads": return [{
      chatKey: "chat:head-old", leadId: head.id, leadName: head.name,
      projectId: "general", crossProject: true, createdAt: now - 80_000,
    }];
    case "team_home": return "general";
    case "team_brief": return `${request.args.task}\n\n[Mocked CTO brief for App-shell acceptance]`;
    case "chat_task": return request.args?.chatId === "worker-current"
      ? taskStatus
      : { chatId: request.args?.chatId, projectId: "general" };
    case "codex_skills": return [];
    default: return null;
  }
}

async function waitForStart(page, excluded) {
  for (let index = 0; index < 100; index += 1) {
    const started = calls.find(({ cmd, args }) => cmd === "chat_start"
      && !excluded.has(String(args?.key ?? "").replace(/^chat:/, "")));
    if (started) return String(started.args.key).replace(/^chat:/, "");
    await page.waitForTimeout(50);
  }
  throw new Error("Fresh conversation did not call chat_start");
}

let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: "reduce" });
  await context.addInitScript((seed) => {
    if (location.search.includes("coding=1")) localStorage.removeItem("octiq.agentsMode");
    else localStorage.setItem("octiq.agentsMode", "on");
    localStorage.setItem("octiq.v2.gitColumn", "0");
    localStorage.setItem("octiq.v2.conversations", JSON.stringify(seed));
  }, localChats);
  await context.route("**/token", route => route.fulfill({ body: "mock-token" }));
  await context.route("**/auth", route => route.fulfill({ body: "ok" }));
  await context.routeWebSocket(/.*/, socket => {
    appSocket = socket;
    socket.onMessage(raw => {
    const request = JSON.parse(String(raw));
    if (request.t !== "invoke") return;
    calls.push(request);
    socket.send(JSON.stringify({ t: "reply", id: request.id, ok: true, result: resultFor(request) }));
    });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on("pageerror", error => errors.push(error.stack ?? String(error)));
  const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base.slice(0, -1) });
  await page.goto(`${base}#/p/octiqflow/c/worker-current`, { waitUntil: "domcontentloaded" });
  await page.locator(".main").getByText("Navigation correction is ready for review.", { exact: true }).waitFor();

  // The real top-bar overflow owns Task details; no Running/Unverified chip is
  // restored to the navbar itself.
  await page.getByRole("button", { name: "Chat actions", exact: true }).click();
  await page.getByRole("button", { name: "Task details", exact: true }).click();
  const details = page.getByRole("dialog", { name: "Task and workspace", exact: true });
  await details.waitFor();
  for (const value of [
    "Noah", "OctiqFlow", longCwd, primaryRoot, "feature/navigation-corrections",
    "develop", "Task worktree", "Ready", "3 changed · 1 to push · no upstream",
    "No release check is configured for this project.",
  ]) assert.match(await details.innerText(), new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(await page.locator(".topbar-leading > .chat-task, .topbar-actions > .chat-task").count(), 0,
    "Task state must not return as a direct navbar label");
  await details.getByRole("button", { name: "Copy working directory path", exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), longCwd);
  await page.screenshot({ path: join(artifacts, "desktop-task-details.png") });

  // A live host update must replace verified facts with truthful stale/removed
  // evidence rather than leaving the earlier green state behind.
  appSocket.send(JSON.stringify({ t: "event", event: "chat-task", payload: staleTaskStatus }));
  await details.getByText("Stale", { exact: true }).waitFor();
  assert.match(await details.innerText(), /Task worktree \(removed\)/);
  assert.match(await details.innerText(), /read from the primary checkout/);
  assert.match(await details.innerText(), /Unverified/);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await details.isVisible(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await details.evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: join(artifacts, "mobile-task-details-390.png") });
  await details.getByText(longCwd, { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifacts, "mobile-task-details-long-path-390.png") });
  await details.getByRole("button", { name: "Close", exact: true }).click();

  // With an existing CTO conversation in the sidebar, New conversation must
  // prepare a blank head draft rather than navigate back to that row.
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await page.getByRole("heading", { name: "Talk to Maya", exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash.includes("head-old"), false);
  await page.screenshot({ path: join(artifacts, "desktop-fresh-conversation.png") });
  await page.locator("textarea").fill("Plan a brand new release");
  await page.locator("textarea").press("Enter");
  const firstFresh = await waitForStart(page, new Set(["head-old", "worker-current"]));
  assert.notEqual(firstFresh, "head-old");
  assert.match(new URL(page.url()).hash, new RegExp(`/c/${firstFresh}$`));
  const oldRow = page.locator(".chat-row").filter({ hasText: "Earlier CTO conversation" });
  await oldRow.waitFor();
  await oldRow.locator(".chat-btn").click();
  await page.getByText("Existing CTO answer stays here.", { exact: true }).waitFor();
  assert.match(new URL(page.url()).hash, /\/c\/head-old$/);

  // Repeat the new-conversation action at exactly 390px. The long path panel
  // above and this fresh draft must both stay inside the viewport.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Show chats", exact: true }).click();
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await page.getByRole("heading", { name: "Talk to Maya", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(artifacts, "mobile-fresh-conversation-390.png") });
  await page.locator("textarea").fill("Plan another fresh CTO conversation");
  await page.locator("textarea").press("Enter");
  const secondFresh = await waitForStart(page, new Set(["head-old", "worker-current", firstFresh]));
  assert.notEqual(secondFresh, firstFresh);
  assert.match(new URL(page.url()).hash, new RegExp(`/c/${secondFresh}$`));
  await page.getByRole("button", { name: "Show chats", exact: true }).click();
  assert.equal(await page.locator(".chat-title").getByText("Earlier CTO conversation", { exact: true }).count(), 1);
  assert.equal(await page.locator(".chat-title").getByText("Plan a brand new release", { exact: true }).count(), 1);
  assert.equal(await page.locator(".chat-title").getByText("Plan another fresh CTO conversation", { exact: true }).count(), 1);

  // Agents mode did not absorb the ordinary creation path: with the mode off,
  // the same real Sidebar still opens a blank coding task and starts nothing.
  await page.evaluate(() => localStorage.removeItem("octiq.agentsMode"));
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${base}?coding=1#/p/general/c/head-old`, { waitUntil: "domcontentloaded" });
  await page.locator(".main").getByText("Existing CTO answer stays here.", { exact: true }).waitFor();
  const startsBeforeCodingDraft = calls.filter(({ cmd }) => cmd === "chat_start").length;
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page.getByRole("heading", { name: "What should we work on?", exact: true }).waitFor();
  assert.equal(await page.locator("textarea").inputValue(), "");
  assert.equal(calls.filter(({ cmd }) => cmd === "chat_start").length, startsBeforeCodingDraft);

  assert.deepEqual(errors, []);
  assert(calls.some(({ cmd, args }) => cmd === "chat_task" && args?.chatId === "worker-current"), "App must request live chat_task verification");
  console.log(JSON.stringify({ passed: true, mockedBackend: true, artifacts, firstFresh, secondFresh }));
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  console.error(JSON.stringify({
    error: String(error), errors,
    body: await page?.locator("body").innerText({ timeout: 2_000 }).catch(() => "unavailable"),
  }));
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
