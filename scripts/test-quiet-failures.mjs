// App-shell check of a failure by whose move it is: the chat list's line,
// the line above the composer and the run panel's row, over the ledgers the
// host itself recorded (`web/src/lib/__fixtures__/host`, from `retry_tests`).
//
//   coordinator   failed once, retries remain        quiet: grey, counted nowhere
//   retrying      the coordinator's retry at work    grey "Retrying"
//   person        both retries used                  red, under Needs you, one decision
//   escalated     the coordinator asks the person    red; the gate is the decision, once
//   replaced      another task replaced it           "Replaced", counted nowhere
//   completed     a failed check, run "completed"    quiet: the run has not ended
//   stopped       its run was stopped                muted "Failed", counted nowhere
//
// Nothing of a ledger that a failure is read from is changed. What is: the
// run's coordinator and project are renamed to the mock's chat and project,
// every task is handed to one agent, and the host's test title ("Implement")
// is replaced by a longer one, so a row is as wide as a real one.
//
// The socket is mocked; everything else is the real App, sidebar, run panel
// and CSS.
//
//   OCTIQ_THEME=light|dark|fun|manga|guofeng   the appearance mode (dark)
//   WIDE_FONT=1            a wider font, standing in for a Windows fallback
//   CLASSIC_SCROLLBARS=1   Chromium's 15px classic scrollbars, as on Windows
//   OCTIQ_EVIDENCE_DIR=<dir>   where the screenshots go
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const webRoot = resolve(new URL("../web", import.meta.url).pathname);
const require = createRequire(join(webRoot, "package.json"));
const { createServer } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const wideFont = process.env.WIDE_FONT === "1";
const classic = process.env.CLASSIC_SCROLLBARS === "1";
const theme = process.env.OCTIQ_THEME || "dark";
const artifacts = process.env.OCTIQ_EVIDENCE_DIR || await mkdtemp(join(tmpdir(), "octiq-quiet-failures-"));
await mkdir(artifacts, { recursive: true });
const tag = [theme, wideFont && "wide", classic && "classic"].filter(Boolean).join("-");

const root = "/Users/kyson/03-projects/octiq-flow";
const TITLE = "Training export controls";
const COORDINATOR = "Waiting on the coordinator";

/** What each ledger has to draw. Written by hand. */
const SCENES = [
  { name: "coordinator", file: "failure_awaits_coordinator", line: "Running · 0/1 done", lineTone: null, strip: ["running", "Running"],
    row: { state: "running", failure: "coordinator", group: "Running", note: COORDINATOR, red: false }, ask: null, attention: null, badge: false },
  { name: "retrying", file: "retry_executing", line: "Running · 0/1 done", lineTone: null, strip: ["running", "Running"],
    row: { state: "running", failure: null, group: "Running", note: "Retrying", red: false }, ask: null, attention: null, badge: false },
  { name: "person", file: "failure_awaits_person", line: "1 failed · 0/1 done", lineTone: "danger", strip: ["failed", "1 failed"],
    row: { state: "failed", failure: "person", group: "Needs you", note: "Failed", red: true },
    ask: "Its 2 automatic retries are used. Open this row for Start retry, or stop or archive the run.", attention: "1 failed", badge: true },
  { name: "escalated", file: "failure_escalated", line: "1 failed · 0/2 done", lineTone: "danger", strip: ["failed", "1 failed"],
    row: { state: "failed", failure: "person", group: "Needs you", note: "Failed", red: true },
    ask: "Its coordinator asks you: It failed three times on the linker. Start it again, replace it, or leave it? Answer it under Needs you above, open this row for Start retry, or stop or archive the run.",
    attention: "1 failed", badge: true },
  { name: "replaced", file: "failure_replaced", line: "Running · 0/1 done", lineTone: null, strip: ["running", "Running"],
    row: { state: "closed", failure: null, group: "Finished", note: "Replaced", red: false }, ask: null, attention: null, badge: false },
  { name: "completed", file: "failure_in_completed_run", line: "Running · 0/1 done", lineTone: null, strip: ["running", "Running"],
    row: { state: "running", failure: "coordinator", group: "Running", note: COORDINATOR, red: false }, ask: null, attention: null, badge: false },
  { name: "stopped", file: "failure_in_stopped_run", line: "Stopped", lineTone: null, strip: null,
    row: { state: "closed", failure: "history", group: "Finished", note: "Failed", red: false }, ask: null, attention: null, badge: false },
];

/** One of the host's ledgers, set in the mock's chat and project. */
async function ledger(file) {
  const text = await readFile(join(webRoot, "src/lib/__fixtures__/host", `${file}.json`), "utf8");
  const coordinator = JSON.stringify(JSON.parse(text).runs[0].coordinatorChatKey);
  const snapshot = JSON.parse(text.replaceAll(coordinator, JSON.stringify("chat:main")));
  snapshot.runs = snapshot.runs.map((run) => ({ ...run, workspaceId: "octiq", objective: "Move the export controls into one panel" }));
  snapshot.tasks = snapshot.tasks.map((task, index) => ({
    ...task, title: index === 0 ? TITLE : "Training export controls, started over", assignee: { id: "fe", name: "OCTIQ FE" },
  }));
  return snapshot;
}

function mock(snapshot) {
  const stamp = Math.max(...snapshot.tasks.map((task) => task.updatedAt));
  const main = {
    id: "main", projectId: "octiq", title: "Move the export controls", customTitle: true, modelId: "claude:opus", access: "auto",
    sessionId: "session-main", cwd: root, createdAt: stamp - 3_000_000, updatedAt: stamp, coordinatesRun: true,
  };
  const other = { ...main, id: "elsewhere", title: "Another conversation", sessionId: "session-elsewhere", coordinatesRun: false, updatedAt: stamp - 60_000 };
  const workers = snapshot.attempts.map((attempt) => ({ ...main, id: attempt.workerChatKey.replace(/^chat:/, ""), title: "Worker", sessionId: `session-${attempt.id}`, coordinatesRun: false }));
  const chats = [main, other, ...workers];
  const stored = chats.map((chat) => ({ ...chat, messages: [{ id: `m-${chat.id}`, role: "assistant", streaming: false, blocks: [{ kind: "text", text: "Ready." }] }] }));
  const resultFor = (request) => {
    switch (request.cmd) {
      case "list_workspaces": return [{ id: "octiq", name: "octiq-flow", primary_path: root }];
      case "chat_index_list": return chats;
      case "chat_index_deleted": return [];
      case "chat_page": return { events: [], context: [], before: null };
      case "chat_list": case "chat_activity": case "permission_pending": case "question_pending":
      case "safety_block_pending": case "pr_repositories": case "codex_skills":
        return [];
      case "team_list": return [{ id: "fe", name: "OCTIQ FE", role: "", agent: "claude", model: "opus", access: "auto", createdAt: 1, updatedAt: 1 }];
      case "chat_queue_state": return { live: false, queuedTurnIds: [] };
      case "orchestration_snapshot": return snapshot;
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
  };
  return { stored, resultFor };
}

const server = await createServer({
  root: webRoot,
  configFile: join(webRoot, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
const errors = [];
const report = { artifacts, theme, wideFont, classic, scenes: {} };

async function open(browser, snapshot, { width, height, phone = false }) {
  const { stored, resultFor } = mock(snapshot);
  const context = await browser.newContext({
    viewport: { width, height }, reducedMotion: "reduce",
    ...(phone ? { hasTouch: true, isMobile: true } : {}),
  });
  await context.addInitScript(({ chats, mode, wide }) => {
    localStorage.setItem("octiq.v2.gitColumn", "0");
    localStorage.setItem("octiq.theme", mode);
    localStorage.setItem("octiq.v2.theme", mode);
    localStorage.setItem("octiq.v2.conversations", JSON.stringify(chats));
    if (wide) addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = "*, *::before, *::after { font-family: Verdana, sans-serif !important; letter-spacing: 0.02em !important; }";
      document.head.append(style);
    });
  }, { chats: stored, mode: theme, wide: wideFont });
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

const rowOf = (page) => page.locator(".orch-task").filter({ has: page.locator(".orch-task-title", { hasText: TITLE }) }).first();
const noSidewaysScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

/** The run panel on screen with its rows: the Tasks column on a desktop, the
 *  Tasks view on a phone. History is folded: Finished is opened to reach it. */
async function openRunPanel(page, scene) {
  const first = rowOf(page);
  const toggle = page.locator(".tasks-toggle").first();
  const view = page.locator("button[aria-pressed]").filter({ hasText: /^(Tasks|Mission)/ }).first();
  for (let tries = 0; tries < 200 && !(await first.isVisible().catch(() => false)); tries++) {
    if (await view.isVisible().catch(() => false)) {
      if (await view.getAttribute("aria-pressed") !== "true") await view.click().catch(() => {});
    } else if (await toggle.isVisible().catch(() => false) && await toggle.getAttribute("aria-expanded") !== "true") await toggle.click().catch(() => {});
    const accordion = page.locator(".orch-run-accordion-toggle").first();
    if (await accordion.isVisible().catch(() => false) && await accordion.getAttribute("aria-expanded") === "false") await accordion.click().catch(() => {});
    if (scene.row.group === "Finished") {
      const fold = page.locator(".run-group[data-group='finished'] .run-group-head").first();
      if (await fold.isVisible().catch(() => false) && await fold.getAttribute("aria-expanded") === "false") await fold.click().catch(() => {});
    }
    await page.waitForTimeout(500);
  }
  await first.waitFor();
}

/** Everything the row says and how it is drawn. */
const readRow = (row) => row.evaluate((article) => {
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
  const probe = (token) => { const el = document.createElement("span"); el.style.color = `var(${token})`; document.body.append(el); const colour = getComputedStyle(el).color; el.remove(); return colour; };
  const note = article.querySelector(".run-row-note");
  const ask = article.querySelector(".orch-task-ask");
  const group = article.closest(".run-group");
  const figures = article.querySelector(".run-row-figures");
  return {
    state: article.getAttribute("data-state"), failure: article.getAttribute("data-failure"), tone: article.getAttribute("data-tone"),
    group: group?.querySelector(".run-group-head")?.textContent?.trim() ?? null,
    note: note?.textContent ?? null, noteColour: note ? getComputedStyle(note).color : null,
    noteBox: box(note), figuresBox: box(figures), rowBox: box(article),
    ask: ask?.querySelector("span")?.textContent ?? null, askBox: box(ask),
    askCut: ask ? ask.scrollWidth > ask.clientWidth + 1 : false,
    title: note?.getAttribute("title") ?? null,
    danger: probe("--danger"), warn: probe("--warn"), decide: probe("--decide"),
    trackColour: (() => { const bar = article.querySelector(".run-row-bar > span"); return bar ? getComputedStyle(bar).backgroundColor : null; })(),
    mark: article.querySelector(".run-row-mark")?.getAttribute("aria-label") ?? null,
    markColour: (() => { const mark = article.querySelector(".run-row-mark"); return mark ? getComputedStyle(mark).color : null; })(),
  };
});

/** The chat list's row for the main chat: its line, the line's colour, and
 *  its badge. */
const readChatRow = (page) => page.evaluate(() => {
  const probe = (token) => { const el = document.createElement("span"); el.style.color = `var(${token})`; document.body.append(el); const colour = getComputedStyle(el).color; el.remove(); return colour; };
  const rows = [...document.querySelectorAll("li[data-row]")];
  const row = rows.find((item) => item.textContent?.includes("Move the export controls"));
  const line = row?.querySelector(".chat-workflow-status");
  return {
    found: !!row, line: line?.textContent ?? null, tone: line?.getAttribute("data-tone") ?? null,
    colour: line ? getComputedStyle(line).color : null, danger: probe("--danger"), warn: probe("--warn"),
    badge: row?.querySelector(".pending-action-badge")?.textContent?.trim() ?? null,
    cut: line ? line.scrollWidth > line.clientWidth : false,
  };
});

const readStrip = (page) => page.evaluate(() => {
  const strip = document.querySelector(".run-strip");
  if (!strip) return null;
  const dot = strip.querySelector(".run-strip-dot");
  return {
    state: strip.getAttribute("data-state"), word: strip.querySelector(".run-strip-word")?.textContent ?? null,
    text: strip.querySelector(".run-strip-open")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
    title: strip.querySelector(".run-strip-open")?.getAttribute("title") ?? null,
    dot: dot ? getComputedStyle(dot).backgroundColor : null,
  };
});

async function scene(browser, item, size) {
  const label = `${tag}-${size.name}-${item.name}`;
  const out = (report.scenes[item.name] ??= {})[size.name] = {};
  const snapshot = await ledger(item.file);
  const { context, page } = await open(browser, snapshot, size);
  await openRunPanel(page, item);

  // The run panel's row.
  const row = await readRow(rowOf(page));
  out.row = { state: row.state, failure: row.failure, group: row.group, note: row.note, ask: row.ask, mark: row.mark };
  assert.equal(row.state, item.row.state, `${label}: the row's state`);
  assert.equal(row.failure, item.row.failure, `${label}: whose move its failure is`);
  assert.equal(row.note, item.row.note, `${label}: the row's word`);
  assert(row.group?.startsWith(item.row.group), `${label}: listed under ${item.row.group} (${row.group})`);
  assert.equal(row.noteColour === row.danger, item.row.red, `${label}: the danger colour is on the word only for a failure that waits on the person (${row.noteColour})`);
  assert.notEqual(row.noteColour, row.warn, `${label}: never the warning colour`);
  assert.equal(row.tone === "danger", item.row.red, `${label}: the row's tone`);
  if (row.trackColour) assert.equal(row.trackColour === row.danger, item.row.red, `${label}: the row's bar (${row.trackColour})`);
  assert.equal(row.ask, item.ask, `${label}: what the row says the person can do`);
  if (item.ask) {
    // Words on the row itself, whole, inside it: no hover, nothing cut.
    assert(row.askBox.h > 0, `${label}: the sentence is drawn`);
    assert.equal(row.askCut, false, `${label}: the sentence wraps and is not cut`);
    assert(row.askBox.l >= row.rowBox.l - 0.5 && row.askBox.r <= row.rowBox.r + 0.5, `${label}: the sentence is inside the row`);
    assert(row.askBox.t >= row.noteBox.b - 1, `${label}: under the row's own lines`);
    assert.equal(row.mark, "Failed", `${label}: the row's mark`);
    assert.equal(row.markColour, row.danger, `${label}: the mark is the danger colour`);
  }
  if (row.figuresBox && row.noteBox) {
    assert(row.figuresBox.r <= row.rowBox.r + 0.5, `${label}: the minutes stay on the row`);
    assert(row.noteBox.r <= row.figuresBox.l + 0.5 || Math.abs(row.noteBox.t - row.figuresBox.t) > 2, `${label}: the word stops before the minutes`);
  }
  assert.equal(await noSidewaysScroll(page), true, `${label}: no sideways scroll`);

  // The run's attention button, and the decision's own box.
  const attention = page.locator(".orch-attention").first();
  const shown = await attention.isVisible().catch(() => false);
  out.attention = shown ? { label: (await attention.textContent())?.trim(), tone: await attention.getAttribute("data-tone") } : null;
  assert.equal(shown ? out.attention.label : null, item.attention, `${label}: the attention button`);
  if (shown) assert.equal(out.attention.tone, "failed", `${label}: in the danger colour`);
  if (item.name === "escalated") {
    const gate = page.locator(".orch-gate").first();
    await gate.waitFor();
    out.gate = { task: (await gate.locator(".orch-gate-task").textContent())?.trim(), send: (await gate.locator(".orch-gate-write button").textContent())?.trim() };
    assert.equal(out.gate.task, TITLE, `${label}: the decision names its task`);
    assert.equal(out.gate.send, "Answer", `${label}: and is answered on the page`);
    assert.equal(await page.locator(".orch-gate").count(), 1, `${label}: drawn once`);
  }

  if (!size.phone) {
    // One window: the chat list, the line above the composer, the panel.
    const chat = await readChatRow(page);
    const strip = await readStrip(page);
    checkChat(label, item, chat, out);
    checkStrip(label, item, strip, out);
    await page.screenshot({ path: join(artifacts, `${label}.png`) });
    // The badge leads to the decision: the failure's own row, or the gate
    // its coordinator opened. It presses nothing there.
    if (item.badge) {
      await page.locator("li[data-row]").filter({ hasText: "Move the export controls" }).locator(".pending-action-badge").first().click();
      const key = item.name === "escalated" ? `gate:${snapshot.gates[0].id}` : `failure:${snapshot.tasks[0].id}`;
      await page.waitForFunction((wanted) => document.activeElement?.getAttribute("data-pending-keys")?.split(" ").includes(wanted), key, { timeout: 10_000 });
      out.revealed = await page.evaluate(() => document.activeElement?.className ?? null);
      assert.match(out.revealed, item.name === "escalated" ? /orch-gate/ : /orch-task/, `${label}: the badge puts the keyboard on the decision`);
    }
  } else {
    await page.screenshot({ path: join(artifacts, `${label}-panel.png`) });
    // Back to the chat for the line above the composer.
    const view = page.locator("button[aria-pressed]").filter({ hasText: /^Chat/ }).first();
    if (await view.isVisible().catch(() => false)) await view.click();
    await page.waitForTimeout(400);
    const strip = await readStrip(page);
    checkStrip(label, item, strip, out);
    assert.equal(await noSidewaysScroll(page), true, `${label}: no sideways scroll in the chat`);
    await page.screenshot({ path: join(artifacts, `${label}-strip.png`) });
    // And the chat list.
    await page.getByRole("button", { name: "Show chats" }).first().click();
    await page.locator("li[data-row]").first().waitFor();
    await page.waitForTimeout(400);
    const chat = await readChatRow(page);
    checkChat(label, item, chat, out);
    assert.equal(await noSidewaysScroll(page), true, `${label}: no sideways scroll in the chat list`);
    await page.screenshot({ path: join(artifacts, `${label}-list.png`) });
  }

  // The row opened: its sentence, and the one start where the host takes one.
  if (!size.phone && (item.row.failure || item.name === "retrying")) {
    await page.getByRole("button", { name: `Expand task progress: ${TITLE}`, exact: true }).first().click();
    await rowOf(page).getByRole("tablist").waitFor();
    const opened = await rowOf(page).evaluate((article) => ({
      hold: article.querySelector(".orch-task-detail > .orch-task-hold[data-failure]")?.textContent ?? null,
      starts: [...article.querySelectorAll(".orch-attempt-retry button, .orch-task-start button")].map((button) => button.textContent?.trim()),
      state: article.querySelector(".orch-task-state")?.textContent ?? null,
      stateColour: (() => { const el = article.querySelector(".orch-task-state"); return el ? getComputedStyle(el).color : null; })(),
    }));
    out.opened = opened;
    if (item.row.failure === "coordinator") {
      assert.match(opened.hold, /^Its coordinator is fixing it: \d of 2 automatic retries used\. Nothing is asked of you\.$/, `${label}: the opened row says whose it is`);
      assert.notEqual(opened.stateColour, row.danger, `${label}: the ledger's word is not red`);
      assert.notEqual(opened.stateColour, row.warn, `${label}: nor the warning colour`);
    }
    if (item.row.failure === "person") assert.deepEqual(opened.starts, ["Start retry"], `${label}: the one start`);
    if (item.row.failure === "history") assert.deepEqual(opened.starts, [], `${label}: history offers no start`);
    await rowOf(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(artifacts, `${label}-opened.png`) });
  }
  await context.close();
}

function checkChat(label, item, chat, out) {
  out.chat = { line: chat.line, tone: chat.tone, badge: chat.badge };
  assert.equal(chat.found, true, `${label}: the main chat's row`);
  assert.equal(chat.line, item.line, `${label}: the chat list's line`);
  assert.equal(chat.tone, item.lineTone, `${label}: its tone`);
  assert.equal(chat.colour === chat.danger, item.lineTone === "danger", `${label}: red only for a failure that waits on the person (${chat.colour})`);
  assert.notEqual(chat.colour, chat.warn, `${label}: never the warning colour`);
  assert.equal(!!chat.badge, item.badge, `${label}: the badge (${chat.badge})`);
  if (item.name !== "stopped") assert(!/failed/i.test(chat.line) || item.lineTone === "danger", `${label}: no "failed" in the chat list unless it waits on the person`);
}

function checkStrip(label, item, strip, out) {
  out.strip = strip && { state: strip.state, text: strip.text };
  assert.deepEqual(strip ? [strip.state, strip.word] : null, item.strip, `${label}: the line above the composer`);
  if (strip && !item.row.red) assert(!/failed/i.test(strip.text), `${label}: nothing failed on the line (${strip.text})`);
  if (item.row.failure === "coordinator") assert.match(strip.title, /1 failure with the coordinator, which is fixing it: nothing is asked of you\./, `${label}: said in the tooltip only`);
}

let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(classic ? { ignoreDefaultArgs: ["--hide-scrollbars"], args: ["--disable-features=OverlayScrollbar"] } : {}),
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  const only = process.env.SCENE;
  for (const item of SCENES.filter((each) => !only || each.name === only)) {
    for (const size of [{ name: "1280", width: 1280, height: 900, phone: false }, { name: "390", width: 390, height: 844, phone: true }]) {
      await scene(browser, item, size);
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
