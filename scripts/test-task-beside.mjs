// Actual App-shell regression for [ Main | Task ]: a task chat opened beside
// its main chat, only when asked. The socket is mocked, but every interaction
// goes through App.tsx, the run panel, the top bar's run line, the Composer
// and the task pane, and both chats stream the way the real server sends them.
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const artifacts = process.env.OCTIQ_EVIDENCE_DIR
  || await mkdtemp(join(tmpdir(), "octiq-task-beside-"));
await mkdir(artifacts, { recursive: true });

const now = Date.now();
const agent = (id, name, over = {}) => ({
  id, name, role: "", agent: "codex", model: "gpt-5.5", effort: "high", access: "auto",
  createdAt: now - 100_000, updatedAt: now - 100_000, ...over,
});
const team = [
  agent("maya", "Maya", { role: "CTO" }),
  agent("lena", "Lena", { role: "Project lead", projectId: "general", reportsTo: "maya" }),
  agent("noah", "Noah", { role: "Frontend engineer", projectId: "general", reportsTo: "lena" }),
  agent("priya", "Priya", { role: "Backend engineer", projectId: "general", reportsTo: "lena" }),
];
// Unread on arrival (updatedAt after createdAt, no readAt), so read marks show.
const chat = (id, title) => ({
  id, projectId: "general", title, customTitle: true, modelId: "codex:gpt-5.5", access: "auto",
  sessionId: `session-${id}`, createdAt: now - 60_000, updatedAt: now - 50_000,
});
const chats = [
  // The chat that happens to be open, and the configured head's own chat:
  // neither coordinates the run, so neither may end up on the left.
  chat("home", "General notes"),
  chat("head-chat", "Talk to Maya"),
  chat("lead", "Ship the roster"),
  chat("orch-1", "Build the roster page"),
  chat("orch-2", "Payroll export API"),
];
const task = (id, over) => ({
  id, runId: "run-lead", spec: "", dependsOn: [], createdAt: now - 40_000, updatedAt: now - 20_000, ...over,
});
const attempt = (id, taskId, chatKey) => ({
  id, runId: "run-lead", taskId, number: 1, workerChatKey: chatKey, agent: "codex", access: "auto",
  status: "running", cwd: "/w", branch: `feature/${taskId}`, isWorktree: true, filesModified: [],
  execution: { state: "executing", retryCount: 0, lastActivityAt: now - 1_000 },
  createdAt: now - 30_000, updatedAt: now - 1_000,
});
const snapshot = {
  runs: [
    { id: "run-lead", coordinatorChatKey: "chat:lead", objective: "Ship the roster", workspaceId: "general",
      rootPath: "/Users/kyson/General", status: "running", maxConcurrent: 2, createdAt: now - 45_000, updatedAt: now - 20_000,
      planApproval: { status: "approved", requestedAt: now - 44_000, decidedAt: now - 43_000 } },
  ],
  tasks: [
    task("t1", { title: "Build the roster page", status: "running", activeAttemptId: "a1", assignee: { id: "noah", name: "Noah" } }),
    task("t2", { title: "Payroll export API", status: "running", activeAttemptId: "a2", assignee: { id: "priya", name: "Priya" } }),
  ],
  attempts: [attempt("a1", "t1", "chat:orch-1"), attempt("a2", "t2", "chat:orch-2")],
  gates: [], messages: [],
};

// Each chat's record, served back by chat_page / chat_since and extended live.
const logs = new Map();
const record = (key, event) => {
  const log = logs.get(key) ?? [];
  const frame = { seq: log.length + 1, event };
  log.push(frame);
  logs.set(key, log);
  return frame;
};
const said = (key, text) => record(key, { type: "item.completed", item: { id: `i-${key}-${(logs.get(key)?.length ?? 0) + 1}`, type: "agent_message", text } });
for (const { id, title } of chats) {
  record(`chat:${id}`, { type: "user", uuid: `u-${id}`, octiq_user_turn: true, message: { content: [{ type: "text", text: `Start: ${title}` }] } });
  said(`chat:${id}`, `${title} — first answer.`);
  record(`chat:${id}`, { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
}

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
    case "list_workspaces": return [{ id: "general", name: "General", primary_path: "/Users/kyson/General" }];
    case "chat_index_list": return chats;
    case "chat_index_deleted": return [];
    case "chat_page": return { events: logs.get(request.args?.key) ?? [], context: [], before: null };
    case "chat_since": return (logs.get(request.args?.key) ?? []).filter((frame) => frame.seq > (request.args?.after ?? 0));
    case "chat_list": return ["chat:lead", "chat:orch-1", "chat:orch-2"];
    case "chat_activity": return [];
    case "chat_queue_state": return { live: true, queuedTurnIds: [] };
    case "chat_send": {
      const key = request.args?.key;
      emit(key, { type: "user", uuid: request.args?.turnId, octiq_user_turn: true, message: { content: [{ type: "text", text: request.args?.text }] } });
      return null;
    }
    case "orchestration_snapshot": return snapshot;
    case "permission_pending": return [];
    case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
    case "usage_summary": return {};
    case "agent_installs": return [{ id: "codex", installed: true, path: "/mock/codex" }, { id: "claude", installed: true, path: "/mock/claude" }];
    case "team_list": return request.args?.all ? team : team.filter((a) => !a.projectId);
    case "team_head": return team[0];
    case "team_leads": return [
      { chatKey: "chat:lead", leadId: "lena", leadName: "Lena", projectId: "general", createdAt: now - 60_000 },
      { chatKey: "chat:head-chat", leadId: "maya", leadName: "Maya", projectId: "general", crossProject: true, createdAt: now - 60_000 },
    ];
    case "team_home": return "general";
    case "chat_task": return { chatId: request.args?.chatId, projectId: "general" };
    case "sandbox_snapshot": return { defaultEnabled: false, environments: {} };
    case "codex_skills": return [];
    default: return null;
  }
}
function emit(key, event) {
  const frame = record(key, event);
  appSocket?.send(JSON.stringify({ t: "event", event: "chat-event", payload: { key, ...frame } }));
}

const mainPane = (page) => page.locator(".beside-pane.is-main");
const taskPane = (page) => page.locator(".beside-pane.is-task");
const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const rowOf = (page, title) => page.locator(".orch-task").filter({ has: page.locator(".orch-task-title", { hasText: title }) });
const sends = () => calls.filter(({ cmd }) => cmd === "chat_send");
const readMarks = (id) => calls.filter(({ cmd, args }) => cmd === "chat_mark_read" && args?.id === id).length;
const composer = (page) => mainPane(page).locator(".composer textarea");

let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: "reduce" });
  await context.addInitScript(() => {
    localStorage.setItem("octiq.agentsMode", "on");
    localStorage.setItem("octiq.v2.gitColumn", "0");
  });
  await context.route("**/token", (route) => route.fulfill({ body: "mock-token" }));
  await context.route("**/auth", (route) => route.fulfill({ body: "ok" }));
  await context.routeWebSocket(/.*/, (socket) => {
    appSocket = socket;
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
  const base = `http://127.0.0.1:${server.httpServer.address().port}/`;

  // ── An ordinary chat is one pane, as ever.
  await page.goto(`${base}#/p/general/c/home`, { waitUntil: "domcontentloaded" });
  await page.locator(".main").getByText("General notes — first answer.", { exact: true }).waitFor();
  assert.equal(await page.locator(".beside-pane.is-task").count(), 0);

  // ── A task chat opens full-width by default — here straight from its link.
  await page.evaluate(() => { location.hash = "#/c/orch-1"; });
  await page.locator(".main").getByText("Build the roster page — first answer.", { exact: true }).waitFor();
  assert.equal(await taskPane(page).count(), 0, "a task opens full-width unless asked otherwise");
  // Read-only is a badge by the title now: no block, and no button, under the transcript.
  await page.locator(".topbar .workflow-read-only").waitFor();
  assert.equal(await page.getByRole("note", { name: "Read-only. Send instructions in the main chat." }).count(), 1);
  assert.equal(await page.locator(".worker-chat-notice").count(), 0);
  assert.equal(await page.getByRole("button", { name: "Open main chat", exact: true }).count(), 0);
  assert.equal(await page.locator(".composer").count(), 0);
  const headerBeside = page.getByRole("button", { name: "Open beside main: Build the roster page", exact: true });
  await headerBeside.waitFor();
  // The row of the task on screen defers to that one header button; others offer theirs.
  assert.equal(await rowOf(page, "Build the roster page").locator(".orch-task-beside").count(), 0);
  assert.equal(await rowOf(page, "Payroll export API").getByRole("button", { name: "Open beside main: Payroll export API" }).count(), 1);
  await page.screenshot({ path: join(artifacts, "desktop-task-full.png") });

  // ── Open beside main: the run's own coordinator on the left, never the
  //    chat that was open before or the configured head's.
  await headerBeside.click();
  await page.waitForURL(/#\/p\/general\/c\/lead\/beside\/orch-1$/);
  await taskPane(page).getByText("Build the roster page — first answer.", { exact: true }).waitFor();
  await mainPane(page).getByText("Ship the roster — first answer.", { exact: true }).waitFor();
  assert.equal(await page.locator(".beside-panes.is-split > .beside-pane:not([hidden])").count(), 2);
  assert.match(await mainPane(page).locator(".beside-head").innerText(), /Main chat[\s\S]*Lena/);
  assert.match(await taskPane(page).locator(".beside-head").innerText(), /Build the roster page[\s\S]*Read-only[\s\S]*Noah · Task chat/);
  assert.equal(await taskPane(page).locator(".beside-head .read-only-badge").count(), 1);
  assert.equal(await page.locator(".worker-chat-notice").count(), 0);
  assert.equal(await page.locator(".composer textarea").count(), 1, "one composer: the main chat's");
  assert.equal(await taskPane(page).locator("textarea").count(), 0);
  await page.waitForFunction(() => document.activeElement?.matches(".beside-pane.is-task .beside-title"));
  assert.equal(await rowOf(page, "Build the roster page").locator(".orch-task-summary").getAttribute("aria-current"), "page");
  assert.equal(await rowOf(page, "Build the roster page").locator(".orch-task-beside").count(), 0);
  const widths = await page.evaluate(() => [...document.querySelectorAll(".beside-pane")].map((pane) => pane.getBoundingClientRect().width));
  assert(widths.every((width) => width >= 360), `both panes keep their minimum: ${widths}`);
  assert.equal(await noHorizontalScroll(page), true);

  // ── Two live streams, each landing in its own pane and nowhere else.
  emit("chat:lead", { type: "turn.started" });
  emit("chat:orch-1", { type: "turn.started" });
  for (let i = 1; i <= 3; i++) {
    emit("chat:lead", { type: "item.completed", item: { id: `live-lead-${i}`, type: "agent_message", text: `Lead update ${i}` } });
    emit("chat:orch-1", { type: "item.completed", item: { id: `live-task-${i}`, type: "agent_message", text: `Task update ${i}` } });
  }
  await mainPane(page).getByText("Lead update 3", { exact: true }).waitFor();
  await taskPane(page).getByText("Task update 3", { exact: true }).waitFor();
  for (let i = 1; i <= 3; i++) {
    assert.equal(await mainPane(page).getByText(`Lead update ${i}`, { exact: true }).count(), 1);
    assert.equal(await taskPane(page).getByText(`Task update ${i}`, { exact: true }).count(), 1);
    assert.equal(await taskPane(page).getByText(`Lead update ${i}`, { exact: true }).count(), 0);
    assert.equal(await mainPane(page).getByText(`Task update ${i}`, { exact: true }).count(), 0);
  }
  await page.screenshot({ path: join(artifacts, "desktop-split-streaming.png") });

  // ── A draft in the main composer, then another task beside: the right pane
  //    is replaced, never stacked, and the draft stays put.
  await composer(page).fill("Draft for Lena");
  await rowOf(page, "Payroll export API").getByRole("button", { name: "Open beside main: Payroll export API" }).click();
  await page.waitForURL(/\/c\/lead\/beside\/orch-2$/);
  await taskPane(page).getByText("Payroll export API — first answer.", { exact: true }).waitFor();
  assert.equal(await page.locator(".beside-pane").count(), 2, "still exactly two panes");
  assert.equal(await taskPane(page).getByText("Task update 1", { exact: true }).count(), 0);
  assert.equal(await composer(page).inputValue(), "Draft for Lena");

  // ── A plain row click still opens the task full-width; Main comes back as
  //    the split the person left, draft and all.
  await rowOf(page, "Build the roster page").locator(".orch-task-summary").click();
  await page.waitForURL(/\/c\/orch-1$/);
  assert.equal(await taskPane(page).count(), 0);
  assert.equal(await page.locator(".composer textarea").count(), 0, "a task chat has no composer");
  await page.getByRole("button", { name: /Main agent chat/ }).first().click();
  await page.waitForURL(/\/c\/lead\/beside\/orch-2$/);
  await taskPane(page).getByText("Payroll export API — first answer.", { exact: true }).waitFor();
  assert.equal(await composer(page).inputValue(), "Draft for Lena");

  // ── Sending from the split goes to the main chat and only there.
  await composer(page).press("Enter");
  await page.waitForFunction(() => document.querySelector(".beside-pane.is-main")?.textContent?.includes("Draft for Lena"));
  assert.deepEqual(sends().map(({ args }) => args.key), ["chat:lead"]);
  assert.equal(await taskPane(page).getByText("Draft for Lena").count(), 0);

  // ── Agents and Pull requests are pages in place of the chat; coming back
  //    brings the split the person left.
  await composer(page).fill("Draft across pages");
  const places = page.locator(".sidebar-places");
  await places.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("region", { name: "Agents" }).waitFor();
  assert.equal(await page.locator(".beside-pane:visible").count(), 0);
  await places.getByRole("button", { name: "Pull requests", exact: true }).click();
  await page.getByRole("region", { name: "Pull requests dashboard" }).waitFor();
  await page.getByRole("button", { name: "Back to chat", exact: true }).click();
  await taskPane(page).getByText("Payroll export API — first answer.", { exact: true }).waitFor();
  assert.match(page.url(), /\/c\/lead\/beside\/orch-2$/);
  assert.equal(await composer(page).inputValue(), "Draft across pages");
  await composer(page).fill("");

  // ── Expand to full chat, and back beside main from its header.
  await taskPane(page).getByRole("button", { name: "Expand to full chat: Payroll export API" }).click();
  await page.waitForURL(/\/c\/orch-2$/);
  assert.equal(await taskPane(page).count(), 0);
  await page.getByRole("button", { name: "Open beside main: Payroll export API", exact: true }).first().click();
  await page.waitForURL(/\/c\/lead\/beside\/orch-2$/);
  await taskPane(page).waitFor();

  // ── Close split: Main alone, focus back in its composer.
  await taskPane(page).getByRole("button", { name: "Close split" }).click();
  await page.waitForURL(/\/c\/lead$/);
  assert.equal(await taskPane(page).count(), 0);
  await page.waitForFunction(() => document.activeElement?.matches(".beside-pane.is-main .composer textarea"));
  await page.screenshot({ path: join(artifacts, "desktop-split-closed.png") });

  // ── Too little chat area (the run column takes its share at 1280): one pane
  //    at a time with the reason, the choice and both chats kept.
  await rowOf(page, "Build the roster page").getByRole("button", { name: "Open beside main: Build the roster page" }).click();
  await taskPane(page).waitFor();
  await composer(page).fill("Second draft");
  await page.setViewportSize({ width: 1280, height: 900 });
  const bar = page.getByRole("region", { name: "Main and task chats" });
  await bar.waitFor();
  assert.match(await bar.innerText(), /Side by side needs a wider chat area/);
  assert.equal(await mainPane(page).isVisible(), false);
  assert.equal(await taskPane(page).isVisible(), true);
  assert.equal(await taskPane(page).getByRole("button", { name: "Close split" }).count(), 0, "one Close split, in the bar");
  await page.screenshot({ path: join(artifacts, "desktop-1280-fallback.png") });
  await bar.getByRole("button", { name: "Main chat", exact: true }).click();
  assert.equal(await mainPane(page).isVisible(), true);
  assert.equal(await composer(page).inputValue(), "Second draft");
  // Room again: the split the person chose comes back by itself.
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.waitForFunction(() => document.querySelectorAll(".beside-panes.is-split > .beside-pane:not([hidden])").length === 2);
  assert.equal(await bar.count(), 0);
  assert.equal(await composer(page).inputValue(), "Second draft");
  // The run column folds into a tab at 1024, which leaves room for both.
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.waitForFunction(() => document.querySelectorAll(".beside-panes.is-split > .beside-pane:not([hidden])").length === 2);
  await page.screenshot({ path: join(artifacts, "desktop-1024-split.png") });
  await page.setViewportSize({ width: 1440, height: 960 });

  // ── A reload restores the split from the address; nothing was created.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForURL(/\/c\/lead\/beside\/orch-1$/);
  await taskPane(page).getByText("Task update 3", { exact: true }).waitFor();
  await mainPane(page).getByText("Lead update 3", { exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, "desktop-1440-restored.png") });

  // ── 390px: taking turns, no sideways scroll, and the hidden pane is not
  //    marked read until it is shown.
  const phone = await context.newPage();
  phone.on("pageerror", (error) => errors.push(error.stack ?? String(error)));
  const leadReadsBefore = readMarks("lead");
  const taskReadsBefore = readMarks("orch-1");
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(`${base}#/p/general/c/lead/beside/orch-1`, { waitUntil: "domcontentloaded" });
  const phoneBar = phone.getByRole("region", { name: "Main and task chats" });
  await phoneBar.waitFor();
  await taskPane(phone).getByText("Task update 3", { exact: true }).waitFor();
  assert.equal(await noHorizontalScroll(phone), true);
  for (let i = 0; i < 20 && readMarks("orch-1") === taskReadsBefore; i++) await phone.waitForTimeout(100);
  assert(readMarks("orch-1") > taskReadsBefore, "the task on screen is read");
  assert.equal(readMarks("lead"), leadReadsBefore, "the hidden main chat is not marked read");
  await phone.screenshot({ path: join(artifacts, "mobile-390-task.png") });
  await phoneBar.getByRole("button", { name: "Main chat", exact: true }).click();
  await mainPane(phone).getByText("Lead update 3", { exact: true }).waitFor();
  for (let i = 0; i < 20 && readMarks("lead") === leadReadsBefore; i++) await phone.waitForTimeout(100);
  assert(readMarks("lead") > leadReadsBefore, "shown, the main chat is read");
  assert.equal(await noHorizontalScroll(phone), true);
  const target = await phoneBar.getByRole("button", { name: "Close split" }).boundingBox();
  assert(target && target.width >= 40 && target.height >= 40, "phone-size target");
  await phone.screenshot({ path: join(artifacts, "mobile-390-main.png") });
  // A task open full-width on a phone: the badge in its line, no bottom block.
  await phone.evaluate(() => { location.hash = "#/c/orch-2"; });
  await phone.locator(".main").getByText("Payroll export API — first answer.", { exact: true }).waitFor();
  await phone.locator(".workflow-read-only").waitFor();
  assert.equal(await phone.locator(".worker-chat-notice").count(), 0);
  assert.equal(await phone.locator(".composer").count(), 0);
  assert.equal(await noHorizontalScroll(phone), true);
  await phone.screenshot({ path: join(artifacts, "mobile-390-task-full.png") });

  // Layout changes never started a chat, a run, or a message to a worker.
  assert.equal(calls.some(({ cmd }) => ["chat_start", "orchestration_run_create", "orchestration_task_create"].includes(cmd)), false);
  assert.deepEqual(sends().map(({ args }) => args.key), ["chat:lead"]);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, mockedBackend: true, artifacts }));
} catch (error) {
  const page = browser?.contexts()[0]?.pages().at(-1);
  await page?.screenshot({ path: join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
  console.error(JSON.stringify({
    error: String(error), errors,
    url: page?.url(),
    body: await page?.locator("body").innerText({ timeout: 2_000 }).catch(() => "unavailable"),
  }));
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
