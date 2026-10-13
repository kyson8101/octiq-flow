// App-shell check of a run panel task row: the step a running worker is on,
// on the folded row, and the two tabs of an opened one.
//
//   * folded: `1/7 · <step>` only while an attempt is executing, on one line,
//     cut with an ellipsis, the minutes still on the line; the count alone
//     for a stalled, failed, planned, held or finished row; a report older
//     than ten minutes muted;
//   * opened: the status line, the hold's sentence and the one start above a
//     tablist of Steps and Details; Steps chosen; `No steps reported yet`;
//     arrows, Home and End; a held key moves once; a press that repeats the
//     one on a tab cannot land on a start;
//   * Windows: a work directory with backslashes wraps inside the row and is
//     copied whole; nothing widens the page.
//
// The socket is mocked; everything else is the real App, run panel and CSS.
//
//   OCTIQ_THEME=light|dark|fun|manga|guofeng   the appearance mode (dark)
//   WIDE_FONT=1            a wider font, standing in for a Windows fallback
//   CLASSIC_SCROLLBARS=1   Chromium's 15px classic scrollbars, as on Windows
//   OCTIQ_WEB_ROOT=<dir>   another copy of web/, with SHOTS_ONLY=1 for the
//                          "before" pictures of an older tree (no assertions)
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const webRoot = resolve(process.env.OCTIQ_WEB_ROOT || new URL("../web", import.meta.url).pathname);
const require = createRequire(join(webRoot, "package.json"));
const { createServer } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const shotsOnly = process.env.SHOTS_ONLY === "1";
const wideFont = process.env.WIDE_FONT === "1";
const classic = process.env.CLASSIC_SCROLLBARS === "1";
const theme = process.env.OCTIQ_THEME || "dark";
const artifacts = process.env.OCTIQ_EVIDENCE_DIR || await mkdtemp(join(tmpdir(), "octiq-task-row-steps-"));
await mkdir(artifacts, { recursive: true });
const tag = [theme, wideFont && "wide", classic && "classic"].filter(Boolean).join("-");

const now = Date.now();
const MINUTE = 60_000;
const root = "/Users/kyson/03-projects/octiq-flow";
const WINDOWS_PATH = "C:\\Users\\kyson\\03-projects\\.worktrees\\octiq-flow\\feature\\mission-7ead4bf8c2d740dbaee3e731163b5226";
const RUNNING = "Wire the export button";
const LONGROW = "Validate the panel at every width";
const STALE = "Record the cold-open numbers";
const STALLED = "Rebuild the usage row";
const FAILED = "Training export controls";
const QUEUED = "Document the access rules";
const DONE = "Record final evidence";
const HELD = "Tighten the banner's copy";
const SILENT = "Draw the plan panel";
const FIRST_STEP = "Read the row code and the reference screenshots";
const LONG_STEP = "验证每个视口宽度下的长中英文步骤标签 — validating every viewport width with lengthy mixed Chinese and English step labels that keep on going and going";

const main = {
  id: "main", projectId: "octiq", title: "Show the running step on task rows", customTitle: true, modelId: "claude:opus", access: "auto",
  sessionId: "session-main", cwd: root, createdAt: now - 3_000_000, updatedAt: now - 1_000, coordinatesRun: true,
};
const worker = (id, title) => ({ ...main, id, title, sessionId: `session-${id}`, coordinatesRun: false });
const chats = [main, ...["orch-1", "orch-2", "orch-3", "orch-4", "orch-5", "orch-7", "orch-8", "orch-9"].map((id) => worker(id, id))];
const localChats = chats.map((chat) => ({ ...chat, messages: [{ id: `m-${chat.id}`, role: "assistant", streaming: false, blocks: [{ kind: "text", text: "Ready." }] }] }));

const task = (id, title, status, more = {}) => ({
  id, runId: "run-1", title, spec: "Do the thing, and say what was checked.", dependsOn: [], status,
  destination: { projectId: "octiq", projectName: "OctiqFlow", repository: root },
  worker: { agent: "claude", access: "auto", model: "opus", effort: "high" },
  heldByPlan: false, createdAt: now - 50 * MINUTE, updatedAt: now - 20_000, ...more,
});
const attempt = (id, taskId, chat, more = {}) => ({
  id, runId: "run-1", taskId, number: 1, workerChatKey: `chat:${chat}`, agent: "claude", model: "opus", effort: "high", access: "auto",
  status: "running", cwd: `${root}/.worktrees/${taskId}`, isWorktree: true, filesModified: [], branch: `feature/octiq-${taskId}`,
  execution: { state: "executing", retryCount: 0, lastActivityAt: now - 1_000 },
  createdAt: now - 40 * MINUTE, updatedAt: now - 1_000, ...more,
});
const steps = (states, titles) => states.map((state, index) => ({ state, title: titles[index] ?? `Step ${index + 1}` }));
const told = (list, ago = 30_000) => ({ objective: "x", nextStep: "", reportedBy: "claude", reportedAt: now - ago, steps: list });
const SEVEN = [FIRST_STEP, "Item 6: Steps and Details tabs", "Item 14: the running step", "Tests", "AGENTS.md", "Checks", "Screenshots"];
const NINE = ["读入口文件和 memory", "盘点三首的现状和按路径读它们的脚本", "xiaoke-sit 归位", "slop 归位", "One Heart Inside 音频一半归位", "资料包 git mv 和改路径", "写三首的 README", "核对旧路径、播放器、finals", "清理、记 memory、report"];

const snapshot = {
  runs: [{
    id: "run-1", coordinatorChatKey: "chat:main", objective: "Show the running step on task rows", workspaceId: "octiq", rootPath: root,
    status: "running", maxConcurrent: 4, createdAt: now - 55 * MINUTE, updatedAt: now - 20_000,
    planApproval: { status: "approved", requestedAt: now - 54 * MINUTE, decidedAt: now - 53 * MINUTE },
  }],
  tasks: [
    task("t1", RUNNING, "running", { activeAttemptId: "a1" }),
    task("t2", LONGROW, "running", { activeAttemptId: "a2" }),
    task("t3", STALE, "running", { activeAttemptId: "a3" }),
    task("t4", STALLED, "running", { activeAttemptId: "a4" }),
    task("t5", FAILED, "failed", {
      activeAttemptId: "a5",
      card: {
        problem: "The export controls are scattered across three menus, and the worker lost its connection half way through moving them.",
        goal: "One export button in the action bar that opens one panel; the old entries still work and point at it.",
        acceptance: [
          "The export button is in the action bar on a desktop and behind More on a phone, with its panel placed by the window",
          "The three old menu entries open the same panel and are marked as moved",
          "Nothing is exported until the person confirms, and a failed export says why in the host's own words",
          "web tests, type check and build pass; before and after screenshots at 1280 and 390",
        ],
      },
    }),
    task("t6", QUEUED, "pending", { dependsOn: ["t1"] }),
    // A settled task in a worktree the host kept: pushed, clean, not merged.
    task("t7", DONE, "completed", { activeAttemptId: "a7", workspace: {
      plan: { mode: "worktree", cwd: "/test/tree", checkoutRoot: "/test/tree", repositoryRoot: "/test", branch: "feature/probe", baseBranch: "develop", baseSha: "12345678", managed: true, isRepo: true, warnings: [], initialStatus: "" },
      state: "retained", abandoned: false, validationPaths: [],
      delivery: { headSha: "abcdef12345678", dirty: false, hasCommits: true, pushed: true, merged: false, checkedAt: now - 4 * MINUTE, notes: [] },
    } }),
    task("t8", HELD, "ready", { activeAttemptId: "a8", heldByReopen: true }),
    task("t9", SILENT, "running", { activeAttemptId: "a9" }),
  ],
  attempts: [
    attempt("a1", "t1", "orch-1"),
    attempt("a2", "t2", "orch-2", { createdAt: now - 74 * MINUTE }),
    attempt("a3", "t3", "orch-3"),
    attempt("a4", "t4", "orch-4", { execution: { state: "stalled", retryCount: 0, lastActivityAt: now - 9 * MINUTE } }),
    attempt("a5", "t5", "orch-5", { status: "failed", cwd: WINDOWS_PATH, finishedAt: now - 6 * MINUTE,
      execution: { state: "disconnected", retryCount: 0, latestError: { kind: "transport", message: "The worker's process ended.", at: now - 6 * MINUTE, retryable: true } } }),
    attempt("a7", "t7", "orch-7", { status: "completed", finishedAt: now - 5 * MINUTE, execution: { state: "completed", retryCount: 0 } }),
    attempt("a8", "t8", "orch-8", { status: "completed", finishedAt: now - 8 * MINUTE, execution: { state: "completed", retryCount: 0 } }),
    attempt("a9", "t9", "orch-9"),
  ],
  gates: [], messages: [], notifications: [],
  reports: {
    "chat:orch-1": told(steps(["active", "pending", "pending", "pending", "pending", "pending", "pending"], SEVEN)),
    "chat:orch-2": told(steps(["done", "active", "pending"], ["Read", LONG_STEP, "Commit"])),
    "chat:orch-3": told(steps(["done", "done", "done", "active", "pending", "pending", "pending", "pending", "pending"], ["A", "B", "C", "Measure the cold open at 1280 and 390", "E", "F", "G", "H", "I"]), 25 * MINUTE),
    "chat:orch-4": told(steps(["done", "active", "pending"], ["Read", "Move the timer out of the component", "Commit"])),
    "chat:orch-5": told(steps(["active", ...Array(8).fill("pending")], NINE), 20 * MINUTE),
    "chat:orch-7": told(steps(["done", "done", "done", "done"], ["A", "B", "C", "D"]), 6 * MINUTE),
    "chat:orch-8": told(steps(["done", "done"], ["A", "B"]), 9 * MINUTE),
  },
};

const started = [];
/** What the row sent about a task's workspace. */
const decided = [];
function resultFor(request) {
  switch (request.cmd) {
    case "list_workspaces": return [{ id: "octiq", name: "octiq-flow", primary_path: root }];
    case "chat_index_list": return chats;
    case "chat_index_deleted": return [];
    case "chat_page": return { events: [], context: [], before: null };
    case "chat_list": case "chat_activity": case "permission_pending": case "question_pending":
    case "safety_block_pending": case "pr_repositories": case "codex_skills": case "team_list":
      return [];
    case "chat_queue_state": return { live: false, queuedTurnIds: [] };
    case "orchestration_snapshot": return snapshot;
    case "orchestration_worker_start": started.push(request.args); return null;
    case "orchestration_task_reopen": case "orchestration_workspace_cleanup": case "orchestration_workspace_refresh":
      decided.push({ cmd: request.cmd, ...request.args }); return null;
    case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
    case "usage_summary": return {};
    case "agent_installs": return [{ id: "claude", installed: true, path: "/mock/claude" }];
    case "pr_local_list": case "pr_remote_list": return { items: [], warnings: [] };
    case "sandbox_snapshot": return { defaultEnabled: false, environments: {} };
    case "git_status_summary": return [{ path: root, repo_root: root, is_repo: true, branch: "develop", changed: 0, ahead: 0, behind: 0 }];
    case "git_local_branches": return { is_repo: true, current: "develop", branches: ["develop"], is_worktree: false };
    case "chat_task": return { chatId: request.args?.chatId, projectId: "octiq" };
    default: return null;
  }
}

const server = await createServer({
  root: webRoot,
  configFile: join(webRoot, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  ...(process.env.OCTIQ_WEB_ROOT ? { cacheDir: join(artifacts, ".vite") } : {}),
});
const errors = [];
const report = { artifacts, theme, wideFont, classic, shotsOnly, sizes: {} };

async function open(browser, { width, height, phone = false }) {
  const context = await browser.newContext({
    viewport: { width, height }, reducedMotion: "reduce",
    permissions: ["clipboard-read", "clipboard-write"],
    ...(phone ? { hasTouch: true, isMobile: true } : {}),
  });
  await context.addInitScript(({ stored, mode, wide }) => {
    localStorage.setItem("octiq.v2.gitColumn", "0");
    localStorage.setItem("octiq.theme", mode);
    localStorage.setItem("octiq.v2.theme", mode);
    localStorage.setItem("octiq.v2.conversations", JSON.stringify(stored));
    if (wide) addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = "*, *::before, *::after { font-family: Verdana, sans-serif !important; letter-spacing: 0.02em !important; }";
      document.head.append(style);
    });
  }, { stored: localChats, mode: theme, wide: wideFont });
  await context.route("**/token", (route) => route.fulfill({ body: "mock-token" }));
  await context.route("**/auth", (route) => route.fulfill({ body: "ok" }));
  await context.routeWebSocket(/.*/, (socket) => socket.onMessage((raw) => {
    const request = JSON.parse(String(raw));
    if (request.t !== "invoke") return;
    socket.send(JSON.stringify({ t: "reply", id: request.id, ok: true, result: resultFor(request) }));
  }));
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  page.on("pageerror", (error) => errors.push(error.stack ?? String(error)));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/#/p/octiq-flow/c/main`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  return { context, page };
}

const rowOf = (page, title) => page.locator(".orch-task").filter({ has: page.locator(".orch-task-title", { hasText: title }) });
const noSidewaysScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

/** The run panel on screen with its rows: the Tasks column on a desktop, the
 *  Tasks view on a phone. */
async function openRunPanel(page) {
  const first = rowOf(page, RUNNING);
  const toggle = page.locator(".tasks-toggle").first();
  const view = page.locator("button[aria-pressed]").filter({ hasText: /^(Tasks|Mission)/ }).first();
  // A cold Vite cache on a busy machine takes a while to draw the first page.
  for (let tries = 0; tries < 200 && !(await first.isVisible().catch(() => false)); tries++) {
    if (await view.isVisible().catch(() => false)) {
      if (await view.getAttribute("aria-pressed") !== "true") await view.click().catch(() => {});
    } else if (await toggle.isVisible().catch(() => false) && await toggle.getAttribute("aria-expanded") !== "true") await toggle.click().catch(() => {});
    const accordion = page.locator(".orch-run-accordion-toggle").first();
    if (await accordion.isVisible().catch(() => false) && await accordion.getAttribute("aria-expanded") === "false") await accordion.click().catch(() => {});
    await page.waitForTimeout(500);
  }
  await first.waitFor();
}

/** Line three of a folded row: what it says and where its pieces sit. */
const lineThree = (row) => row.evaluate((article) => {
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, h: r.height }; };
  const note = article.querySelector(".run-row-note");
  const step = article.querySelector(".run-row-step");
  const figures = article.querySelector(".run-row-nums .run-row-figures") ?? article.querySelector(".run-row-figures");
  const summary = article.querySelector(".orch-task-summary");
  return {
    note: note?.textContent ?? null,
    step: step?.textContent ?? null,
    title: note?.getAttribute("title") ?? null,
    stale: note?.hasAttribute("data-stale") ?? false,
    tone: note?.getAttribute("data-tone") ?? null,
    cut: note ? note.scrollWidth > note.clientWidth : false,
    noteBox: box(note), figuresBox: box(figures), figures: figures?.textContent ?? null, summaryBox: box(summary),
    lineHeight: note ? parseFloat(getComputedStyle(note).lineHeight) : 0,
    stepColour: step ? getComputedStyle(step).color : null,
    links: article.querySelectorAll(".run-row-note a, .run-row-note strong, .run-row-note code").length,
    flight: article.hasAttribute("data-flight"),
  };
});

const expand = (page, title) => page.getByRole("button", { name: `Expand task progress: ${title}`, exact: true });

async function folded(page, label, out) {
  const running = await lineThree(rowOf(page, RUNNING));
  const long = await lineThree(rowOf(page, LONGROW));
  const stale = await lineThree(rowOf(page, STALE));
  const stalled = await lineThree(rowOf(page, STALLED));
  const failed = await lineThree(rowOf(page, FAILED));
  const queued = await lineThree(rowOf(page, QUEUED));
  const held = await lineThree(rowOf(page, HELD));
  const silent = await lineThree(rowOf(page, SILENT));
  out.rows = { running: running.note, long: long.note?.slice(0, 40), stale: stale.note, stalled: stalled.note, failed: failed.note, queued: queued.note, held: held.note, silent: silent.note };
  if (shotsOnly) return;

  assert.equal(running.note, `1/7 · ${FIRST_STEP}`, `${label}: the running row names its step after its place`);
  assert.equal(running.flight, true);
  assert.equal(running.stale, false, `${label}: a new report is not muted`);
  assert.match(running.title, new RegExp(`^Step 1 of 7: ${FIRST_STEP}\\n.*0 of 7 reported steps done · reported (just now|\\dm ago)$`), `${label}: the tooltip has the whole step and when`);
  assert.equal(running.links, 0, `${label}: the step is plain text`);

  assert.equal(long.note, `2/3 · ${LONG_STEP}`, `${label}: the long step is in the DOM whole`);
  assert.equal(long.cut, true, `${label}: and is cut on the row`);
  for (const [name, line] of [["running", running], ["long", long], ["stale", stale]]) {
    assert(line.noteBox.h <= line.lineHeight + 1, `${label}: ${name} is one line (${line.noteBox.h})`);
    assert(line.figuresBox, `${label}: ${name} keeps its minutes`);
    assert(Math.abs(line.figuresBox.t - line.noteBox.t) < 2, `${label}: ${name}'s minutes are on the step's line`);
    assert(line.figuresBox.r <= line.summaryBox.r + 0.5, `${label}: ${name}'s minutes are inside the row`);
    assert(line.noteBox.r <= line.figuresBox.l + 0.5, `${label}: ${name}'s step stops before the minutes`);
  }
  assert.match(long.figures, /\d+h \d\dm|\d+m/, `${label}: the minutes are whole (${long.figures})`);

  assert.equal(stale.note, "4/9 · Measure the cold open at 1280 and 390");
  assert.equal(stale.stale, true, `${label}: a report 25 minutes old is muted`);
  // (The fixture's clock is the script's start: a long run adds minutes.)
  assert.match(stale.title, /reported (2[5-9]|3\d)m ago$/, `${label}: and its tooltip says when`);
  assert.notEqual(stale.stepColour, running.stepColour, `${label}: muted is another colour (${stale.stepColour})`);
  out.stepColours = { fresh: running.stepColour, stale: stale.stepColour };

  assert.equal(stalled.note, "Stalled", `${label}: a stalled worker's row says the host's word`);
  assert.equal(stalled.step, null);
  assert.equal(stalled.tone, "warn");
  assert.equal(failed.note, "Failed");
  assert.equal(failed.step, null, `${label}: a failed row names no step`);
  assert.equal(queued.step, null);
  assert.equal(held.step, null, `${label}: a held row names no step`);
  assert.equal(silent.note, null, `${label}: nothing reported, nothing said`);
  assert.equal(await noSidewaysScroll(page), true, `${label}: no sideways scroll`);
}

/** Where a thing is, in the window. */
const place = (locator) => locator.evaluate((el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; });

async function opened(page, label, out, phone) {
  const row = rowOf(page, FAILED);
  const press = (locator) => phone ? locator.tap() : locator.click();
  await press(expand(page, FAILED));
  const tablist = row.getByRole("tablist");
  await tablist.waitFor();
  const stepsTab = row.getByRole("tab", { name: "Steps", exact: true });
  const detailsTab = row.getByRole("tab", { name: "Details", exact: true });
  const start = row.getByRole("button", { name: "Start retry", exact: true });
  const checklist = row.getByRole("list", { name: "Reported checklist" });

  // Steps is what the row opens on, with the start above the tabs.
  assert.equal(await stepsTab.getAttribute("aria-selected"), "true", `${label}: a row opens on Steps`);
  assert.equal(await detailsTab.getAttribute("aria-selected"), "false");
  await checklist.waitFor();
  assert.equal(await checklist.locator("li").count(), 9);
  await row.getByText(/^0 of 9 steps done · reported (2\d|3\d)m ago$/).waitFor();
  assert.equal(await row.locator(".plan-card").isVisible(), false, `${label}: Details is not shown with Steps`);
  assert.equal(await start.isVisible(), true, `${label}: the start is on screen with Steps`);
  const tabsBox = await place(tablist);
  const startBox = await place(start);
  assert(startBox.b <= tabsBox.t + 0.5, `${label}: the start stands above the tabs`);
  const meta = await place(row.locator(".orch-task-meta"));
  assert(meta.b <= tabsBox.t + 0.5, `${label}: the status line stands above the tabs`);
  // One line of tabs, inside the row, in any font.
  const tabBoxes = [await place(stepsTab), await place(detailsTab)];
  assert(Math.abs(tabBoxes[0].t - tabBoxes[1].t) < 1, `${label}: the tabs are on one line`);
  const rowBox = await place(row);
  assert(tabBoxes[1].r <= rowBox.r + 0.5, `${label}: the tabs are inside the row`);
  if (phone) assert(tabBoxes[0].h >= 40, `${label}: a tab is a finger tall (${tabBoxes[0].h})`);
  // The panel is labelled by its tab.
  const labelled = await row.locator('[role="tabpanel"]:not([hidden])').evaluate((panel) => document.getElementById(panel.getAttribute("aria-labelledby"))?.textContent);
  assert.equal(labelled, "Steps", `${label}: the panel is labelled by its tab`);
  const widthOnSteps = rowBox.w;
  await row.screenshot({ path: join(artifacts, `${label}-opened-steps.png`) });

  // Details, by a press or a tap: every other field, and the start still there.
  await press(detailsTab);
  await row.locator(".plan-card").waitFor();
  assert.equal(await detailsTab.getAttribute("aria-selected"), "true");
  assert.equal(await checklist.isVisible(), false, `${label}: Steps is not shown with Details`);
  assert.equal(await start.isVisible(), true, `${label}: the start is on screen with Details`);
  for (const field of ["Branch", "Work directory", "Worktree", "Owner", "Model", "Effort", "Problem", "Goal", "Acceptance"]) {
    assert.equal(await row.locator(".plan-card dt", { hasText: new RegExp(`^${field}$`) }).isVisible(), true, `${label}: Details has ${field}`);
  }
  assert.equal(await row.locator(".orch-task-more-summary").isVisible(), true, `${label}: Details has the Task details disclosure`);

  // A Windows work directory: wrapped inside its cell, copied whole.
  const path = row.locator(".plan-card-path");
  assert.equal((await path.evaluate((el) => el.firstChild.textContent)), WINDOWS_PATH, `${label}: the path is drawn as it is`);
  const pathBox = await place(path);
  const detailBox = await place(row.locator(".orch-task-detail"));
  assert(pathBox.r <= detailBox.r + 0.5, `${label}: the path stays inside the row (${pathBox.r} of ${detailBox.r})`);
  const lines = await path.evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight || "16")));
  out.pathLines = lines;
  if (phone) assert(pathBox.h > 20, `${label}: the path wraps on a phone`);
  const rowOnDetails = await place(row);
  assert(Math.abs(rowOnDetails.w - widthOnSteps) < 0.5 || classic, `${label}: the row is as wide on Details as on Steps`);
  out.rowWidth = { steps: widthOnSteps, details: rowOnDetails.w };
  assert.equal(await noSidewaysScroll(page), true, `${label}: no sideways scroll with Details open`);
  await press(row.getByRole("button", { name: "Copy work directory path", exact: true }));
  await page.waitForFunction(async (expected) => (await navigator.clipboard.readText()) === expected, WINDOWS_PATH, { timeout: 5_000 })
    .catch(async () => assert.fail(`${label}: copied ${JSON.stringify(await page.evaluate(() => navigator.clipboard.readText()))}`));
  await row.screenshot({ path: join(artifacts, `${label}-opened-details.png`) });

  // A press that repeats the one on a tab cannot land on the start. The tab
  // was pressed a moment ago at a spot; a press at that spot reaching the
  // start (it slid there) is dropped, and one made later goes through.
  if (!phone) {
    await page.waitForTimeout(900);
    const spot = await place(stepsTab);
    const at = { x: spot.l + spot.w / 2, y: spot.t + spot.h / 2 };
    await page.mouse.click(at.x, at.y);
    assert.equal(await stepsTab.getAttribute("aria-selected"), "true");
    const strayDefaulted = await start.evaluate((button, point) => {
      const click = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1, clientX: point.x + 2, clientY: point.y + 2 });
      button.dispatchEvent(click);
      return click.defaultPrevented;
    }, at);
    await page.waitForTimeout(150);
    assert.equal(strayDefaulted, true, `${label}: the repeated press is dropped`);
    assert.equal(started.length, 0, `${label}: and starts nothing`);
    // Somewhere else, at once: a pointer that moved is a new press.
    out.strayDropped = true;

    // Keys: arrows move between the two and take the focus with them.
    await stepsTab.focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await detailsTab.getAttribute("aria-selected"), "true", `${label}: ArrowRight goes to Details`);
    assert.equal(await detailsTab.evaluate((el) => el === document.activeElement), true, `${label}: and takes the focus`);
    assert.equal(await stepsTab.getAttribute("tabindex"), "-1");
    await page.keyboard.press("ArrowRight");
    assert.equal(await stepsTab.getAttribute("aria-selected"), "true", `${label}: and wraps`);
    await page.keyboard.press("End");
    assert.equal(await detailsTab.getAttribute("aria-selected"), "true");
    await page.keyboard.press("Home");
    assert.equal(await stepsTab.getAttribute("aria-selected"), "true");
    // A held arrow moves once.
    await page.keyboard.down("ArrowRight");
    await page.keyboard.down("ArrowRight");
    await page.keyboard.down("ArrowRight");
    await page.keyboard.up("ArrowRight");
    assert.equal(await detailsTab.getAttribute("aria-selected"), "true", `${label}: a held arrow moves once`);
    // Enter chooses the focused tab, and held, reaches nothing else.
    await page.keyboard.press("Home");
    await detailsTab.focus();
    await page.keyboard.down("Enter");
    await page.keyboard.down("Enter");
    await page.keyboard.down("Enter");
    await page.keyboard.up("Enter");
    assert.equal(await detailsTab.getAttribute("aria-selected"), "true", `${label}: Enter chooses the tab`);
    assert.equal(await detailsTab.evaluate((el) => el === document.activeElement), true, `${label}: and the focus stays on it`);
    assert.equal(started.length, 0, `${label}: a held key starts nothing`);
    // Tab leaves the tablist for the panel's own controls.
    await page.keyboard.press("Home");
    await page.keyboard.press("Tab");
    assert.equal(await row.locator('[role="tabpanel"]:not([hidden])').evaluate((el) => el === document.activeElement), true, `${label}: Tab goes from the tab to its panel`);

    // The start, pressed for itself, starts.
    await page.waitForTimeout(800);
    await start.click();
    await page.waitForFunction(() => true);
    await page.waitForTimeout(200);
    assert.equal(started.length, 1, `${label}: the start still starts when it is pressed`);
    // What it starts is the fixture's failed task, as its last attempt ran.
    assert.deepEqual(
      { taskId: started[0].taskId, retryOf: started[0].retryOf, agent: started[0].agent, model: started[0].model, effort: started[0].effort, access: started[0].access },
      { taskId: "t5", retryOf: "a5", agent: "claude", model: "opus", effort: "high", access: "auto" },
      `${label}: and starts the failed task's own attempt again`,
    );
    started.length = 0;
  }

  // The whole step is readable without a pointer: the Steps tab lists it.
  await press(expand(page, LONGROW));
  await rowOf(page, LONGROW).locator(".orch-task-steps li", { hasText: LONG_STEP }).waitFor({ state: "visible" });
  assert.equal(await noSidewaysScroll(page), true, `${label}: the long step wraps in the checklist`);

  // A held task: its sentence and its switched-off start, above the tabs.
  await press(expand(page, HELD));
  const heldRow = rowOf(page, HELD);
  const heldStart = heldRow.getByRole("button", { name: "Start next attempt", exact: true });
  await heldStart.waitFor();
  assert.equal(await heldStart.getAttribute("aria-disabled"), "true", `${label}: a start the host would refuse is switched off`);
  const heldTabs = await place(heldRow.getByRole("tablist"));
  assert((await place(heldStart)).b <= heldTabs.t + 0.5, `${label}: and stands above the tabs`);
  assert((await place(heldRow.locator(".orch-task-hold"))).b <= heldTabs.t + 0.5, `${label}: with the hold's sentence`);

  // Nothing reported: one line, on Steps.
  await press(expand(page, SILENT));
  const silentRow = rowOf(page, SILENT);
  await silentRow.getByText("No steps reported yet", { exact: true }).waitFor();
  assert.equal(await silentRow.getByRole("tab", { name: "Steps", exact: true }).getAttribute("aria-selected"), "true", `${label}: it does not jump to Details`);
  await page.screenshot({ path: join(artifacts, `${label}-opened-all.png`), fullPage: false });
}

/** What decides a task's workspace (back to work after a review, its
 *  worktree removed or abandoned) stands above the tabs on both of them,
 *  and is not fired by the key or press that brought it on screen. */
async function delivery(page, label, out, phone) {
  const press = (locator) => phone ? locator.tap() : locator.click();
  const group = page.locator(".run-group-head").filter({ hasText: "Finished" });
  if (await group.getAttribute("aria-expanded") !== "true") await press(group);
  const row = rowOf(page, DONE);
  await press(expand(page, DONE));
  const tablist = row.getByRole("tablist");
  await tablist.waitFor();
  const reopen = row.getByRole("button", { name: "Continue after review", exact: true });
  const abandon = row.getByRole("button", { name: "Abandon workspace…", exact: true });
  // The row's own two panels: the whole row sits in the run panel's Tasks
  // tabpanel, so `[role="tabpanel"]` alone is true of everything on it.
  const inTab = (locator) => locator.evaluate((el) => !!el.closest(".orch-task-tab-panel"));
  decided.length = 0;

  // On both tabs, above the tablist, in neither panel.
  for (const tab of ["Steps", "Details"]) {
    await press(row.getByRole("tab", { name: tab, exact: true }));
    for (const [name, control] of [["Continue after review", reopen], ["Abandon workspace", abandon]]) {
      assert.equal(await control.isVisible(), true, `${label}: ${name} is on screen with ${tab}`);
      assert.equal(await inTab(control), false, `${label}: ${name} is in no tab`);
      assert((await place(control)).b <= (await place(tablist)).t + 0.5, `${label}: ${name} stands above the tabs`);
    }
  }
  assert.equal(await row.locator(".orch-task-tab-panel button", { hasText: /Continue after review|Clean up worktree|Abandon workspace|Reopen task|Confirm removal|Refresh delivery/ }).count(), 0,
    `${label}: no tab holds a delivery control`);
  // The facts stay in Details.
  await press(row.locator(".orch-task-more-summary"));
  assert.match(await row.locator(".orch-task-tab-panel .orch-workspace > summary").evaluate((el) => el.textContent), /^Delivery\s*Pushed · awaiting review$/,
    `${label}: Details keeps the delivery's facts`);
  await press(row.getByRole("tab", { name: "Steps", exact: true }));
  await row.screenshot({ path: join(artifacts, `${label}-delivery-row.png`) });

  // Abandon, by the keyboard: a held Enter opens the question and answers
  // nothing; the focus is on the safe answer, which a second Enter gives.
  await abandon.focus();
  await page.keyboard.down("Enter");
  await page.keyboard.down("Enter");
  await page.keyboard.down("Enter");
  await page.keyboard.up("Enter");
  const keep = row.getByRole("button", { name: "Keep worktree", exact: true });
  const confirm = row.getByRole("button", { name: "Confirm removal", exact: true });
  await confirm.waitFor();
  assert.equal(await inTab(confirm), false, `${label}: the question is in no tab`);
  assert((await place(confirm)).b <= (await place(tablist)).t + 0.5, `${label}: and stands above the tabs`);
  assert.equal(await keep.evaluate((el) => el === document.activeElement), true, `${label}: the question puts the focus on Keep worktree`);
  assert.equal(decided.length, 0, `${label}: a held Enter removes nothing`);
  await row.screenshot({ path: join(artifacts, `${label}-delivery-question.png`) });
  await page.keyboard.press("Enter");
  await abandon.waitFor();
  assert.equal(await confirm.count(), 0, `${label}: a second Enter keeps the worktree`);
  assert.equal(await abandon.evaluate((el) => el === document.activeElement), true, `${label}: and the keyboard is back on the control that asked`);
  assert.equal(decided.length, 0);
  // Escape takes the question away.
  await page.keyboard.press("Enter");
  await confirm.waitFor();
  await page.keyboard.press("Escape");
  await abandon.waitFor();
  assert.equal(decided.length, 0, `${label}: Escape removes nothing`);

  // By a press: one that repeats the opener's, where the confirming answer
  // was drawn, removes nothing; a press aimed at it later does.
  await page.waitForTimeout(800);
  const at = await abandon.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  if (phone) await page.touchscreen.tap(at.x, at.y); else await page.mouse.click(at.x, at.y);
  await confirm.waitFor();
  const stray = await confirm.evaluate((el, spot) => {
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1, clientX: spot.x, clientY: spot.y });
    el.dispatchEvent(click);
    return click.defaultPrevented;
  }, at);
  assert.equal(stray, true, `${label}: a press that repeats the opener's is dropped`);
  assert.equal(decided.length, 0, `${label}: and removes nothing`);
  assert.equal(await confirm.isVisible(), true, `${label}: the question is still asked`);
  // Held on the confirming answer, Enter answers once and opens nothing again.
  await page.waitForTimeout(800);
  await confirm.focus();
  await page.keyboard.down("Enter");
  await page.keyboard.down("Enter");
  await page.keyboard.down("Enter");
  await page.keyboard.up("Enter");
  await page.waitForFunction(() => true);
  await page.waitForTimeout(200);
  assert.deepEqual(decided, [{ cmd: "orchestration_workspace_cleanup", actorChatKey: decided[0]?.actorChatKey, taskId: "t7", abandon: true, expectedHead: "abcdef12345678" }],
    `${label}: Confirm removal, aimed at, abandons this task's worktree once`);
  assert.equal(await confirm.count(), 0, `${label}: and the held key does not ask again`);
  decided.length = 0;

  // Continue after review: the fixes' box has the focus, where a held Enter
  // writes nothing; the reopening is sent once, with the words.
  await reopen.focus();
  await page.keyboard.down("Enter");
  await page.keyboard.down("Enter");
  await page.keyboard.down("Enter");
  await page.keyboard.up("Enter");
  const box = row.getByRole("textbox", { name: `Review fixes for ${DONE}`, exact: true });
  const send = row.getByRole("button", { name: "Reopen task in this workspace", exact: true });
  await box.waitFor();
  assert.equal(await box.evaluate((el) => el === document.activeElement), true, `${label}: the reopening puts the focus in the box`);
  assert.equal(await box.inputValue(), "", `${label}: the key that opened it writes nothing`);
  assert.equal(await inTab(send), false, `${label}: the reopening is in no tab`);
  assert.equal(await send.isDisabled(), true, `${label}: and cannot be sent empty`);
  await box.fill("Correct the review findings.");
  await row.screenshot({ path: join(artifacts, `${label}-delivery-reopen.png`) });
  await press(send);
  await page.waitForTimeout(200);
  assert.deepEqual(decided, [{ cmd: "orchestration_task_reopen", actorChatKey: decided[0]?.actorChatKey, taskId: "t7", spec: "Correct the review findings." }],
    `${label}: the reopening is sent once, for this task`);
  assert.equal(await noSidewaysScroll(page), true, `${label}: no sideways scroll with the delivery row`);
  out.delivery = { controls: await row.locator(".orch-delivery-actions button").allTextContents() };
  decided.length = 0;
}

/** With scrollbars that take room: a tab whose content makes the panel
 *  scroll must not change the row's width. */
async function scrollbars(page, label, out) {
  const row = rowOf(page, FAILED);
  const scroller = await row.evaluateHandle((el) => {
    let node = el.parentElement;
    while (node && !/(auto|scroll)/.test(getComputedStyle(node).overflowY)) node = node.parentElement;
    return node;
  });
  const measure = async () => ({
    row: (await place(row)).w,
    bar: await scroller.evaluate((el) => el.offsetWidth - el.clientWidth),
    scrolls: await scroller.evaluate((el) => el.scrollHeight > el.clientHeight),
    scroller: await scroller.evaluate((el) => el.className),
  });
  await expand(page, FAILED).click();
  await row.getByRole("tablist").waitFor();
  const stepsTab = row.getByRole("tab", { name: "Steps", exact: true });
  const detailsTab = row.getByRole("tab", { name: "Details", exact: true });
  // Find a window in which Steps fits and Details does not: the one case in
  // which choosing a tab brings a scrollbar.
  let found = null;
  for (let height = 2400; height >= 700 && !found; height -= 24) {
    await page.setViewportSize({ width: 1280, height });
    await stepsTab.click();
    const steps = await measure();
    if (steps.scrolls) break;
    await detailsTab.click();
    await row.locator(".plan-card").waitFor();
    const details = await measure();
    if (details.scrolls) found = { height, steps, details };
  }
  out.scrollbars = found ?? { none: "no window in which only Details scrolls" };
  assert(found, `${label}: a window in which only Details scrolls`);
  assert(found.details.bar > 0 || found.steps.bar > 0, `${label}: this run draws scrollbars that take room`);
  await page.screenshot({ path: join(artifacts, `${label}-scrollbar-details.png`) });
  assert(Math.abs(found.steps.row - found.details.row) < 0.5,
    `${label}: the row is ${found.steps.row} wide on Steps and ${found.details.row} on Details, in a window ${found.height} tall`);
}

let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(classic ? { ignoreDefaultArgs: ["--hide-scrollbars"], args: ["--disable-features=OverlayScrollbar"] } : {}),
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  for (const size of [{ name: "1280", width: 1280, height: 900, phone: false }, { name: "390", width: 390, height: 844, phone: true }]) {
    const label = `${tag}-${size.name}`;
    const out = report.sizes[size.name] = {};
    const { context, page } = await open(browser, size);
    await openRunPanel(page);
    await folded(page, label, out);
    await page.screenshot({ path: join(artifacts, `${label}-folded.png`) });
    if (shotsOnly) {
      // The same rows opened, as the older tree draws them.
      const press = (locator) => size.phone ? locator.tap() : locator.click();
      await press(expand(page, FAILED));
      await page.waitForTimeout(300);
      await rowOf(page, FAILED).screenshot({ path: join(artifacts, `${label}-opened.png`) });
    } else {
      await opened(page, label, out, size.phone);
      await delivery(page, label, out, size.phone);
    }
    await context.close();
    if (classic && !size.phone) {
      const short = await open(browser, { width: 1280, height: 2400 });
      await openRunPanel(short.page);
      await scrollbars(short.page, label, out);
      await short.context.close();
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, mockedBackend: true, ...report }, null, 1));
} catch (error) {
  const page = browser?.contexts().at(-1)?.pages().at(-1);
  await page?.screenshot({ path: join(artifacts, `${tag}-failure.png`), fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ error: String(error), errors, report }, null, 1));
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
