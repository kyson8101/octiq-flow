// App-shell regression for the feedback-backlog fixes, at 375px and a desktop
// width. The socket is mocked; everything else is the real App.
//
//  - 020e4309: the new-chat welcome shows a lead's long role as one summary
//    line, with the rest behind Details, and keeps the picker and composer in reach.
//  - f3fab989: every Settings section is on screen at 375px.
//  - 713786e9: a plan that changes under an open card holds Approve briefly,
//    and a click sends the card, revision and how long it was shown.
//  - settled plan: once approved, the card leaves the chat; the run panel
//    keeps its record.
//  - d59f830a: a Claude auto-mode card names the exact line, allows exactly
//    that once through the host, then tells the agent.
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const artifacts = process.env.OCTIQ_EVIDENCE_DIR
  || await mkdtemp(join(tmpdir(), "octiq-feedback-backlog-"));
await mkdir(artifacts, { recursive: true });

const now = Date.now();
const ROLE = "CTO and the person's lead across every OctiqFlow project. Owns technical direction, splits objectives into tasks for the right project leads, reviews integrated results before anything is called done, and keeps approval, release and deployment gates with the person. Never writes in a checkout a worker holds; escalates real decisions through gates rather than guessing. Keeps memory short: decisions and why, gotchas, what to pick up next.";
const agent = (id, name, over = {}) => ({
  id, name, role: "", agent: "claude", model: "opus", effort: "high", access: "auto",
  createdAt: now - 100_000, updatedAt: now - 100_000, ...over,
});
const team = [
  agent("potato", "Potato Juice", { role: ROLE, agent: "codex", model: "gpt-5.5" }),
  agent("mango", "Mango Juice", { role: "OctiqFlow full-stack developer.", projectId: "octiq", reportsTo: "potato" }),
];
const chats = [{
  id: "head-live", projectId: "general", title: "Plan the release", customTitle: true, modelId: "claude:opus",
  access: "auto", sessionId: "session-head", createdAt: now - 60_000, updatedAt: now - 50_000,
}];
const localChats = chats.map((item) => ({
  ...item,
  messages: [{ id: `m-${item.id}`, role: "assistant", streaming: false, blocks: [{ kind: "text", text: `${item.title} answer.` }] }],
}));

const RUN = "run_077cef3574e64adead9ce5c81477d98b";
const task = (id, title) => ({
  id, runId: RUN, title, spec: "Do it.", dependsOn: [], status: "pending", createdAt: now, updatedAt: now,
  assignee: { id: "mango", name: "Mango Juice" }, worker: { agent: "claude", access: "auto", model: "opus", effort: "high" },
  card: { problem: "It is broken.", goal: "Fix it.", acceptance: ["It works"] },
});
const run = (planApproval) => ({
  id: RUN, objective: "Fix the backlog", coordinatorChatKey: "chat:head-live", workspaceId: "general",
  rootPath: "/Users/kyson/General", status: "running", maxConcurrent: 1, createdAt: now, updatedAt: now, planApproval,
});
let snapshot = { runs: [], tasks: [], attempts: [], gates: [], messages: [], notifications: [] };
let pendingCards = [];
const calls = [];
const errors = [];

const server = await createServer({
  root: new URL("../web", import.meta.url).pathname,
  configFile: new URL("../web/vite.config.ts", import.meta.url).pathname,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

function resultFor(request) {
  calls.push(request);
  switch (request.cmd) {
    case "list_workspaces": return [
      { id: "general", name: "General", primary_path: "/Users/kyson/General" },
      { id: "octiq", name: "OctiqFlow", primary_path: "/repo/octiq", color: "#3b82f6" },
    ];
    case "chat_index_list": return chats;
    case "chat_index_deleted": return [];
    case "chat_page": return { events: [], context: [], before: null };
    case "chat_list": return [];
    case "chat_activity": return [];
    case "chat_queue_state": return { live: false, queuedTurnIds: [] };
    case "orchestration_snapshot": return snapshot;
    case "orchestration_plan_approve": return snapshot.runs[0];
    case "permission_pending": return [];
    case "question_pending": return [];
    case "safety_block_pending": return pendingCards;
    case "safety_block_grant_exact":
      pendingCards = pendingCards.filter((card) => card.id !== request.args?.id);
      return { rule: "Bash(eas update --branch production)", deliveredToWorker: false };
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

const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const lines = (locator) => locator.evaluate((el) => {
  const style = getComputedStyle(el);
  const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.45;
  return el.getBoundingClientRect().height / line;
});

let browser;
let push = () => {};
async function open(width, height, hash, seed = localChats) {
  const phone = width < 700;
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce", hasTouch: phone, isMobile: phone });
  await context.addInitScript((chats) => {
    localStorage.setItem("octiq.agentsMode", "on");
    localStorage.setItem("octiq.v2.gitColumn", "0");
    localStorage.setItem("octiq.v2.conversations", JSON.stringify(chats));
  }, seed);
  await context.route("**/token", (route) => route.fulfill({ body: "mock-token" }));
  await context.route("**/auth", (route) => route.fulfill({ body: "ok" }));
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
  await page.goto(`${base}${hash}`, { waitUntil: "domcontentloaded" });
  return { page, context, phone };
}
let base;

try {
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  base = `http://127.0.0.1:${server.httpServer.address().port}/`;

  for (const [label, width, height] of [["375", 375, 812], ["desktop", 1440, 960]]) {
    // ── 020e4309: the welcome, with no chat open.
    {
      snapshot = { runs: [], tasks: [], attempts: [], gates: [], messages: [], notifications: [] };
      const { page, context } = await open(width, height, "#/", []);
      // The compact welcome (7c6e283) superseded the two-line clamp: one
      // summary line, and the whole role behind Details.
      const summary = page.locator(".hero .agent-welcome-summary");
      await summary.waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: join(artifacts, `welcome-${label}.png`), fullPage: false });
      assert((await lines(summary)) <= 2.05, `welcome-${label}: the summary is short`);
      const role = page.locator(".hero .agent-welcome-role");
      assert.equal(await role.isVisible(), false, `welcome-${label}: the role waits for Details`);
      const toggle = page.getByRole("button", { name: "Details about Potato Juice", exact: true });
      assert.equal(await toggle.isVisible(), true, `welcome-${label}: the rest of the role is on request`);
      const composer = page.locator(".composer textarea, .composer [contenteditable]").first();
      const box = await composer.boundingBox();
      assert(box && box.y + box.height <= height, `welcome-${label}: the message box is in reach (${box?.y})`);
      await toggle.click();
      assert.equal((await role.textContent()), ROLE, `welcome-${label}: the open role is the stored role`);
      assert.equal(await noHorizontalScroll(page), true, `welcome-${label}: no sideways scroll`);
      await page.screenshot({ path: join(artifacts, `welcome-${label}-open.png`), fullPage: false });
      await context.close();
    }

    // ── f3fab989: every Settings section on screen.
    {
      const { page, context, phone } = await open(width, height, "#/p/general/c/head-live");
      await page.locator(".main").getByText("Plan the release answer.", { exact: true }).waitFor();
      if (phone) await page.getByRole("button", { name: "Show chats", exact: true }).click();
      await page.locator(".sidebar-places").getByRole("button", { name: "Settings", exact: true }).click();
      const items = page.locator(".settings-nav-item");
      await items.first().waitFor();
      const boxes = await items.evaluateAll((els) => els.map((el) => {
        const r = el.getBoundingClientRect();
        return { text: el.textContent.trim(), left: r.left, right: r.right, top: r.top, visible: r.width > 0 && r.height > 0 };
      }));
      for (const item of boxes) {
        assert(item.visible && item.left >= -0.5 && item.right <= width + 0.5, `settings-${label}: "${item.text}" is off screen (${item.left}–${item.right})`);
      }
      assert(boxes.length >= 5, `settings-${label}: ${boxes.length} sections`);
      assert.equal(await noHorizontalScroll(page), true, `settings-${label}: no sideways scroll`);
      await page.screenshot({ path: join(artifacts, `settings-${label}.png`), fullPage: false });
      await context.close();
    }

    // ── 713786e9 + settled plan: a plan changed under the card, then approved.
    {
      calls.length = 0;
      snapshot = {
        runs: [run({ status: "pending", requestedAt: now, revision: 3 })],
        tasks: [task("task_a", "Fix approvals")], attempts: [], gates: [], messages: [], notifications: [],
      };
      const { page, context } = await open(width, height, "#/p/general/c/head-live");
      await page.locator(".main").getByText("Plan the release answer.", { exact: true }).waitFor();
      const card = page.locator(".chat-plans .plan-review");
      await card.waitFor();
      const approve = card.getByRole("button", { name: "Approve plan" });
      assert.equal(await approve.isEnabled(), true, `plan-${label}: a card opened on its plan is not held`);
      // The lead adds a task: revision 4 replaces 3 on the open card.
      snapshot = {
        ...snapshot,
        runs: [run({ status: "pending", requestedAt: now, revision: 4 })],
        tasks: [task("task_a", "Fix approvals"), task("task_b", "Settle the card")],
      };
      push("orchestration-changed", { runId: RUN, change: "task_created" });
      const updated = page.locator(".chat-plans .plan-review[data-updated]");
      await updated.waitFor();
      assert.equal(await card.getAttribute("data-revision"), "4");
      assert.equal(await approve.isDisabled(), true, `plan-${label}: Approve is held right after a change`);
      assert.match(await card.innerText(), /Updated just now to revision 4/);
      await page.screenshot({ path: join(artifacts, `plan-updated-${label}.png`), fullPage: false });
      await page.waitForFunction(() => !document.querySelector(".chat-plans .plan-review[data-updated]"));
      await approve.click();
      const sent = calls.filter((call) => call.cmd === "orchestration_plan_approve").at(-1)?.args;
      assert.equal(sent?.revision, 4, `plan-${label}: the click names the revision it showed`);
      assert.deepEqual([...sent.taskIds].sort(), ["task_a", "task_b"]);
      assert.equal(sent.surface, "chat");
      assert(sent.updatedMs >= 1500 && sent.shownMs >= 1500, `plan-${label}: shown ${sent.shownMs}ms, updated ${sent.updatedMs}ms`);
      // The host confirms: the card leaves the chat, the run keeps the record.
      snapshot = {
        ...snapshot,
        runs: [run({ status: "approved", requestedAt: now, decidedAt: now, revision: 4,
          consent: { via: "button", revision: 4, at: now, surface: "chat", shownMs: sent.shownMs } })],
        tasks: snapshot.tasks.map((item) => ({ ...item, approvedAt: now, status: "ready" })),
      };
      push("orchestration-changed", { runId: RUN, change: "plan_approved" });
      await page.locator(".chat-plans").waitFor({ state: "detached" });
      if (width >= 1181) {
        const record = page.locator(".orch-plan-record .chat-plan-line");
        await record.waitFor();
        assert.equal(await record.innerText(), "Approved on its card in chat · revision 4");
      }
      await page.screenshot({ path: join(artifacts, `plan-settled-${label}.png`), fullPage: false });
      // A reload does not bring the settled card back.
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator(".main").getByText("Plan the release answer.", { exact: true }).waitFor();
      await page.waitForTimeout(500);
      assert.equal(await page.locator(".chat-plans").count(), 0, `plan-${label}: a reload keeps it gone`);
      await context.close();
    }

    // ── d59f830a: a Claude auto-mode card, allowed exactly once.
    {
      calls.length = 0;
      snapshot = { runs: [], tasks: [], attempts: [], gates: [], messages: [], notifications: [] };
      pendingCards = [{
        id: "card-1", chatKey: "chat:head-live", kind: "high-risk-action", provider: "claude",
        title: "Claude's auto mode blocked an action", summary: "Production Deploy",
        detail: "Permission for this action was denied by the Claude Code auto mode classifier.\n\nTool call: toolu_1",
        action: "eas update --branch production", exactGrant: "Bash(eas update --branch production)",
      }];
      const { page, context } = await open(width, height, "#/p/general/c/head-live");
      await page.locator(".main").getByText("Plan the release answer.", { exact: true }).waitFor();
      const card = page.getByRole("alert", { name: "Claude's auto mode blocked an action" });
      await card.waitFor();
      assert.match(await card.innerText(), /eas update --branch production/);
      assert.equal(await card.getByRole("button", { name: "Always allow in this project" }).count(), 0);
      assert.equal(await noHorizontalScroll(page), true, `claude-card-${label}: no sideways scroll`);
      await page.screenshot({ path: join(artifacts, `claude-card-${label}.png`), fullPage: false });
      await card.getByRole("button", { name: "Allow this exact command once" }).click();
      await card.waitFor({ state: "detached" });
      const granted = calls.find((call) => call.cmd === "safety_block_grant_exact");
      assert.equal(granted?.args?.id, "card-1");
      await page.waitForFunction(() => true);
      const told = () => calls.find((call) => ["chat_send", "chat_start"].includes(call.cmd)
        && JSON.stringify(call.args).includes("I allowed exactly this command once"));
      for (let i = 0; i < 50 && !told(); i++) await page.waitForTimeout(100);
      assert(told(), `claude-card-${label}: the agent is told the exact grant`);
      await context.close();
      pendingCards = [];
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, mockedBackend: true, artifacts }));
} catch (error) {
  const page = browser?.contexts().at(-1)?.pages()[0];
  await page?.screenshot({ path: join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ error: String(error), errors, artifacts }));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
}
