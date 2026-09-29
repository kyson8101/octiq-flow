// App-shell regression for the run panel's task rows showing their worker's
// reported checklist without being expanded: "2/5 steps · Running tests" on a
// running row, "Last step: …" on a blocked one, nothing on a queued one, and a
// long mixed-script step that wraps inside the row at 390px, in Light, Dark and
// Fun. A report arriving on the socket moves the row with no reload. The
// socket is mocked; everything else is the real App, run panel and CSS.
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const artifacts = process.env.OCTIQ_EVIDENCE_DIR
  || await mkdtemp(join(tmpdir(), "octiq-task-row-steps-"));
await mkdir(artifacts, { recursive: true });

const now = Date.now();
const RUNNING = "Wire the export button";
const LONGROW = "Validate the panel at every width";
const BLOCKED = "Training export controls";
const QUEUED = "Document the access rules";
const DONE = "Record final evidence";
const LONG_STEP = "验证每个视口宽度下的长中英文步骤标签 — validating every viewport width with lengthy mixed Chinese and English step labels that keep on going";
const chat = (id, title) => ({
  id, projectId: "general", title, customTitle: true, modelId: "claude:opus", access: "auto",
  sessionId: `session-${id}`, createdAt: now - 200_000, updatedAt: now - 190_000,
});
const chats = [chat("lead", "Show steps on task rows"), chat("orch-1", RUNNING), chat("orch-2", LONGROW), chat("orch-3", BLOCKED), chat("orch-5", DONE)];
const task = (id, over) => ({
  id, runId: "run-lead", spec: "", dependsOn: [], createdAt: now - 180_000, updatedAt: now - 20_000, ...over,
});
const attempt = (id, taskId, chatKey, over = {}) => ({
  id, runId: "run-lead", taskId, number: 1, workerChatKey: chatKey, agent: "claude", access: "auto",
  status: "running", cwd: "/w", isWorktree: true, filesModified: [], branch: `feature/octiq-${taskId}0b4b3f9de3389fda92388f`,
  execution: { state: "executing", retryCount: 0, lastActivityAt: now - 1_000 },
  createdAt: now - 141_000, updatedAt: now - 1_000, ...over,
});
const steps = (states, titles) => states.map((state, index) => ({ state, title: titles[index] }));
const report = (list, over = {}) => ({ objective: "x", nextStep: "", reportedBy: "claude", reportedAt: now - 30_000, steps: list, ...over });
const FIVE = ["Read the row", "Write the summary", "Running tests", "Review", "Commit"];
const snapshot = {
  runs: [{ id: "run-lead", coordinatorChatKey: "chat:lead", objective: "Show checklist progress on task rows", workspaceId: "general",
    rootPath: "/Users/kyson/General", status: "running", maxConcurrent: 4, createdAt: now - 190_000, updatedAt: now - 20_000,
    planApproval: { status: "approved", requestedAt: now - 189_000, decidedAt: now - 188_000 } }],
  tasks: [
    task("t1", { title: RUNNING, status: "running", activeAttemptId: "a1" }),
    task("t2", { title: LONGROW, status: "running", activeAttemptId: "a2" }),
    task("t3", { title: BLOCKED, status: "blocked", activeAttemptId: "a3" }),
    task("t4", { title: QUEUED, status: "pending", activeAttemptId: null, dependsOn: ["t1"] }),
    task("t5", { title: DONE, status: "completed", activeAttemptId: "a5" }),
  ],
  attempts: [
    attempt("a1", "t1", "chat:orch-1", { execution: { state: "waiting_tool", retryCount: 0, lastActivityAt: now - 1_000, currentOperation: "Bash", pendingTools: { t: "Bash" } } }),
    attempt("a2", "t2", "chat:orch-2"),
    attempt("a3", "t3", "chat:orch-3", { status: "blocked", execution: { state: "blocked", retryCount: 0 } }),
    attempt("a5", "t5", "chat:orch-5", { status: "completed", finishedAt: now - 5_000, execution: { state: "completed", retryCount: 0 } }),
  ],
  gates: [], messages: [],
  reports: {
    "chat:orch-1": report(steps(["done", "done", "active", "pending", "pending"], FIVE)),
    "chat:orch-2": report(steps(["done", "active", "pending"], ["Read", LONG_STEP, "Commit"])),
    "chat:orch-3": report(steps(["done", "done", "done", "active", "pending", "pending"], ["A", "B", "C", "Ask for the export format", "E", "F"])),
    "chat:orch-5": report(steps(["done", "done", "done", "done", "pending"], ["A", "B", "C", "D", "E"])),
  },
};

const logs = new Map();
for (const { id, title } of chats) {
  logs.set(`chat:${id}`, [
    { seq: 1, event: { type: "user", uuid: `u-${id}`, octiq_user_turn: true, message: { content: [{ type: "text", text: `Start: ${title}` }] } } },
    { seq: 2, event: { type: "item.completed", item: { id: `i-${id}`, type: "agent_message", text: `First answer in ${id}.` } } },
    { seq: 3, event: { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } } },
  ]);
}

const errors = [];
const server = await createServer({
  root: new URL("../web", import.meta.url).pathname,
  configFile: new URL("../web/vite.config.ts", import.meta.url).pathname,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
function resultFor(request) {
  switch (request.cmd) {
    case "list_workspaces": return [{ id: "general", name: "General", primary_path: "/Users/kyson/General" }];
    case "chat_index_list": return chats;
    case "chat_index_deleted": return [];
    case "chat_page": return { events: logs.get(request.args?.key) ?? [], context: [], before: null };
    case "chat_since": return (logs.get(request.args?.key) ?? []).filter((frame) => frame.seq > (request.args?.after ?? 0));
    case "chat_list": return chats.map(({ id }) => `chat:${id}`);
    case "chat_activity": return [];
    case "chat_queue_state": return { live: true, queuedTurnIds: [] };
    case "orchestration_snapshot": return snapshot;
    case "permission_pending": return [];
    case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
    case "usage_summary": return {};
    case "agent_installs": return [{ id: "codex", installed: true, path: "/mock/codex" }, { id: "claude", installed: true, path: "/mock/claude" }];
    case "team_list": return [];
    case "chat_task": return { chatId: request.args?.chatId, projectId: "general" };
    case "sandbox_snapshot": return { defaultEnabled: false, environments: {} };
    case "codex_skills": return [];
    default: return null;
  }
}

const rowOf = (page, title) => page.locator(".orch-task").filter({ has: page.locator(".orch-task-title", { hasText: title }) });
const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

async function openRunPanel(page, phone) {
  if (phone) {
    const tasksView = page.locator("button[aria-pressed]").filter({ hasText: /^(Tasks|Run)/ }).first();
    await tasksView.waitFor();
    for (let i = 0; i < 5 && await tasksView.getAttribute("aria-pressed") !== "true"; i++) {
      await tasksView.click();
      await page.waitForTimeout(200);
    }
  }
  const toggle = page.locator(".orch-run-accordion-toggle").first();
  if (await toggle.count() && await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
  await rowOf(page, QUEUED).waitFor();
}

/** What line two of a row says, and where its pieces sit. */
const lineTwo = (row) => row.evaluate((article) => {
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, h: r.height }; };
  const progress = article.querySelector(".orch-task-progress");
  return {
    state: article.querySelector(".orch-task-state")?.textContent,
    progress: progress?.textContent ?? null,
    current: progress?.hasAttribute("data-current") ?? false,
    progressBox: box(progress),
    lineHeight: progress ? parseFloat(getComputedStyle(progress).lineHeight) : 0,
    heading: box(article.querySelector(".orch-task-heading")),
    actions: box(article.querySelector(".orch-task-actions")),
    stepColor: progress?.querySelector(".orch-task-step") ? getComputedStyle(progress.querySelector(".orch-task-step")).color : null,
  };
});

let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
  const results = [];
  for (const theme of ["light", "dark", "fun"]) {
    for (const viewport of [{ name: "1440", width: 1440, height: 960, phone: false }, { name: "390", width: 390, height: 844, phone: true }]) {
      const label = `${theme}-${viewport.name}`;
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height }, reducedMotion: "reduce",
        ...(viewport.phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
      });
      await context.addInitScript((mode) => {
        if (location.protocol === "about:") return;
        localStorage.setItem("octiq.theme", mode);
        localStorage.setItem("octiq.v2.gitColumn", "0");
      }, theme);
      await context.route("**/token", (route) => route.fulfill({ body: "mock-token" }));
      await context.route("**/auth", (route) => route.fulfill({ body: "ok" }));
      let appSocket;
      await context.routeWebSocket(/.*/, (socket) => {
        appSocket = socket;
        socket.onMessage((raw) => {
          const request = JSON.parse(String(raw));
          if (request.t !== "invoke") return;
          socket.send(JSON.stringify({ t: "reply", id: request.id, ok: true, result: resultFor(request) }));
        });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(30_000);
      page.on("pageerror", (error) => errors.push(`${label}: ${error.stack ?? error}`));
      await page.goto(`${base}#/p/general/c/lead`, { waitUntil: "domcontentloaded" });
      await openRunPanel(page, viewport.phone);

      const running = await lineTwo(rowOf(page, RUNNING));
      assert.match(running.state, /^Waiting for a tool/, `${label}: host word leads`);
      assert.equal(running.progress, "2/5 steps · Running tests", `${label}: running row`);
      assert.equal(running.current, true);

      const long = await lineTwo(rowOf(page, LONGROW));
      assert.equal(long.progress, `1/3 steps · ${LONG_STEP}`, `${label}: long step in the DOM whole`);
      assert(long.progressBox.r <= long.heading.r + 0.5, `${label}: long step stays inside the row`);
      assert(long.progressBox.h <= long.lineHeight * 2 + 1, `${label}: long step stops at two lines (${long.progressBox.h})`);
      const overlaps = (a, b) => a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5;
      assert(!overlaps(long.progressBox, long.actions), `${label}: long step never runs under the controls`);

      const blocked = await lineTwo(rowOf(page, BLOCKED));
      assert.match(blocked.state, /^Blocked/, `${label}: blocked stays blocked`);
      assert.equal(blocked.progress, "3/6 steps · Last step: Ask for the export format", `${label}: blocked row`);
      assert.equal(blocked.current, false);

      const queued = await lineTwo(rowOf(page, QUEUED));
      assert.match(queued.state, /^Queued/);
      assert.equal(queued.progress, null, `${label}: queued row has no count`);

      const done = await lineTwo(rowOf(page, DONE));
      assert.equal(done.progress, "4/5 steps", `${label}: a finished row keeps its reported count`);

      assert.equal(await noHorizontalScroll(page), true, `${label}: no sideways scroll`);
      const panel = page.locator(".orch-task").first().locator("xpath=..");
      await panel.screenshot({ path: join(artifacts, `${label}-rows.png`) });

      // The whole step is readable without hover: the row's disclosure lists it.
      await page.getByRole("button", { name: `Expand task progress: ${LONGROW}`, exact: true }).click();
      const detail = rowOf(page, LONGROW).locator(".orch-task-steps li", { hasText: LONG_STEP });
      await detail.waitFor({ state: "visible" });
      await panel.screenshot({ path: join(artifacts, `${label}-long-expanded.png`) });
      await page.getByRole("button", { name: `Collapse task progress: ${LONGROW}`, exact: true }).click();

      // A report arriving on the socket moves the row, with no read and no reload.
      appSocket.send(JSON.stringify({ t: "event", event: "chat-task", payload: { chatId: "orch-1", projectId: "general",
        report: report(steps(["done", "done", "done", "active", "pending"], FIVE), { reportedAt: Date.now() }) } }));
      await rowOf(page, RUNNING).locator(".orch-task-progress", { hasText: "3/5 steps · Review" }).waitFor();

      // The row still opens its chat from line two.
      await rowOf(page, RUNNING).locator(".orch-task-progress").click();
      await page.waitForURL(/\/c\/orch-1$/);
      results.push({ label, running: running.progress, blocked: blocked.progress, longHeight: Math.round(long.progressBox.h), stepColor: running.stepColor });
      await context.close();
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, mockedBackend: true, artifacts, results }));
} catch (error) {
  const page = browser?.contexts()[0]?.pages().at(-1);
  await page?.screenshot({ path: join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ error: String(error), errors, url: page?.url() }));
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
