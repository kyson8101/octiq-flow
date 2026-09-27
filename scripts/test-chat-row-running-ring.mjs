// App-shell regression for the running ring round a chat row's project logo.
// The socket is mocked, but every frame goes through App.tsx, the tab's one
// orchestration feed and the Sidebar, and host events arrive the way the real
// server sends them.
//
// A main chat sits idle between turns while its workers run. Its row used to
// look exactly like a finished one; now the logo's ring goes round for as long
// as one of ITS tasks is executing. This checks, at 1440, 430 and 375 wide:
//   * only that row moves — a finished chat in the same project, a run with
//     only queued work and a worker parked on a decision all keep still;
//   * a pinned main chat gets the ring too;
//   * the ring follows `orchestration-changed` both ways, with no polling;
//   * the row does not change size, and nothing scrolls sideways;
//   * with reduced motion the ring is lit whole and nothing moves.
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const artifacts = process.env.OCTIQ_EVIDENCE_DIR
  || await mkdtemp(join(tmpdir(), "octiq-running-ring-"));
await mkdir(artifacts, { recursive: true });

const now = Date.now();
const chat = (id, title, over = {}) => ({
  id, projectId: "general", title, customTitle: true, modelId: "claude:opus", access: "auto",
  sessionId: `session-${id}`, createdAt: now - 60_000, updatedAt: now - 50_000, ...over,
});
const chats = [
  chat("lead-run", "Agent levels and experience", { updatedAt: now - 10_000 }),
  chat("lead-done", "Compact mobile agent welcome", { updatedAt: now - 20_000 }),
  chat("lead-queued", "Waiting for its turn", { updatedAt: now - 30_000 }),
  chat("lead-gate", "Needs a decision", { updatedAt: now - 40_000 }),
  chat("pinned-run", "Start read together chapter 11", { pinned: true, updatedAt: now - 5_000 }),
  chat("plain", "Starfall direct agent collaboration", { projectId: "starfall", updatedAt: now - 45_000 }),
];
const localChats = chats.map((item) => ({
  ...item,
  messages: [{ id: `m-${item.id}`, role: "assistant", streaming: false, blocks: [{ kind: "text", text: `${item.title} answer.` }] }],
}));
const destination = (projectId, projectName) => ({ projectId, projectName, repository: `/repo/${projectId}` });
const run = (id, lead, status = "running") => ({
  id, coordinatorChatKey: `chat:${lead}`, objective: id, workspaceId: "general", rootPath: "/General",
  status, maxConcurrent: 2, createdAt: now - 45_000, updatedAt: now - 20_000,
  planApproval: { status: "approved", requestedAt: now - 44_000, decidedAt: now - 43_000 },
});
const task = (id, runId, status, projectId, projectName) => ({
  id, runId, title: id, spec: "", dependsOn: [], status, activeAttemptId: `a-${id}`,
  destination: destination(projectId, projectName), createdAt: now - 40_000, updatedAt: now - 20_000,
});
const attempt = (taskId, runId, state, status = "running") => ({
  id: `a-${taskId}`, runId, taskId, number: 1, workerChatKey: `chat:orch-${taskId}`, agent: "claude",
  access: "auto", status, cwd: "/w", branch: "b", isWorktree: true, filesModified: [],
  execution: { state, retryCount: 0, lastActivityAt: now - 1_000 }, createdAt: now - 30_000, updatedAt: now - 1_000,
});
const snapshot = {
  runs: [run("r-run", "lead-run"), run("r-done", "lead-done", "completed"), run("r-queued", "lead-queued"),
    run("r-gate", "lead-gate"), run("r-pin", "pinned-run")],
  tasks: [
    // Two tasks in the run: one executing, one still queued behind it.
    task("xp", "r-run", "running", "octiq", "octiq-flow"),
    task("levels", "r-run", "pending", "octiq", "octiq-flow"),
    task("welcome", "r-done", "completed", "octiq", "octiq-flow"),
    task("later", "r-queued", "running", "octiq", "octiq-flow"),
    task("asked", "r-gate", "running", "octiq", "octiq-flow"),
    task("chapter", "r-pin", "running", "starfall", "starfall"),
  ],
  attempts: [
    attempt("xp", "r-run", "executing"),
    attempt("welcome", "r-done", "completed", "completed"),
    attempt("later", "r-queued", "queued"),
    attempt("asked", "r-gate", "waiting_tool"),
    attempt("chapter", "r-pin", "waiting_tool"),
  ],
  gates: [{ id: "g", runId: "r-gate", taskId: "asked", createdByChatKey: "chat:orch-asked", targetChatKey: "chat:lead-gate",
    question: "Which?", options: [], status: "open", createdAt: now - 5_000, updatedAt: now - 5_000 }],
  messages: [],
};

const calls = [];
const errors = [];
const sockets = new Set();
const server = await createServer({
  root: new URL("../web", import.meta.url).pathname,
  configFile: new URL("../web/vite.config.ts", import.meta.url).pathname,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

function resultFor(request) {
  switch (request.cmd) {
    case "list_workspaces": return [
      { id: "general", name: "General", primary_path: "/General" },
      { id: "octiq", name: "octiq-flow", primary_path: "/repo/octiq", color: "#d6a13a" },
      { id: "starfall", name: "starfall", primary_path: "/repo/starfall", color: "#3aa6b9" },
    ];
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
    case "chat_task": return { chatId: request.args?.chatId, projectId: "general" };
    case "codex_skills": return [];
    default: return null;
  }
}

const send = (event, payload) => {
  for (const socket of sockets) socket.send(JSON.stringify({ t: "event", event, payload }));
};
const row = (page, title) => page.locator(".sidebar .chat").filter({ has: page.locator(".chat-title", { hasText: title }) });
const running = async (page, title) => (await row(page, title).getAttribute("class")).split(/\s+/).includes("is-tasks-running");
const box = async (page, title) => {
  const r = row(page, title);
  const [rowBox, badge] = await Promise.all([r.boundingBox(), r.locator(".chat-badge").boundingBox()]);
  return { height: rowBox.height, badge };
};
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

  async function open(viewport, reducedMotion) {
    const context = await browser.newContext({ viewport, reducedMotion, deviceScaleFactor: 2 });
    await context.addInitScript((seed) => {
      if (location.protocol === "about:") return;
      localStorage.setItem("octiq.v2.gitColumn", "0");
      localStorage.setItem("octiq.theme", "dark");
      localStorage.setItem("octiq.v2.conversations", JSON.stringify(seed));
    }, localChats);
    await context.route("**/token", (route) => route.fulfill({ body: "mock-token" }));
    await context.route("**/auth", (route) => route.fulfill({ body: "ok" }));
    await context.routeWebSocket(/.*/, (socket) => {
      sockets.add(socket);
      socket.onMessage((raw) => {
        const request = JSON.parse(String(raw));
        if (request.t !== "invoke") return;
        calls.push(request);
        socket.send(JSON.stringify({ t: "reply", id: request.id, ok: true, result: resultFor(request) }));
      });
      socket.onClose(() => sockets.delete(socket));
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on("pageerror", (error) => errors.push(error.stack ?? String(error)));
    await page.goto(`${base}#/p/general`, { waitUntil: "domcontentloaded" });
    if (viewport.width < 860) {
      const show = page.getByRole("button", { name: "Show chats" });
      if (await show.count()) await show.first().click();
    }
    await row(page, "Agent levels and experience").waitFor();
    await waitFor(page, () => running(page, "Agent levels and experience"), "the ledger to reach the sidebar");
    return { context, page };
  }

  // ── Desktop, motion allowed.
  {
    const { context, page } = await open({ width: 1440, height: 960 }, "no-preference");
    assert.equal(await running(page, "Agent levels and experience"), true, "an executing task runs its main chat's ring");
    assert.equal(await running(page, "Start read together chapter 11"), true, "a pinned main chat gets the ring too");
    assert.equal(await running(page, "Compact mobile agent welcome"), false, "a finished run in the same project keeps still");
    assert.equal(await running(page, "Waiting for its turn"), false, "queued-only work is not running");
    assert.equal(await running(page, "Needs a decision"), false, "a worker waiting on a decision is not running");
    assert.equal(await running(page, "Starfall direct agent collaboration"), false, "an ordinary idle chat keeps still");
    assert.equal(await page.locator(".sidebar .chat.is-tasks-running").count(), 2);
    // Only the ring: a coordinator idle between turns is not mid-turn itself.
    assert.equal(await page.locator(".sidebar .chat.is-busy").count(), 0);
    const label = await row(page, "Agent levels and experience").locator(".chat-btn").getAttribute("aria-label");
    assert.match(label, /, 1 task running/, `accessible status: ${label}`);
    const snake = row(page, "Agent levels and experience").locator(".chat-badge-snake");
    assert.equal(await snake.evaluate((el) => getComputedStyle(el).animationName), "chat-badge-snake");
    assert.equal(await row(page, "Compact mobile agent welcome").locator(".chat-badge-snake")
      .evaluate((el) => getComputedStyle(el).animationName), "none", "a still row runs no animation");
    // The logo under the ring is still the project's own tile.
    assert.equal(await row(page, "Agent levels and experience").locator(".chat-badge .project-avatar-text").innerText(),
      await row(page, "Compact mobile agent welcome").locator(".chat-badge .project-avatar-text").innerText());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator(".sidebar").screenshot({ path: join(artifacts, "desktop-1440-running.png") });

    // ── Live, both ways, from events alone.
    const before = await box(page, "Agent levels and experience");
    const reads = () => calls.filter((call) => call.cmd === "orchestration_snapshot").length;
    const readsBefore = reads();
    send("orchestration-changed", { attemptId: "a-xp", execution: { state: "awaiting_report", retryCount: 0 } });
    await waitFor(page, async () => !(await running(page, "Agent levels and experience")), "the ring to stop");
    assert.equal(reads(), readsBefore, "an execution patch needs no ledger read");
    const after = await box(page, "Agent levels and experience");
    assert.deepEqual(after, before, "the row keeps its size and the badge its place when the ring stops");
    await page.locator(".sidebar").screenshot({ path: join(artifacts, "desktop-1440-stopped.png") });
    send("orchestration-changed", { attemptId: "a-xp", execution: { state: "executing", retryCount: 0 } });
    await waitFor(page, () => running(page, "Agent levels and experience"), "the ring to start again");

    // A whole-ledger change: the task completes, the run finishes.
    snapshot.tasks = snapshot.tasks.map((item) => item.id === "xp" ? { ...item, status: "completed" } : item);
    snapshot.attempts = snapshot.attempts.map((item) => item.id === "a-xp"
      ? { ...item, status: "completed", execution: { state: "completed", retryCount: 0 } } : item);
    send("orchestration-changed", { runId: "r-run" });
    await waitFor(page, async () => !(await running(page, "Agent levels and experience")), "completion to stop the ring");
    assert.equal(await running(page, "Start read together chapter 11"), true, "another chat's ring is untouched");
    // Restore for the phone passes.
    snapshot.tasks = snapshot.tasks.map((item) => item.id === "xp" ? { ...item, status: "running" } : item);
    snapshot.attempts = snapshot.attempts.map((item) => item.id === "a-xp"
      ? { ...item, status: "running", execution: { state: "executing", retryCount: 0 } } : item);
    await context.close();
  }

  // ── Phones, and reduced motion.
  for (const [width, height] of [[430, 932], [375, 812]]) {
    for (const reducedMotion of ["no-preference", "reduce"]) {
      const { context, page } = await open({ width, height }, reducedMotion);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}: no sideways scroll`);
      const lit = await box(page, "Agent levels and experience");
      const still = await box(page, "Compact mobile agent welcome");
      assert.equal(lit.badge.width, still.badge.width, `${width}: the ring draws inside the badge`);
      assert.equal(lit.badge.height, still.badge.height);
      const r = row(page, "Agent levels and experience");
      const snake = await r.locator(".chat-badge-snake").evaluate((el) => getComputedStyle(el).animationName);
      const track = await r.locator(".chat-badge-track").evaluate((el) => getComputedStyle(el).stroke);
      if (reducedMotion === "reduce") {
        assert.equal(snake, "none", `${width}: nothing moves with reduced motion`);
        assert.notEqual(track, "none", `${width}: the whole ring is lit instead`);
        assert.doesNotMatch(track, /rgba\(.*, 0\)|transparent/, `${width}: lit track ${track}`);
      } else {
        assert.equal(snake, "chat-badge-snake", `${width}: the snake goes round`);
      }
      await page.screenshot({ path: join(artifacts, `phone-${width}-${reducedMotion}.png`) });
      await context.close();
    }
  }

  assert.deepEqual(errors, []);
  console.log(`running ring: ok — evidence in ${artifacts}`);
} finally {
  await browser?.close();
  await server.close();
}
