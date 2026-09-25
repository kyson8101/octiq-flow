// Run after pnpm --dir web build. Real production App with a mocked socket;
// this never launches an agent or touches live chats.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { preview } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const artifacts = await mkdtemp(join(tmpdir(), "octiq-unified-workspace-"));
const server = await preview({ root: new URL("../web", import.meta.url).pathname,
  configFile: new URL("../web/vite.config.ts", import.meta.url).pathname,
  preview: { host: "127.0.0.1", port: 0, strictPort: false } });
const now = Date.now() - 5 * 60_000;
const chats = ["master", "orch-worker", "orch-history", "orch-orphan"].map((id) => ({
  id, projectId: "general", title: id, customTitle: true, modelId: "claude:sonnet",
  sessionId: `session-${id}`, createdAt: now, updatedAt: now,
}));
const snapshot = {
  runs: [{ id: "run", coordinatorChatKey: "chat:master", objective: "Ship the feature",
    workspaceId: "general", rootPath: "/test", status: "waiting", maxConcurrent: 2, createdAt: now, updatedAt: now }],
  tasks: [{ id: "task", runId: "run", title: "Implement it", spec: "The assigned task", dependsOn: [],
    status: "blocked", activeAttemptId: "attempt", createdAt: now, updatedAt: now }],
  attempts: [{ id: "attempt", runId: "run", taskId: "task", number: 1, workerChatKey: "chat:orch-worker",
    agent: "claude", access: "auto", status: "blocked", cwd: "/test", branch: "feature/worker",
    isWorktree: true, filesModified: [], createdAt: now, updatedAt: now }],
  gates: [{ id: "gate", runId: "run", taskId: "task", createdByChatKey: "chat:orch-worker",
    targetChatKey: "chat:master", question: "Keep the current behavior?", options: ["Keep", "Change"],
    status: "open", createdAt: now, updatedAt: now }], messages: [],
};
// Enough rows to exercise scrolling and filtering without touching live data.
for (let index = 2; index <= 18; index++) snapshot.tasks.push({
  ...snapshot.tasks[0], id: `task-${index}`, title: `Follow-up task ${index}`, status: "pending", activeAttemptId: null,
});
snapshot.runs.push({ ...snapshot.runs[0], id: "history", objective: "Earlier release", status: "completed", createdAt: now - 900_000 });
snapshot.tasks.push({ ...snapshot.tasks[0], id: "old-task", runId: "history", title: "Earlier task", status: "completed", activeAttemptId: "old-attempt" });
snapshot.attempts.push({ ...snapshot.attempts[0], id: "old-attempt", runId: "history", taskId: "old-task", workerChatKey: "chat:orch-history", status: "completed" });
const calls = [], errors = [];
let browser, failLedger = false;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: "reduce" });
  await context.addInitScript((chats) => {
    localStorage.setItem("octiq.v2.gitColumn", "0");
    localStorage.setItem("octiq.v2.conversations", JSON.stringify(chats.map((chat) => ({ ...chat,
      messages: [{ id: `message-${chat.id}`, role: "assistant", streaming: false,
        blocks: [{ kind: "text", text: `Progress from ${chat.id}` }] }],
    }))));
  }, chats);
  await context.route("**/token", (route) => route.fulfill({ body: "mock-token" }));
  await context.route("**/auth", (route) => route.fulfill({ body: "ok" }));
  await context.routeWebSocket(/.*/, (socket) => socket.onMessage((raw) => {
    const request = JSON.parse(String(raw));
    if (request.t !== "invoke") return;
    calls.push(request);
    let result = [];
    if (request.cmd === "list_workspaces") result = [{ id: "general", name: "General", primary_path: "/test" }];
    if (request.cmd === "chat_index_list") result = chats;
    if (request.cmd === "chat_page") result = { events: [], context: [], before: null };
    if (request.cmd === "chat_queue_state") result = { live: false, queuedTurnIds: [] };
    if (request.cmd === "orchestration_snapshot") result = snapshot;
    if (request.cmd === "sandbox_snapshot") result = { environments: {} };
    if (request.cmd === "permission_pending") result = [];
    if (request.cmd === "memory_usage") result = { totalMb: 0, procs: 0, rows: [] };
    if (request.cmd === "usage_summary") result = {};
    if (request.cmd === "git_status") result = { branch: "main", files: [] };
    if (request.cmd === "agent_installs") result = [{ id: "claude", installed: true, path: "/mock/claude" }];
    socket.send(JSON.stringify({ t: "reply", id: request.id, ok: !(failLedger && request.cmd === "orchestration_snapshot"), result,
      error: failLedger ? "Ledger unavailable" : undefined }));
  }));
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on("pageerror", (error) => errors.push(error.stack ?? String(error)));
  page.on("console", msg => { if (msg.type() === "error") console.error(msg.text()); });
  const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
  await page.goto(`${base}#/p/general/c/master`, { waitUntil: "domcontentloaded", timeout: 60000 });
  const header = page.locator(".workflow-header");
  const title = header.getByRole("heading", { name: "Ship the feature", exact: true });
  const tasks = page.locator(".workflow-run-surface");
  const chat = page.locator(".workflow-chat-surface");
  const main = tasks.getByRole("button", { name: "Main chat Coordinate the work", exact: true });
  const worker = tasks.getByRole("button", { name: "Open task chat: Implement it", exact: true });
  await title.waitFor();
  await main.waitFor();
  assert.equal(await main.getAttribute("aria-current"), "page");
  assert.equal(await tasks.locator(".orch-run-head").count(), 0, "The title belongs only to the shared header");
  const h = await header.boundingBox(), l = await tasks.boundingBox(), r = await chat.boundingBox();
  assert(h.y + h.height <= l.y + 1 && h.y + h.height <= r.y + 1, "Title spans above both columns");
  assert(l.x + l.width <= r.x + 1 && Math.abs(l.y - r.y) <= 1, "Tasks left and chat right share a top edge");
  assert.equal(await tasks.evaluate(el => !!(el.compareDocumentPosition(el.nextElementSibling) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
  const pinnedY = (await main.boundingBox()).y;
  await tasks.locator(".orch-content").evaluate(el => { el.scrollTop = el.scrollHeight; });
  assert.equal((await main.boundingBox()).y, pinnedY, "Main chat does not scroll with tasks");
  await tasks.locator(".orch-content").evaluate(el => { el.scrollTop = 0; });
  await tasks.getByRole("button", { name: "Done", exact: true }).click();
  assert.equal(await main.isVisible(), true, "Task filters never hide Main chat");
  assert.equal(await worker.count(), 0);
  await tasks.getByRole("button", { name: "All", exact: true }).click();
  await worker.click();
  await page.waitForFunction(() => location.hash.endsWith("/c/orch-worker"));
  await title.waitFor();
  assert.equal(await worker.getAttribute("aria-current"), "page");
  assert.equal(await main.getAttribute("aria-current"), null);
  assert.equal(await chat.locator(".composer").count(), 0, "Worker chat stays read-only");
  await page.screenshot({ path: join(artifacts, "desktop-worker.png") });
  await main.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => location.hash.endsWith("/c/master"));
  await title.waitFor();
  assert.equal(await main.getAttribute("aria-current"), "page");
  // History selection updates the shared title and returning does not duplicate it.
  await tasks.getByRole("button", { name: /Earlier release/ }).click();
  await header.getByRole("heading", { name: "Earlier release", exact: true }).waitFor();
  await tasks.getByRole("button", { name: /Ship the feature/ }).click();
  await title.waitFor();
  // A direct link to a historical worker follows its run, even while another run is active.
  await page.goto(`${base}#/p/general/c/orch-history`, { waitUntil: "domcontentloaded" });
  await header.getByRole("heading", { name: "Earlier release", exact: true }).waitFor();
  assert.equal(await tasks.getByRole("button", { name: "Open task chat: Earlier task", exact: true }).getAttribute("aria-current"), "page");
  await main.click();
  await page.waitForFunction(() => location.hash.endsWith("/c/master"));
  await header.getByRole("heading", { name: "Earlier release", exact: true }).waitFor();
  await tasks.getByRole("button", { name: /Ship the feature/ }).click();
  await title.waitFor();
  // The divider changes the left column without moving the shared header.
  const divider = page.getByRole("separator", { name: "Resize the run column" });
  const handle = await divider.boundingBox();
  const before = (await tasks.boundingBox()).width;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 100);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 50, handle.y + 100);
  await page.mouse.up();
  assert((await tasks.boundingBox()).width > before, "The task column remains resizable");
  await page.screenshot({ path: join(artifacts, "desktop-main.png") });
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await header.getByRole("button", { name: "Tasks", exact: true }).click();
    await worker.click();
    await page.waitForFunction(() => location.hash.endsWith("/c/orch-worker"));
    await title.waitFor();
    assert.equal(await chat.isVisible(), true);
    assert.equal(await tasks.isVisible(), false);
    await header.getByRole("button", { name: "Tasks", exact: true }).click();
    await main.waitFor();
    assert.equal(await worker.getAttribute("aria-current"), "page");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(artifacts, `tasks-${width}.png`) });
    await main.click();
    await page.waitForFunction(() => location.hash.endsWith("/c/master"));
    await title.waitFor();
    assert.equal(await chat.isVisible(), true);
    assert.equal(await tasks.isVisible(), false);
    await page.screenshot({ path: join(artifacts, `chat-${width}.png`) });
  }
  assert.equal(calls.some(({ cmd }) => ["chat_start", "chat_send", "permission_decide"].includes(cmd)), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, artifacts }));
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  console.error(JSON.stringify({ error: String(error), errors, text: await page?.locator("body").innerText({ timeout: 2000 }).catch(() => "unavailable") }));
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
