// Real App + mocked socket contract. Inline scenes are deliberately not host recordings.
// PLAYWRIGHT_MODULE may name an installed Playwright ESM entrypoint.
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const artifacts = process.env.OCTIQ_EVIDENCE_DIR || await mkdtemp(join(tmpdir(), "octiq-scheduling-"));
await mkdir(artifacts, { recursive: true });
const now = Date.now();
const team = [
  { id: "head", name: "OCTIQ HEAD", role: "Coordinator", model: "opus" },
  { id: "fe", name: "OCTIQ FE", role: "Frontend", reportsTo: "head", model: "sonnet" },
  { id: "be", name: "OCTIQ BE", role: "Backend", reportsTo: "head", model: "sonnet" },
].map(a => ({ agent: "claude", access: "auto", effort: "high", createdAt: now, updatedAt: now, ...a }));
const chats = [{ id: "lead", title: "Agents orientation", customTitle: true }, { id: "orch-active", title: "Scheduling implementation" }]
  .map(c => ({ projectId: "general", modelId: "claude:opus", access: "auto", sessionId: `session-${c.id}`, createdAt: now, updatedAt: now, ...c }));
const logs = new Map(chats.map(({ id, title }) => [`chat:${id}`, [
  { seq: 1, event: { type: "user", uuid: `u-${id}`, octiq_user_turn: true, message: { content: [{ type: "text", text: `Start: ${title}` }] } } },
  { seq: 2, event: { type: "item.completed", item: { id: `i-${id}`, type: "agent_message", text: "Scheduling scene ready." } } },
  { seq: 3, event: { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } } },
]]));
const run = { id: "run-1", coordinatorChatKey: "chat:lead", objective: "Keep worker CPU and memory bounded while agents settle related tasks together", workspaceId: "general",
  rootPath: "/repo/octiq-flow", status: "running", maxConcurrent: 3, createdAt: now, updatedAt: now, planApproval: { status: "approved", requestedAt: now, decidedAt: now } };
const base = { runId: run.id, spec: "Implement scheduling contract", dependsOn: [], createdAt: now, updatedAt: now };
const snapshot = {
  runs: [run],
  tasks: [
    { ...base, id: "active", title: "Scheduling implementation", status: "running", activeAttemptId: "a1", assignee: { id: "fe", name: "OCTIQ FE" } },
    { ...base, id: "queued", title: "Render queued tasks without decision badges", status: "ready", assignee: { id: "fe", name: "OCTIQ FE" }, slotWait: { reason: "agent", agentId: "fe", ahead: 2 } },
    { ...base, id: "host", title: "Wait for machine capacity", status: "ready", assignee: { id: "be", name: "OCTIQ BE" }, slotWait: { reason: "host", ahead: 0, running: 3, limit: 3 } },
    { ...base, id: "restart", title: "Continue after the batch settles", status: "ready", activeAttemptId: "a2", assignee: { id: "fe", name: "OCTIQ FE" } },
  ],
  attempts: [
    { id: "a1", runId: run.id, taskId: "active", number: 1, workerChatKey: "chat:orch-active", agent: "claude", access: "auto", status: "running", batchId: "batch-1",
      cwd: "/repo/.worktrees/agent-fe", branch: "feature/fe-batch-1", isWorktree: true, filesModified: [], createdAt: now, updatedAt: now,
      execution: { state: "executing", retryCount: 0, lastActivityAt: now } },
    { id: "a2", runId: run.id, taskId: "restart", number: 1, workerChatKey: "chat:orch-previous", agent: "claude", access: "auto", status: "completed",
      cwd: "/repo/.worktrees/agent-fe", branch: "feature/previous", isWorktree: true, filesModified: [], createdAt: now, updatedAt: now },
  ],
  batches: [{ id: "batch-1", agentId: "fe", runId: run.id, repository: run.rootPath, baseBranch: "develop", branch: "feature/fe-batch-1", worktree: "/repo/.worktrees/agent-fe", taskIds: ["active", "related"], status: "working", createdAt: now }],
  gates: [], messages: [],
};
let scheduling = { orientation: "tasks", hostCap: 3, live: { total: 3 }, lanes: [
  { agentId: "head", state: "idle", queued: 0 },
  { agentId: "fe", state: "working", queued: 2, batch: { id: "batch-1", runId: run.id, branch: "feature/fe-batch-1", taskIds: ["active", "related"] } },
  { agentId: "be", state: "blocked", queued: 1, blockedReason: "The repository is unavailable. Restore its folder to continue." },
] };
let refuseSave = false, unread = false, startMode = "success";
const calls = [], errors = [];
function resultFor({ cmd, args = {} }) {
  switch (cmd) {
    case "list_workspaces": return [{ id: "general", name: "OctiqFlow", primary_path: run.rootPath }];
    case "chat_index_list": return chats;
    case "chat_index_deleted": case "chat_list": case "chat_activity": case "permission_pending": case "team_leads":
    case "provider_fallback_choices": case "agent_team_list": case "levels_list": case "agent_levels": case "codex_skills": return [];
    case "chat_page": return { events: logs.get(args.key) ?? [], context: [], before: null };
    case "chat_since": return (logs.get(args.key) ?? []).filter(frame => frame.seq > (args.after ?? 0));
    case "chat_queue_state": return { live: false, queuedTurnIds: [] };
    case "orchestration_summary": case "orchestration_snapshot": return snapshot;
    case "team_list": return team;
    case "team_head": return team[0];
    case "team_home": return "general";
    case "agent_policy_get": return { text: "" };
    case "agent_avatar_status": return { available: false, reason: "Inline browser scene" };
    case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
    case "usage_summary": return {};
    case "agent_installs": return [];
    case "chat_task": return { chatId: args.chatId, projectId: "general" };
    case "scheduling_get": if (unread) throw new Error("The profile folder is unavailable."); return scheduling;
    case "scheduling_set":
      if (refuseSave) throw new Error("Cannot change orientation while an agent batch is working.");
      scheduling = { ...scheduling, ...args.settings }; return scheduling;
    case "orchestration_worker_start":
      if (startMode === "error") throw new Error("QUEUED_FOR_SLOT: machine limit (3 of 3 running)");
      return { queued: true };
    default: return null;
  }
}
const server = await createServer({ root: new URL("../web", import.meta.url).pathname,
  server: { host: "127.0.0.1", port: 0, strictPort: false } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 960 }, reducedMotion: "reduce" });
    await context.addInitScript(() => {
      localStorage.setItem("octiq.agentsMode", "on"); localStorage.setItem("octiq.v2.gitColumn", "0"); localStorage.setItem("octiq.theme", "dark");
    });
    await context.route("**/token", route => route.fulfill({ body: "mock-token" }));
    await context.route("**/auth", route => route.fulfill({ body: "ok" }));
    let socket;
    await context.routeWebSocket(/.*/, ws => {
      socket = ws;
      ws.onMessage(raw => {
        const request = JSON.parse(String(raw)); if (request.t !== "invoke") return;
        calls.push(request);
        try { ws.send(JSON.stringify({ t: "reply", id: request.id, ok: true, result: resultFor(request) })); }
        catch (error) { ws.send(JSON.stringify({ t: "reply", id: request.id, ok: false, error: error.message })); }
      });
    });
    const page = await context.newPage(); page.setDefaultTimeout(30_000);
    page.on("pageerror", error => { errors.push(error.stack ?? String(error)); console.error("pageerror", error.stack ?? error.message); });
    const url = `http://127.0.0.1:${server.httpServer.address().port}/#/p/general/c/lead`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
    console.log("Page loaded", width);
    if (width === 390) await page.getByRole("button", { name: "Show chats", exact: true }).click();
    await page.locator(".sidebar-places").getByRole("button", { name: "Agents", exact: true }).click({ force: true });
    const lane = page.locator(".dash-agent").filter({ has: page.locator(".team-row-name", { hasText: "OCTIQ FE" }) });
    await lane.locator(".agent-lane-line", { hasText: "Working · batch of 2 tasks" }).waitFor();
    await lane.locator('.agent-lane[data-executing="true"]').waitFor();
    assert.match(await page.locator('.agent-lane[data-state="blocked"]').innerText(), /Restore its folder/);
    assert.equal(await lane.locator(".agent-lane-branch").isVisible(), false);
    await lane.locator(".agent-lane summary").click();
    await lane.locator(".agent-lane-branch").waitFor();
    const laneBounds = await lane.boundingBox();
    assert.ok(laneBounds.x >= 0 && laneBounds.x + laneBounds.width <= width, "lane stays within the viewport");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(artifacts, `agent-lanes-${width}.png`), fullPage: true });
    await lane.locator(".agent-lane summary").click();
    // A host event after get updates the common reader, without another get.
    const gets = calls.filter(c => c.cmd === "scheduling_get").length;
    scheduling = { ...scheduling, lanes: scheduling.lanes.map(l => l.agentId === "fe" ? { ...l, queued: 4 } : l) };
    socket.send(JSON.stringify({ t: "event", event: "scheduling-changed", payload: scheduling }));
    await lane.locator(".agent-lane-line", { hasText: "4 queued" }).waitFor();
    assert.equal(calls.filter(c => c.cmd === "scheduling_get").length, gets);
    console.log("Lanes verified", width);
    // Open the queued task's run through the Agents page.
    await lane.getByRole("button", { name: /Queued.*Render queued tasks/ }).click();
    const queued = page.locator('[data-task-id="queued"]');
    await queued.getByText("Queued · OCTIQ FE is busy · 2 ahead", { exact: true }).waitFor();
    assert.equal(await queued.getAttribute("data-state"), "planned");
    assert.equal(await queued.getAttribute("data-tone"), null);
    assert.equal(await queued.locator(".orch-attention,.pending-badge").count(), 0);
    await queued.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(artifacts, `queued-row-${width}.png`), fullPage: true });
    // Details derives its batch count and branch from the ledger.
    const active = page.locator('[data-task-id="active"]');
    await active.getByRole("button", { name: /^Expand task progress:/ }).click();
    await active.getByRole("tab", { name: "Details", exact: true }).click();
    await active.getByText("Batch · 2 tasks · feature/fe-batch-1", { exact: true }).waitFor();
    // Both queue answers remain neutral, adjacent to StartButton.
    const restart = page.locator('[data-task-id="restart"]');
    await restart.getByRole("button", { name: /^Expand task progress:/ }).click();
    await restart.getByRole("button", { name: "Start next attempt", exact: true }).click();
    await restart.getByRole("status").filter({ hasText: "Queued" }).waitFor();
    startMode = "error";
    await restart.getByRole("button", { name: "Start next attempt", exact: true }).click();
    await restart.getByText("Queued · machine limit (3 of 3 running)", { exact: true }).waitFor();
    startMode = "success";
    console.log("Run rows verified", width);
    // Settings lives in the real sheet; the saved selection is host-owned.
    if (width === 390) await page.getByRole("button", { name: "Show chats", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator(".settings-nav").getByRole("button", { name: /^Agents/ }).click();
    const settings = page.locator(".scheduling-block");
    await settings.getByLabel("Agents", { exact: true }).check();
    await settings.getByLabel("Machine-wide limit", { exact: true }).selectOption("4");
    refuseSave = true;
    await settings.getByRole("button", { name: "Save scheduling" }).click();
    await settings.getByText("Not saved", { exact: true }).click();
    await settings.getByText("Cannot change orientation while an agent batch is working.", { exact: true }).waitFor();
    assert.equal(await settings.getByText("Saved", { exact: true }).count(), 0);
    await page.screenshot({ path: join(artifacts, `settings-refused-${width}.png`), fullPage: true });
    refuseSave = false;
    await settings.getByRole("button", { name: "Save scheduling" }).click();
    await settings.getByRole("status", { name: "", exact: true }).filter({ hasText: "Saved" }).waitFor();
    assert.deepEqual(calls.findLast(c => c.cmd === "scheduling_set").args, { settings: { orientation: "agents", hostCap: 4 } });
    await settings.scrollIntoViewIfNeeded();
    if (width === 390) for (const target of await settings.locator(".scheduling-segments label, select, button").all()) {
      assert.ok((await target.boundingBox()).height >= 44, "phone scheduling targets are at least 44px");
    }
    await page.screenshot({ path: join(artifacts, `settings-${width}.png`), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await context.close();
    scheduling = { ...scheduling, orientation: "tasks", hostCap: 3 };
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: "pass", artifacts, widths: [1280, 390] }));
} catch (error) {
  for (const context of browser?.contexts() ?? []) for (const page of context.pages()) {
    await page.screenshot({ path: join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
    console.error((await page.locator("body").innerText().catch(() => "")).slice(0, 3500));
  }
  console.error("Evidence:", artifacts); throw error;
} finally { await browser?.close(); await server.close(); }
