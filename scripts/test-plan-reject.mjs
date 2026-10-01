// App-shell regression for rejecting a pending orchestration plan. The socket
// is mocked, but every frame and interaction goes through App.tsx, Sidebar,
// ChatPlanCards, PlanReview and OrchestrationPanel.
//
// At desktop and phone widths this proves that the pending card is at the
// chat tail, Reject opens the optional-reason step, and the recorded decision
// removes the tail card and pending badge while leaving one folded run record.
// A second run proves that rejecting an amendment restores its previously
// approved task instead of cancelling it.
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const artifacts = process.env.OCTIQ_EVIDENCE_DIR
  || await mkdtemp(join(tmpdir(), "octiq-plan-reject-"));
await mkdir(artifacts, { recursive: true });

const now = Date.now();
const chat = (id, title, age) => ({
  id, projectId: "general", title, customTitle: true, modelId: "codex:gpt-5.6-sol", access: "auto",
  sessionId: `session-${id}`, createdAt: now - 90_000, updatedAt: now - age, readAt: now,
});
const chats = [
  chat("first-plan", "Choose the import design", 10_000),
  chat("amend-plan", "Keep the payment worker", 20_000),
];
const task = (id, runId, title, over = {}) => ({
  id, runId, title, spec: `Implement ${title.toLowerCase()}.`, dependsOn: [], status: "ready",
  size: "medium", card: { problem: `${title} is not done.`, goal: title, acceptance: ["The focused regression passes"] },
  createdAt: now - 40_000, updatedAt: now - 20_000, ...over,
});
const run = (id, coordinator, objective, planApproval, over = {}) => ({
  id, coordinatorChatKey: coordinator, objective, workspaceId: "general", rootPath: "/repo/octiq-flow",
  status: "running", maxConcurrent: 2, createdAt: now - 50_000, updatedAt: now - 10_000,
  planApproval, ...over,
});

function initialSnapshot() {
  return {
    runs: [
      run("run-first", "chat:first-plan", "Choose the import design",
        { status: "pending", requestedAt: now - 20_000, revision: 0 }, { status: "planning" }),
      run("run-amend", "chat:amend-plan", "Keep the payment worker",
        {
          status: "pending", requestedAt: now - 15_000, revision: 3,
          consent: { via: "button", revision: 2, at: now - 30_000, surface: "panel", shownMs: 4_000 },
        }),
    ],
    tasks: [
      task("first-task", "run-first", "Replace the import parser"),
      // The current revision changed this approved task. Its approvedAt is
      // absent while the amendment waits; rejecting restores the old owner,
      // size and approval timestamp in the mocked host transition below.
      task("amended-task", "run-amend", "Keep the payment worker", {
        size: "large", assignee: { id: "noah", name: "Noah" },
        worker: { agent: "claude", access: "auto", model: "sonnet", effort: "high" },
      }),
      task("dependant", "run-amend", "Verify payment retries", {
        dependsOn: ["amended-task"], status: "pending", approvedAt: now - 30_000,
      }),
    ],
    attempts: [], gates: [], messages: [], notifications: [], reports: {}, nativeDecisions: [], services: [],
  };
}

const logs = new Map();
for (const item of chats) {
  logs.set(`chat:${item.id}`, [
    { seq: 1, event: { type: "user", uuid: `user-${item.id}`, octiq_user_turn: true,
      message: { content: [{ type: "text", text: `Plan ${item.title.toLowerCase()}.` }] } } },
    { seq: 2, event: { type: "item.completed", item: { id: `answer-${item.id}`, type: "agent_message",
      text: "I have prepared the plan below for your decision." } } },
    { seq: 3, event: { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } } },
  ]);
}

let snapshot = initialSnapshot();
let appSocket;
const calls = [];
const errors = [];
const server = await createServer({
  root: new URL("../web", import.meta.url).pathname,
  configFile: new URL("../web/vite.config.ts", import.meta.url).pathname,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

function recordRejection(args) {
  snapshot = structuredClone(snapshot);
  const selected = snapshot.runs.find((candidate) => candidate.id === args.runId);
  assert(selected, `unknown run ${args.runId}`);
  const amended = selected.id === "run-amend";
  selected.planApproval = {
    ...selected.planApproval,
    status: "rejected",
    decidedAt: now,
    rejection: {
      by: "person", revision: args.revision, at: now, reason: args.reason,
      taskIds: [...args.taskIds], restoredTaskIds: amended ? ["amended-task"] : [], surface: args.surface,
      shownMs: args.shownMs,
    },
  };
  selected.updatedAt = now;
  if (amended) {
    const restored = snapshot.tasks.find((candidate) => candidate.id === "amended-task");
    restored.approvedAt = now - 30_000;
    restored.size = "medium";
    restored.assignee = { id: "maya", name: "Maya" };
    restored.worker = { agent: "claude", access: "auto", model: "opus", effort: "high" };
    restored.status = "ready";
  } else {
    selected.status = "stopped";
    selected.stoppedReason = "Plan revision 0 rejected by the person.";
    for (const pending of snapshot.tasks.filter((candidate) => candidate.runId === selected.id)) {
      pending.status = "cancelled";
      pending.result = "Rejected by the person with plan revision 0.";
    }
  }
  return selected;
}

function resultFor(request) {
  switch (request.cmd) {
    case "list_workspaces": return [{ id: "general", name: "General", primary_path: "/repo/octiq-flow" }];
    case "chat_index_list": return chats;
    case "chat_index_deleted": return [];
    case "chat_page": return { events: logs.get(request.args?.key) ?? [], context: [], before: null };
    case "chat_since": return (logs.get(request.args?.key) ?? []).filter((frame) => frame.seq > (request.args?.after ?? 0));
    case "chat_list": return [];
    case "chat_activity": return [];
    case "chat_queue_state": return { live: false, queuedTurnIds: [] };
    case "orchestration_snapshot": return snapshot;
    case "orchestration_plan_reject": {
      const rejected = recordRejection(request.args);
      setTimeout(() => appSocket?.send(JSON.stringify({
        t: "event", event: "orchestration-changed", payload: { runId: request.args.runId, change: "plan_rejected" },
      })), 10);
      return rejected;
    }
    case "permission_pending": return [];
    case "question_pending": return [];
    case "safety_block_pending": return [];
    case "handover_list": return [];
    case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
    case "usage_summary": return {};
    case "agent_installs": return [{ id: "codex", installed: true, path: "/mock/codex" }, { id: "claude", installed: true, path: "/mock/claude" }];
    case "team_list": return [];
    case "team_leads": return [];
    case "chat_task": return { chatId: request.args?.chatId, projectId: "general" };
    case "sandbox_snapshot": return { defaultEnabled: false, environments: {} };
    case "codex_skills": return [];
    case "git_status": return { branch: "develop", files: [] };
    default: return null;
  }
}

const row = (page, title) => page.locator(".sidebar .chat-btn").filter({ has: page.locator(".chat-title", { hasText: title }) });
const badge = (page, title) => page.locator(".sidebar .chat").filter({ has: page.locator(".chat-title", { hasText: title }) }).locator(".pending-action-badge");
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
async function eventually(read, expected, label) {
  let actual;
  for (let i = 0; i < 100; i += 1) {
    actual = await read();
    if (actual === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
async function openChat(page, title) {
  const target = row(page, title);
  if (!(await target.isVisible().catch(() => false))) {
    const showChats = page.getByRole("button", { name: "Show chats", exact: true });
    if (await showChats.isVisible().catch(() => false)) await showChats.click();
    else await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  }
  await target.click();
  await page.locator(".chat-plans .plan-review").waitFor();
}
async function showRun(page) {
  const record = page.locator(".orch-plan-record .chat-plan-rejected");
  if (await record.isVisible().catch(() => false)) return record;
  const switcher = page.getByRole("button", { name: /^(Run|Tasks)( \(plan awaiting approval\))?$/ }).first();
  if (await switcher.isVisible().catch(() => false)) await switcher.click();
  await record.waitFor();
  return record;
}
async function rejectVisiblePlan(page, reason) {
  const tail = page.locator(".chat-plans .plan-review");
  await tail.getByRole("button", { name: "Reject", exact: true }).click();
  const input = tail.getByLabel("Reason for rejecting plan");
  await input.waitFor();
  if (reason) await input.fill(reason);
  return { tail, input };
}

let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  const base = `http://127.0.0.1:${server.httpServer.address().port}/`;

  for (const [label, viewport] of [["desktop", { width: 1440, height: 900 }], ["mobile", { width: 375, height: 812 }]]) {
    snapshot = initialSnapshot();
    const context = await browser.newContext({ viewport, reducedMotion: "reduce", deviceScaleFactor: 1 });
    await context.addInitScript(() => {
      if (location.protocol === "about:") return;
      localStorage.setItem("octiq.v2.gitColumn", "0");
      localStorage.setItem("octiq.theme", "dark");
    });
    await context.route("**/token", (route) => route.fulfill({ body: "mock-token" }));
    await context.route("**/auth", (route) => route.fulfill({ body: "ok" }));
    await context.routeWebSocket(/.*/, (socket) => {
      appSocket = socket;
      socket.onMessage((raw) => {
        const request = JSON.parse(String(raw));
        if (request.t !== "invoke") return;
        calls.push({ viewport: label, ...request });
        try {
          socket.send(JSON.stringify({ t: "reply", id: request.id, ok: true, result: resultFor(request) }));
        } catch (error) {
          socket.send(JSON.stringify({ t: "reply", id: request.id, ok: false, error: String(error) }));
        }
      });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.setDefaultNavigationTimeout(180_000);
    page.on("pageerror", (error) => errors.push(error.stack ?? String(error)));
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await row(page, "Choose the import design").waitFor({ state: "attached", timeout: 180_000 });

    await eventually(() => badge(page, "Choose the import design").textContent(), "Plan approval", `${label}: initial badge`);
    await openChat(page, "Choose the import design");
    const tail = page.locator(".chat-plans .plan-review");
    await tail.getByText("Plan ready for review", { exact: true }).waitFor();
    assert.equal(await tail.getAttribute("data-revision"), "0", `${label}: revision zero is present`);
    assert(await noSideways(page), `${label}: pending plan has no sideways scroll`);
    await page.screenshot({ path: join(artifacts, `${label}-pending.png`), fullPage: false });

    const reasonStep = await rejectVisiblePlan(page, "Not this direction");
    assert.equal(await reasonStep.input.inputValue(), "Not this direction");
    await page.screenshot({ path: join(artifacts, `${label}-reason.png`), fullPage: false });
    await reasonStep.tail.getByRole("button", { name: "Confirm reject", exact: true }).click();
    await eventually(() => page.locator(".chat-plans").count(), 0, `${label}: tail card removed`);
    await eventually(() => badge(page, "Choose the import design").count(), 0, `${label}: sidebar badge cleared`);
    const rejected = await showRun(page);
    assert.match(await rejected.innerText(), /Plan rejected · Not this direction/);
    assert.match(await rejected.innerText(), /revision 0/);
    assert(await noSideways(page), `${label}: rejected record has no sideways scroll`);
    await page.screenshot({ path: join(artifacts, `${label}-rejected.png`), fullPage: false });

    // A rejected amendment restores its prior approved state. The person sees
    // one folded rejection record saying so; the approved dependant remains.
    await openChat(page, "Keep the payment worker");
    await eventually(() => badge(page, "Keep the payment worker").textContent(), "Plan approval", `${label}: amendment badge`);
    const amendment = await rejectVisiblePlan(page, "");
    await amendment.tail.getByRole("button", { name: "Confirm reject", exact: true }).click();
    await eventually(() => page.locator(".chat-plans").count(), 0, `${label}: amendment tail removed`);
    await eventually(() => badge(page, "Keep the payment worker").count(), 0, `${label}: amendment badge cleared`);
    const amendmentRecord = await showRun(page);
    await amendmentRecord.locator("summary").click();
    await amendmentRecord.getByText("Restored to the approved plan: Keep the payment worker", { exact: true }).waitFor();
    const restored = snapshot.tasks.find((candidate) => candidate.id === "amended-task");
    const dependant = snapshot.tasks.find((candidate) => candidate.id === "dependant");
    assert.deepEqual(
      { status: restored.status, size: restored.size, assignee: restored.assignee?.name, approved: restored.approvedAt != null },
      { status: "ready", size: "medium", assignee: "Maya", approved: true },
      `${label}: amendment restores the approved task`,
    );
    assert.equal(dependant.status, "pending", `${label}: approved dependant was not cancelled`);
    assert(dependant.approvedAt != null, `${label}: dependant approval remains`);
    assert(await noSideways(page), `${label}: amendment record has no sideways scroll`);
    await context.close();
  }

  const decisions = calls.filter((call) => call.cmd === "orchestration_plan_reject");
  assert.equal(decisions.length, 4);
  assert(decisions.every((call) => call.args.actorChatKey?.startsWith("chat:")));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, mockedBackend: true, appShell: true, artifacts, decisions: decisions.length }));
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  await page?.screenshot({ path: join(artifacts, "failure.png") }).catch(() => {});
  console.error(JSON.stringify({ error: String(error), errors, artifacts }));
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
