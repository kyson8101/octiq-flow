// App-shell check for d59f830a: on a plan card still waiting for approval, the
// person can deliberately switch a Claude task to Manual command approval.
// The choice names the revision on screen, the plan then moves to a new
// revision (so Approve is held and approval is given again), and a Codex
// task is offered no such choice. The socket is mocked; the App is real.
//
//   PLAYWRIGHT_MODULE=<path to playwright/index.mjs> node scripts/test-command-approval-choice.mjs
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const artifacts = process.env.OCTIQ_EVIDENCE_DIR || await mkdtemp(join(tmpdir(), "octiq-command-approval-"));
await mkdir(artifacts, { recursive: true });

const now = Date.now();
const agent = (id, name, over = {}) => ({
  id, name, role: "", agent: "claude", model: "opus", effort: "high", access: "auto",
  createdAt: now - 100_000, updatedAt: now - 100_000, ...over,
});
const team = [
  agent("potato", "Potato Juice", { role: "Lead.", agent: "codex", model: "gpt-5.5" }),
  agent("mango", "Mango Juice", { role: "Developer.", projectId: "octiq", reportsTo: "potato" }),
];
const chats = [{
  id: "head-live", projectId: "general", title: "Ship the OTA", customTitle: true, modelId: "claude:opus",
  access: "auto", sessionId: "session-head", createdAt: now - 60_000, updatedAt: now - 50_000,
}];
const localChats = chats.map((item) => ({
  ...item,
  messages: [{ id: `m-${item.id}`, role: "assistant", streaming: false, blocks: [{ kind: "text", text: "Here is the plan." }] }],
}));
const RUN = "run_command_approval";
const task = (id, title, worker) => ({
  id, runId: RUN, title, spec: "Do it.", dependsOn: [], status: "pending", createdAt: now, updatedAt: now,
  assignee: { id: "mango", name: "Mango Juice" }, worker,
  card: { problem: "It is not published.", goal: "Publish it.", acceptance: ["It is live"] },
});
const run = (revision) => ({
  id: RUN, objective: "Publish the release", coordinatorChatKey: "chat:head-live", workspaceId: "general",
  rootPath: "/Users/kyson/General", status: "running", maxConcurrent: 1, createdAt: now, updatedAt: now,
  planApproval: { status: "pending", requestedAt: now, revision },
});
let snapshot;
const calls = [];
const errors = [];
let push = () => {};

function resultFor(request) {
  calls.push(request);
  switch (request.cmd) {
    case "list_workspaces": return [{ id: "general", name: "General", primary_path: "/Users/kyson/General" }];
    case "chat_index_list": return chats;
    case "chat_index_deleted": return [];
    case "chat_page": return { events: [], context: [], before: null };
    case "chat_list": return [];
    case "chat_activity": return [];
    case "chat_queue_state": return { live: false, queuedTurnIds: [] };
    case "orchestration_snapshot": return snapshot;
    case "orchestration_task_access": {
      // What the host does: the task's access changes and the plan's
      // revision moves, announced as a change.
      const { taskId, access } = request.args;
      snapshot = {
        ...snapshot,
        runs: [run(snapshot.runs[0].planApproval.revision + 1)],
        tasks: snapshot.tasks.map((t) => t.id === taskId ? { ...t, worker: { ...t.worker, access } } : t),
      };
      setTimeout(() => push("orchestration-changed", { runId: RUN, change: "task_access_chosen" }), 10);
      return snapshot.tasks.find((t) => t.id === taskId);
    }
    case "permission_pending": case "question_pending": case "safety_block_pending": return [];
    case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
    case "usage_summary": return {};
    case "agent_installs": return [{ id: "claude", installed: true, path: "/mock/claude" }];
    case "team_list": return team;
    case "team_head": return team[0];
    case "team_leads": return [];
    case "team_home": return "general";
    case "chat_task": return { chatId: request.args?.chatId, projectId: "general" };
    case "pr_repositories": return [];
    case "pr_local_list": case "pr_remote_list": return { items: [], warnings: [] };
    case "codex_skills": return [];
    case "agent_avatar_status": return { available: false, reason: "Not signed in to Codex." };
    case "sandbox_snapshot": return { defaultEnabled: false, environments: {} };
    default: return null;
  }
}

const server = await createServer({
  root: new URL("../web", import.meta.url).pathname,
  configFile: new URL("../web/vite.config.ts", import.meta.url).pathname,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
  for (const [label, width, height] of [["375", 375, 812], ["desktop", 1440, 960]]) {
    calls.length = 0;
    snapshot = {
      runs: [run(3)], attempts: [], gates: [], messages: [], notifications: [],
      tasks: [
        task("task_ota", "Publish the iOS OTA", { agent: "claude", access: "auto", model: "sonnet" }),
        task("task_codex", "Write the changelog", { agent: "codex", access: "auto", model: "gpt-5.6-terra" }),
      ],
    };
    const phone = width < 700;
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce", hasTouch: phone, isMobile: phone });
    await context.addInitScript((seed) => {
      localStorage.setItem("octiq.agentsMode", "on");
      localStorage.setItem("octiq.v2.gitColumn", "0");
      localStorage.setItem("octiq.v2.conversations", JSON.stringify(seed));
    }, localChats);
    await context.route("**/token", (route) => route.fulfill({ body: "mock-token" }));
    await context.routeWebSocket(/.*/, (socket) => {
      push = (event, payload) => socket.send(JSON.stringify({ t: "event", event, payload }));
      socket.onMessage((raw) => {
        const request = JSON.parse(String(raw));
        if (request.t !== "invoke") return;
        socket.send(JSON.stringify({ t: "reply", id: request.id, ok: true, result: resultFor(request) }));
      });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on("pageerror", (error) => errors.push(error.stack ?? String(error)));
    await page.goto(`${base}#/p/general/c/head-live`, { waitUntil: "domcontentloaded" });
    const card = page.locator(".chat-plans .plan-review");
    await card.waitFor();

    // The Codex task offers no choice; the Claude task does, and says Auto.
    await card.locator(".plan-task summary", { hasText: "Write the changelog" }).click();
    await card.locator(".plan-task summary", { hasText: "Publish the iOS OTA" }).click();
    const choice = card.locator(".plan-command-approval");
    assert.equal(await choice.count(), 1, `${label}: only the Claude task offers command approval`);
    assert.equal(await choice.getAttribute("data-access"), "auto", `${label}: Auto stays the default`);
    assert.match(await choice.innerText(), /refuses stays refused/);
    await page.screenshot({ path: join(artifacts, `command-approval-auto-${label}.png`), fullPage: false });

    await choice.getByText("Manual", { exact: true }).click();
    const sent = calls.find((call) => call.cmd === "orchestration_task_access")?.args;
    assert.deepEqual(sent, { runId: RUN, taskId: "task_ota", access: "manual", revision: 3 }, `${label}: the choice names the revision it was made on`);
    await page.locator('.chat-plans .plan-review[data-revision="4"]').waitFor();
    await card.locator('.plan-command-approval[data-access="manual"]').waitFor();
    assert.match(await card.locator(".plan-command-approval").innerText(), /You approve each command before it runs/);
    // A changed plan is held a moment, then approved again as revision 4.
    assert.equal(await card.getByRole("button", { name: "Approve plan" }).isDisabled(), true, `${label}: Approve is held after the change`);
    // Only the chosen option reads as chosen, once the 150ms fade is over.
    await page.waitForFunction(() => document.getAnimations().filter((a) => a.playState === "running").length === 0);
    const paint = await card.locator(".plan-command-approval-options label").evaluateAll((labels) => labels.map((el) => ({
      text: el.textContent.trim(), checked: el.hasAttribute("data-checked"), background: getComputedStyle(el).backgroundColor,
      border: getComputedStyle(el).borderColor, matches: [...document.styleSheets].flatMap((sheet) => {
        try { return [...sheet.cssRules].filter((rule) => rule.selectorText && el.matches(rule.selectorText)).map((rule) => rule.selectorText); } catch { return []; }
      }) })));
    const [unchosen, chosen] = [paint.find((p) => !p.checked), paint.find((p) => p.checked)];
    assert.equal(chosen.text, "Manual");
    assert.match(unchosen.background, /\/ 0\)|rgba\(0, 0, 0, 0\)/, `${label}: the unchosen option is not painted as chosen (${unchosen.background})`);
    assert.doesNotMatch(chosen.background, /\/ 0\)|rgba\(0, 0, 0, 0\)/, `${label}: the chosen option is tinted (${chosen.background})`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${label}: no sideways scroll`);
    await page.screenshot({ path: join(artifacts, `command-approval-manual-${label}.png`), fullPage: false });
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ pass: true, artifacts }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
