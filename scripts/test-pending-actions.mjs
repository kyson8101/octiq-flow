// App-shell regression for the chat list's "what is waiting on you" badges.
// The socket is mocked, but every step goes through App.tsx, the Sidebar, the
// run panel and the cards themselves, fed by the same commands and events the
// server sends: `permission_pending` / `question_pending` on connect,
// `permission-expired` / `question-expired`, and `orchestration-changed`.
//
// The ledger: "Ship the roster" coordinates two runs. The active one has a
// worker (hidden from the list) parked on a permission card; an older run,
// no longer the active one, has an open decision gate. "Plan the release"
// has a plan waiting at revision 2. "Pick a layout" holds a batch of two
// questions. "Quiet notes" holds nothing.
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const artifacts = process.env.OCTIQ_EVIDENCE_DIR
  || await mkdtemp(join(tmpdir(), "octiq-pending-actions-"));
await mkdir(artifacts, { recursive: true });

const now = Date.now();
const chat = (id, title, updated) => ({
  id, projectId: "general", title, customTitle: true, modelId: "codex:gpt-5.5", access: "auto",
  sessionId: `session-${id}`, createdAt: now - 90_000, updatedAt: now - updated, readAt: now,
});
const chats = [
  chat("lead", "Ship the roster", 10_000),
  chat("planner", "Plan the release", 20_000),
  chat("solo", "Pick a layout", 30_000),
  chat("quiet", "Quiet notes", 40_000),
  chat("orch-1", "Build the roster page", 50_000),
  chat("orch-2", "Payroll export API", 50_000),
  chat("orch-3", "Old migration", 60_000),
];
const task = (id, runId, over) => ({
  id, runId, spec: "", dependsOn: [], createdAt: now - 40_000, updatedAt: now - 20_000, ...over,
});
const attempt = (id, runId, taskId, chatKey, state = "executing") => ({
  id, runId, taskId, number: 1, workerChatKey: chatKey, agent: "codex", access: "auto",
  status: "running", cwd: "/w", branch: `feature/${taskId}`, isWorktree: true, filesModified: [],
  execution: { state, retryCount: 0, lastActivityAt: now - 1_000 },
  createdAt: now - 30_000, updatedAt: now - 1_000,
});
const run = (id, coordinator, objective, over) => ({
  id, coordinatorChatKey: coordinator, objective, workspaceId: "general", rootPath: "/Users/kyson/General",
  status: "running", maxConcurrent: 2, createdAt: now - 45_000, updatedAt: now - 20_000, ...over,
});
let snapshot = {
  runs: [
    run("run-now", "chat:lead", "Ship the roster"),
    run("run-old", "chat:lead", "Migrate the old roster", { status: "waiting", createdAt: now - 80_000, updatedAt: now - 70_000 }),
    run("run-plan", "chat:planner", "Plan the release", { status: "planning",
      planApproval: { status: "pending", requestedAt: now - 10_000, revision: 2 } }),
  ],
  tasks: [
    task("t1", "run-now", { title: "Build the roster page", status: "running", activeAttemptId: "a1" }),
    task("t2", "run-now", { title: "Payroll export API", status: "running", activeAttemptId: "a2" }),
    task("t3", "run-old", { title: "Old migration", status: "blocked", activeAttemptId: "a3" }),
    task("p1", "run-plan", { title: "Cut the release branch", status: "pending" }),
  ],
  attempts: [
    attempt("a1", "run-now", "t1", "chat:orch-1", "waiting_tool"),
    attempt("a2", "run-now", "t2", "chat:orch-2", "capacity_blocked"), // provider capacity is NOT the person's action
    attempt("a3", "run-old", "t3", "chat:orch-3", "blocked"),
  ],
  gates: [{ id: "gate-7", runId: "run-old", taskId: "t3", createdByChatKey: "chat:orch-3", targetChatKey: "chat:lead",
    question: "Drop the legacy column?", options: ["Drop it", "Keep it"], status: "open", createdAt: now - 60_000, updatedAt: now - 60_000 }],
  messages: [],
};
let permissions = [{ id: "perm-1", chatKey: "chat:orch-1", toolName: "Bash", toolInput: { command: "pnpm test" } }];
let questions = [
  { id: "q1", chatKey: "chat:solo", batch: "batch-1", batchSize: 2, question: "Which layout?", options: [{ label: "Grid" }, { label: "List" }] },
  { id: "q2", chatKey: "chat:solo", batch: "batch-1", batchSize: 2, question: "Which colour?", options: [{ label: "Amber" }, { label: "Blue" }] },
];

// Each chat's record. The lead is mid-turn, so its row is working as well as
// waiting on the person.
const logs = new Map();
const record = (key, event) => {
  const log = logs.get(key) ?? [];
  log.push({ seq: log.length + 1, event });
  logs.set(key, log);
};
for (const { id, title } of chats) {
  record(`chat:${id}`, { type: "user", uuid: `u-${id}`, octiq_user_turn: true, message: { content: [{ type: "text", text: `Start: ${title}` }] } });
  record(`chat:${id}`, { type: "item.completed", item: { id: `i-${id}`, type: "agent_message", text: `${title} — first answer.` } });
  if (id !== "lead") record(`chat:${id}`, { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
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
    case "orchestration_snapshot": return snapshot;
    case "permission_pending": return permissions;
    case "question_pending": return questions;
    case "safety_block_pending": return [];
    case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
    case "usage_summary": return {};
    case "agent_installs": return [{ id: "codex", installed: true, path: "/mock/codex" }, { id: "claude", installed: true, path: "/mock/claude" }];
    case "team_list": return [];
    case "team_leads": return [];
    case "chat_task": return { chatId: request.args?.chatId, projectId: "general" };
    case "sandbox_snapshot": return { defaultEnabled: false, environments: {} };
    case "codex_skills": return [];
    case "git_status": return { branch: "main", files: [] };
    default: return null;
  }
}
const send = (event, payload) => appSocket?.send(JSON.stringify({ t: "event", event, payload }));
const ledgerChanged = () => send("orchestration-changed", { runId: "any" });

const badge = (page, title) => page.locator(".sidebar .chat").filter({ has: page.locator(".chat-title", { hasText: title }) }).locator(".pending-action-badge");
const rowButton = (page, title) => page.locator(".sidebar .chat-btn").filter({ has: page.locator(".chat-title", { hasText: title }) });
/** Decisions: anything that would answer a card, rather than show it. */
const decisions = () => calls.filter(({ cmd }) => /respond|answer|approve|resolve|allow|decide|deny/i.test(cmd));
async function focusedKeys(page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    const holder = active?.closest("[data-pending-keys]") ?? active?.parentElement?.closest("[data-pending-keys]");
    const box = active?.getBoundingClientRect();
    return {
      keys: holder?.getAttribute("data-pending-keys") ?? null,
      onScreen: !!box && box.bottom > 0 && box.top < innerHeight && box.width > 0,
    };
  });
}
async function waitForFocus(page, key) {
  for (let i = 0; i < 80; i += 1) {
    const got = await focusedKeys(page);
    if (got.keys?.split(" ").includes(key) && got.onScreen) return got;
    await page.waitForTimeout(50);
  }
  throw new Error(`card ${key} was not shown and focused: ${JSON.stringify(await focusedKeys(page))}`);
}
async function textOf(locator) {
  return (await locator.count()) ? (await locator.innerText()).trim() : null;
}
async function eventually(read, expected, what) {
  let last;
  for (let i = 0; i < 80; i += 1) {
    last = await read();
    if (last === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(last)}`);
}
// Progress on stderr, so a stall names the step it stopped in.
const step = (name) => console.error(`[pending-actions] ${name}`);
const noSideScroll = (page) =>page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

let browser;
const results = {};
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await context.addInitScript(() => {
    if (location.protocol === "about:") return;
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
  page.setDefaultTimeout(20_000);
  // Vite transforms the whole client on the first load, which takes minutes
  // on a busy machine; the steps after it keep the short timeout.
  page.setDefaultNavigationTimeout(180_000);
  page.on("pageerror", (error) => errors.push(error.stack ?? String(error)));
  const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await rowButton(page, "Quiet notes").waitFor({ timeout: 180_000 });
  step("1 list");

  // 1. Every row knows before any chat is opened, workers roll up, workers
  //    stay out of the list, and a worker waiting on capacity asks nothing.
  await eventually(() => textOf(badge(page, "Ship the roster")), "Action needed · 2", "lead aggregate");
  assert.equal(await textOf(badge(page, "Plan the release")), "Plan approval");
  assert.equal(await textOf(badge(page, "Pick a layout")), "Answer needed");
  assert.equal(await badge(page, "Quiet notes").count(), 0);
  for (const worker of ["Build the roster page", "Payroll export API", "Old migration"]) {
    assert.equal(await rowButton(page, worker).count(), 0, `${worker} stays out of the list`);
  }
  assert.equal(calls.filter(({ cmd, args }) => cmd === "chat_page" && args?.key === "chat:lead").length, 0, "lead's transcript not read for its badge");
  assert.match(await badge(page, "Ship the roster").getAttribute("aria-label"), /1 permission request, 1 decision/);
  assert.match(await rowButton(page, "Ship the roster").getAttribute("aria-label"), /Action needed · 2/);
  assert(await noSideScroll(page));
  await page.screenshot({ path: join(artifacts, "desktop-list.png") });

  // 2. Ordinary row navigation is untouched: the row opens its chat and
  //    looks for no card.
  step("2 row navigation");
  await rowButton(page, "Quiet notes").click();
  await page.locator("#dock").getByText("Quiet notes — first answer.").waitFor();
  assert.equal((await focusedKeys(page)).keys, null);

  // 3. The badge goes to the card — the worker's permission, drawn in the
  //    main chat — and answers nothing.
  step("3 permission badge");
  await badge(page, "Ship the roster").click();
  results.permission = await waitForFocus(page, "permission:perm-1");
  assert.match(await page.locator(".sidebar .chat.is-on .chat-title").innerText(), /Ship the roster/);
  assert.deepEqual(decisions(), [], "showing a card decides nothing");
  // The lead starts a turn while it waits on you: both signals stand.
  record("chat:lead", { type: "turn.started" });
  const leadLog = logs.get("chat:lead");
  send("chat-event", { key: "chat:lead", seq: leadLog.length, event: leadLog.at(-1).event });
  const busyAndPending = page.locator(".sidebar .chat.is-busy.has-pending").filter({ has: page.locator(".chat-title", { hasText: "Ship the roster" }) });
  await eventually(() => busyAndPending.count(), 1, "lead busy and pending");
  // The task row in the run panel carries its own card.
  const taskBadge = page.locator(".orch-task").filter({ has: page.locator(".orch-task-title", { hasText: "Build the roster page" }) }).locator(".pending-action-badge");
  assert.equal(await textOf(taskBadge), "Permission needed");
  await page.screenshot({ path: join(artifacts, "desktop-permission-revealed.png") });

  // 4. The permission settles elsewhere: the aggregate drops to the gate.
  step("4 permission settles");
  permissions = [];
  send("permission-expired", { id: "perm-1" });
  await eventually(() => textOf(badge(page, "Ship the roster")), "Decision needed", "lead after permission settles");
  assert.equal(await taskBadge.count(), 0);

  // 5. The gate belongs to the older run: the badge opens that run and its
  //    decision, by keyboard.
  step("5 gate on the older run, by keyboard");
  await badge(page, "Ship the roster").focus();
  await page.keyboard.press("Enter");
  results.gate = await waitForFocus(page, "gate:gate-7");
  assert.deepEqual(decisions(), []);
  await page.screenshot({ path: join(artifacts, "desktop-gate-revealed.png") });

  // 6. Resolved: gone. Cancelled or resolved gates never come back.
  snapshot = { ...snapshot, gates: snapshot.gates.map((gate) => ({ ...gate, status: "resolved", resolution: "Drop it" })) };
  ledgerChanged();
  await eventually(() => badge(page, "Ship the roster").count(), 0, "lead after gate resolves");

  // 7. The plan: shown in its chat, then approved, then a new revision asks again.
  step("7 plan, approval, new revision");
  await badge(page, "Plan the release").click();
  results.plan = await waitForFocus(page, "plan:run-plan:2");
  assert.deepEqual(decisions(), []);
  await page.screenshot({ path: join(artifacts, "desktop-plan-revealed.png") });
  const planRun = (planApproval) => ({ ...snapshot, runs: snapshot.runs.map((r) => r.id === "run-plan" ? { ...r, planApproval } : r) });
  snapshot = planRun({ status: "approved", requestedAt: now, decidedAt: now, revision: 2 });
  ledgerChanged();
  await eventually(() => badge(page, "Plan the release").count(), 0, "plan approved");
  snapshot = planRun({ status: "pending", requestedAt: now, revisedAt: now, revision: 3 });
  ledgerChanged();
  await eventually(() => textOf(badge(page, "Plan the release")), "Plan approval", "new revision asks again");

  // 8. One question of a batch answered: the card, and its badge, stay.
  step("8 one question of a batch");
  questions = questions.filter((q) => q.id !== "q1");
  send("question-expired", { id: "q1" });
  await page.waitForTimeout(400);
  assert.equal(await textOf(badge(page, "Pick a layout")), "Answer needed");
  await badge(page, "Pick a layout").click();
  results.question = await waitForFocus(page, "question:batch-1");

  // 9. A reload asks the host again; identities hold, answered ones stay gone.
  step("9 reload");
  permissions = [{ id: "perm-2", chatKey: "chat:orch-2", toolName: "Edit", toolInput: { file_path: "/w/api.ts" } }];
  await page.goto("about:blank");
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await eventually(() => textOf(badge(page, "Ship the roster")), "Permission needed", "after reload");
  assert.equal(await textOf(badge(page, "Plan the release")), "Plan approval");
  assert.equal(await textOf(badge(page, "Pick a layout")), "Answer needed");

  // 9b. Answers saved and waiting for delivery ask nothing more; a failed
  //     delivery is its own action. Records are question_store's `Asked`
  //     view: status is per call — pending, saved or failed.
  step("9b saved and failed answers");
  const asked = (id, batch, question, status, over = {}) => ({
    id, chatKey: "chat:solo", batch, batchSize: 2, question, options: [{ label: "Yes" }, { label: "No" }], status,
    ...(status === "pending" ? {} : { answer: "Yes" }), retryable: false, ...over,
  });
  const failure = { error: "Your answers are saved. Could not continue the agent: the agent is not running", retryable: true };
  // A second call arrives in the same chat: two cards' worth, one badge each.
  for (const q of [asked("q3", "batch-2", "Ship today?", "pending"), asked("q4", "batch-2", "Tell the team?", "pending")]) send("user-question", q);
  await eventually(() => textOf(badge(page, "Pick a layout")), "Action needed · 2", "two calls waiting");
  // The first call's last answer is saved: only the second call remains, under its own key.
  send("question-updated", asked("q2", "batch-1", "Which colour?", "saved"));
  await eventually(() => textOf(badge(page, "Pick a layout")), "Answer needed", "saved call drops out of the count");
  await badge(page, "Pick a layout").click();
  results.secondCall = await waitForFocus(page, "question:batch-2");
  assert.equal(await page.locator('[data-pending-keys~="question:batch-1"]').count(), 0, "saved call is no target");
  // Every call saved: the card stays, saying so, and the badge goes.
  for (const id of ["q3", "q4"]) send("question-updated", asked(id, "batch-2", id === "q3" ? "Ship today?" : "Tell the team?", "saved"));
  await eventually(() => badge(page, "Pick a layout").count(), 0, "all answers saved");
  assert.equal(await page.locator(".sidebar .chat.has-pending").filter({ has: page.locator(".chat-title", { hasText: "Pick a layout" }) }).count(), 0);
  await page.locator(".qa-card").getByText("Answers saved · waiting for agent").waitFor();
  await page.screenshot({ path: join(artifacts, "desktop-saved-no-badge.png") });
  // A reload asks question_pending, which still lists the saved records.
  questions = [asked("q2", "batch-1", "Which colour?", "saved"), asked("q3", "batch-2", "Ship today?", "saved"), asked("q4", "batch-2", "Tell the team?", "saved")];
  await page.goto("about:blank");
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await eventually(() => textOf(badge(page, "Ship the roster")), "Permission needed", "reloaded");
  await page.waitForTimeout(400);
  assert.equal(await badge(page, "Pick a layout").count(), 0, "saved answers stay quiet after a reload");
  // Delivery fails: the person's Retry or Cancel is the only way on.
  for (const id of ["q3", "q4"]) send("question-updated", asked(id, "batch-2", id === "q3" ? "Ship today?" : "Tell the team?", "failed", failure));
  await eventually(() => textOf(badge(page, "Pick a layout")), "Delivery failed", "failed delivery");
  assert.match(await badge(page, "Pick a layout").getAttribute("aria-label"), /1 failed answer delivery/);
  await badge(page, "Pick a layout").click();
  results.delivery = await waitForFocus(page, "delivery:batch-2");
  await page.locator(".qa-card .qa-restore").click();
  await page.getByRole("button", { name: "Retry delivery" }).waitFor();
  // The card opens out of its strip with an animation; shoot it settled.
  await page.waitForFunction(() => document.querySelector(".qa-card")?.getAnimations({ subtree: true }).length === 0);
  assert.deepEqual(calls.filter(({ cmd }) => /^question_(retry|cancel|answer)/.test(cmd)), [], "showing a failed card retries nothing");
  await page.screenshot({ path: join(artifacts, "desktop-delivery-failed-revealed.png") });
  // The retry is taken: saved again, then delivered.
  for (const id of ["q3", "q4"]) send("question-updated", asked(id, "batch-2", "Again?", "saved"));
  await eventually(() => badge(page, "Pick a layout").count(), 0, "retried delivery");
  questions = [];
  for (const id of ["q2", "q3", "q4"]) send("question-expired", { id });
  await eventually(() => page.locator(".qa-card").count(), 0, "delivered answers leave");

  // 10. A phone: the list is its own screen, every badge fits its row, and
  //     tapping one lands on the card in the chat.
  step("10 phone");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("about:blank");
  await page.goto(base, { waitUntil: "domcontentloaded" });
  const showChats = page.getByRole("button", { name: /^Show chats/ });
  if (await showChats.isVisible().catch(() => false)) await showChats.click();
  await eventually(() => textOf(badge(page, "Ship the roster")), "Permission needed", "phone badge");
  const fit = await page.evaluate(() => [...document.querySelectorAll(".sidebar .chat.has-pending")].map((row) => {
    const r = row.getBoundingClientRect();
    const b = row.querySelector(".pending-action-badge").getBoundingClientRect();
    return { left: b.left >= r.left, right: b.right <= r.right + 0.5, bottom: b.bottom <= r.bottom + 0.5, height: b.height };
  }));
  for (const item of fit) {
    assert(item.left && item.right && item.bottom, `badge inside its row: ${JSON.stringify(fit)}`);
    assert(item.height >= 28, `badge tall enough to tap: ${item.height}`);
  }
  assert(await noSideScroll(page), "no sideways scroll on a phone");
  results.phone = fit;
  await page.screenshot({ path: join(artifacts, "phone-list.png") });
  await badge(page, "Ship the roster").click();
  results.phonePermission = await waitForFocus(page, "permission:perm-2");
  assert(await noSideScroll(page));
  await page.screenshot({ path: join(artifacts, "phone-permission-revealed.png") });
  assert.deepEqual(decisions(), []);

  // 11. A phone, after a reconnect: a saved call is quiet, a failed one says
  //     so, fits its row, and a tap lands on the card.
  step("11 phone saved and failed");
  questions = [
    { ...asked("q5", "batch-5", "Keep notes?", "saved"), chatKey: "chat:quiet" },
    { ...asked("q6", "batch-5", "Share them?", "saved"), chatKey: "chat:quiet" },
    asked("q7", "batch-7", "Deploy now?", "failed", failure),
    asked("q8", "batch-7", "Post a note?", "failed", failure),
  ];
  await page.goto("about:blank");
  await page.goto(base, { waitUntil: "domcontentloaded" });
  if (await showChats.isVisible().catch(() => false)) await showChats.click();
  await eventually(() => textOf(badge(page, "Pick a layout")), "Delivery failed", "phone failed delivery");
  assert.equal(await badge(page, "Quiet notes").count(), 0, "phone: saved answers ask nothing");
  const failedFit = await page.evaluate(() => {
    const row = [...document.querySelectorAll(".sidebar .chat.has-pending")].find((r) => r.textContent.includes("Pick a layout"));
    const r = row.getBoundingClientRect();
    const b = row.querySelector(".pending-action-badge").getBoundingClientRect();
    return { inside: b.left >= r.left && b.right <= r.right + 0.5 && b.bottom <= r.bottom + 0.5, height: b.height };
  });
  assert(failedFit.inside && failedFit.height >= 28, `failed badge fits: ${JSON.stringify(failedFit)}`);
  assert(await noSideScroll(page));
  results.phoneDeliveryFit = failedFit;
  await page.screenshot({ path: join(artifacts, "phone-saved-and-failed-list.png") });
  await badge(page, "Pick a layout").click();
  results.phoneDelivery = await waitForFocus(page, "delivery:batch-7");
  assert(await noSideScroll(page));
  await page.screenshot({ path: join(artifacts, "phone-delivery-failed-revealed.png") });
  assert.deepEqual(calls.filter(({ cmd }) => /^question_(retry|cancel|answer)/.test(cmd)), []);

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, mockedBackend: true, artifacts, results }));
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  await page?.screenshot({ path: join(artifacts, "failure.png") }).catch(() => {});
  console.error(JSON.stringify({ error: String(error), errors, artifacts }));
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
