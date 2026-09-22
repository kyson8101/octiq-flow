// Real App with a mocked socket; this never launches an agent or touches live chats.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const artifacts = await mkdtemp(join(tmpdir(), "octiq-worker-readonly-"));
const server = await createServer({ root: new URL("../web", import.meta.url).pathname,
  server: { host: "127.0.0.1", port: 0, strictPort: false } });
const chats = ["master", "orch-worker", "orch-orphan"].map((id) => ({
  id, projectId: "general", title: id, customTitle: true, modelId: "claude:sonnet",
  sessionId: `session-${id}`, createdAt: 1, updatedAt: 2,
}));
const snapshot = {
  runs: [{ id: "run", coordinatorChatKey: "chat:master", objective: "Ship the feature",
    workspaceId: "general", rootPath: "/test", status: "waiting", maxConcurrent: 2, createdAt: 1, updatedAt: 2 }],
  tasks: [{ id: "task", runId: "run", title: "Implement it", spec: "The assigned task", dependsOn: [],
    status: "blocked", activeAttemptId: "attempt", createdAt: 1, updatedAt: 2 }],
  attempts: [{ id: "attempt", runId: "run", taskId: "task", number: 1, workerChatKey: "chat:orch-worker",
    agent: "claude", access: "auto", status: "blocked", cwd: "/test", branch: "feature/worker",
    isWorktree: true, filesModified: [], createdAt: 1, updatedAt: 2 }],
  gates: [{ id: "gate", runId: "run", taskId: "task", createdByChatKey: "chat:orch-worker",
    targetChatKey: "chat:master", question: "Keep the current behavior?", options: ["Keep", "Change"],
    status: "open", createdAt: 1, updatedAt: 2 }], messages: [],
};
const calls = [], errors = [];
let browser, failLedger = false;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
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
    if (request.cmd === "permission_pending") result = [{ id: "worker-approval", chatKey: "chat:orch-worker", toolName: "Bash", toolInput: { command: "echo example" } }];
    if (request.cmd === "memory_usage") result = { totalMb: 0, procs: 0, rows: [] };
    if (request.cmd === "usage_summary") result = {};
    if (request.cmd === "git_status") result = { branch: "main", files: [] };
    if (request.cmd === "agent_installs") result = [{ id: "claude", installed: true, path: "/mock/claude" }];
    socket.send(JSON.stringify({ t: "reply", id: request.id, ok: !(failLedger && request.cmd === "orchestration_snapshot"), result,
      error: failLedger ? "Ledger unavailable" : undefined }));
  }));
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(String(error)));
  const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
  await page.goto(`${base}#/p/general/c/orch-worker`);
  const notice = page.getByRole("note", { name: "Read-only agent chat" });
  await notice.waitFor();
  await page.getByRole("button", { name: "Open main chat", exact: true }).waitFor();
  assert.equal(await page.locator(".composer").count(), 0);
  assert.equal(await page.locator("textarea").count(), 0);
  assert.equal(await page.getByRole("button", { name: "Delete this chat", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Allow once", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Actions for orch-worker", exact: true }).click();
  assert.equal(await page.getByRole("menuitem", { name: "Delete chat", exact: true }).count(), 0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Orchestrator/ }).click();
  const panel = page.getByRole("dialog", { name: "Orchestrator" });
  await panel.getByText("Keep the current behavior?", { exact: true }).waitFor();
  assert.equal(await panel.locator("input, textarea").count(), 0);
  assert.equal(await panel.getByRole("button", { name: "Stop run", exact: true }).count(), 0);
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await page.screenshot({ path: join(artifacts, "worker-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await notice.waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(artifacts, "worker-mobile.png") });
  await page.getByRole("button", { name: "Open main chat", exact: true }).click();
  await page.locator("textarea").waitFor();
  await page.getByRole("region", { name: "Agent safety approvals" }).waitFor();
  assert.equal(await notice.count(), 0);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "Delete this chat", exact: true }).waitFor();
  await page.getByRole("button", { name: /^Orchestrator/ }).click();
  await panel.getByRole("button", { name: "Keep", exact: true }).click();
  // Claude echoes user bubbles on its stream; this fake backend only records
  // the launch request. Assert delivery without inventing provider output.
  for (let i = 0; i < 75 && !calls.some(({ cmd }) => ["chat_send", "chat_start"].includes(cmd)); i++) {
    await page.waitForTimeout(200);
  }
  const sends = calls.filter(({ cmd }) => ["chat_send", "chat_start"].includes(cmd));
  assert.equal(sends.length, 1, JSON.stringify(sends));
  assert.equal(sends[0].args.key, "chat:master");
  assert.match(sends[0].args.text ?? sends[0].args.prompt, /My answer: Keep/);
  assert.equal(calls.some(({ cmd }) => cmd === "orchestration_gate_resolve"), false, "Only the main agent resolves gates");
  assert.equal(calls.some(({ cmd }) => cmd === "permission_decide"), false, "No implicit safety approval");

  failLedger = true;
  await page.goto(`${base}#/p/general/c/orch-orphan`);
  await page.reload();
  await notice.waitFor();
  assert.equal(await page.locator("textarea").count(), 0, "Missing ledger or parent never enables worker input");
  assert.equal(await page.getByRole("button", { name: "Open main chat", exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, artifacts }));
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  console.error(JSON.stringify({ errors, sends: calls.filter(({ cmd }) => ["chat_start", "chat_send"].includes(cmd)),
    text: await page?.locator(".main").innerText() }));
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
