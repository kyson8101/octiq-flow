// App-shell regression for putting the Tasks column away beside an
// orchestrated chat. The socket is mocked, but every frame goes through
// App.tsx and the tab's one orchestration feed.
//
// At 1181px and up a chat with a run splits into Tasks | Chat, and that split
// used to be permanent. This checks:
//   * the top bar's Tasks button hides the column and the chat takes the room;
//   * a plan waiting for approval rides on the button while the column is away,
//     and only then;
//   * the choice is one flag for every chat in the browser, and survives a
//     reload;
//   * below the split the button is not drawn and the Tasks/Chat tabs still
//     work whatever the flag says;
//   * nothing scrolls sideways, and the page raises no errors.
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const artifacts = process.env.OCTIQ_EVIDENCE_DIR
  || await mkdtemp(join(tmpdir(), "octiq-task-column-"));
await mkdir(artifacts, { recursive: true });

const now = Date.now();
const chat = (id, title, over = {}) => ({
  id, projectId: "general", title, customTitle: true, modelId: "claude:opus", access: "auto",
  sessionId: `session-${id}`, createdAt: now - 60_000, updatedAt: now - 50_000, ...over,
});
const chats = [
  chat("lead-plan", "Plan waiting for approval", { updatedAt: now - 10_000 }),
  chat("lead-run", "Run already going", { updatedAt: now - 20_000 }),
];
const localChats = chats.map((item) => ({
  ...item,
  messages: [{ id: `m-${item.id}`, role: "assistant", streaming: false, blocks: [{ kind: "text", text: `${item.title} answer.` }] }],
}));
const run = (id, lead, planApproval) => ({
  id, coordinatorChatKey: `chat:${lead}`, objective: `${id} objective`, workspaceId: "general", rootPath: "/General",
  status: "running", maxConcurrent: 2, createdAt: now - 45_000, updatedAt: now - 20_000, planApproval,
});
const task = (id, runId, status) => ({
  id, runId, title: id, spec: "", dependsOn: [], status, createdAt: now - 40_000, updatedAt: now - 20_000,
});
const snapshot = {
  runs: [
    run("r-plan", "lead-plan", { status: "pending", requestedAt: now - 30_000 }),
    run("r-run", "lead-run", { status: "approved", requestedAt: now - 44_000, decidedAt: now - 43_000 }),
  ],
  tasks: [task("draft", "r-plan", "pending"), task("review", "r-plan", "pending"), task("build", "r-run", "running")],
  attempts: [], gates: [], messages: [],
};

const errors = [];
const server = await createServer({
  root: new URL("../web", import.meta.url).pathname,
  configFile: new URL("../web/vite.config.ts", import.meta.url).pathname,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

function resultFor(request) {
  switch (request.cmd) {
    case "list_workspaces": return [{ id: "general", name: "General", primary_path: "/General" }];
    case "chat_index_list": return chats;
    case "chat_index_deleted": return [];
    case "chat_page": return { events: [], context: [], before: null };
    case "chat_list": return [];
    case "chat_activity": return [];
    case "chat_queue_state": return { live: false, queuedTurnIds: [] };
    case "orchestration_snapshot": return snapshot;
    case "sandbox_snapshot": return { defaultEnabled: false, environments: {} };
    case "permission_pending": return [];
    case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
    case "usage_summary": return {};
    case "agent_installs": return [{ id: "claude", installed: true, path: "/mock/claude" }];
    case "chat_task": return { chatId: request.args?.chatId, projectId: "general" };
    case "codex_skills": return [];
    default: return null;
  }
}

const row = (page, title) => page.locator(".sidebar .chat").filter({ has: page.locator(".chat-title", { hasText: title }) });
const toggle = (page) => page.locator("button.tasks-toggle");
const runSurface = (page) => page.locator(".workflow-run-surface");
const chatSurface = (page) => page.locator(".workflow-chat-surface");
const flag = (page) => page.evaluate(() => localStorage.getItem("octiq.v2.tasksShut"));
const noSidewaysScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
async function waitFor(page, check, what) {
  for (let index = 0; index < 100; index += 1) {
    if (await check()) return;
    await page.waitForTimeout(50);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  const base = `http://127.0.0.1:${server.httpServer.address().port}/`;

  async function newContext(viewport) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
    await context.addInitScript((seed) => {
      if (location.protocol === "about:") return;
      // Seeded once per context, so a reload keeps what the page wrote.
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("octiq.v2.gitColumn", "0");
      localStorage.setItem("octiq.theme", "dark");
      localStorage.setItem("octiq.v2.conversations", JSON.stringify(seed));
    }, localChats);
    await context.route("**/token", (route) => route.fulfill({ body: "mock-token" }));
    await context.route("**/auth", (route) => route.fulfill({ body: "ok" }));
    await context.routeWebSocket(/.*/, (socket) => {
      socket.onMessage((raw) => {
        const request = JSON.parse(String(raw));
        if (request.t !== "invoke") return;
        socket.send(JSON.stringify({ t: "reply", id: request.id, ok: true, result: resultFor(request) }));
      });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on("pageerror", (error) => errors.push(error.stack ?? String(error)));
    return { context, page };
  }
  async function openChat(page, title) {
    await row(page, title).waitFor();
    await row(page, title).locator(".chat-btn").click();
    await waitFor(page, async () => await runSurface(page).count() > 0, `the run surface for ${title}`);
  }

  // ── Desktop: Tasks | Chat, then the chat alone.
  {
    const { context, page } = await newContext({ width: 1440, height: 900 });
    await page.goto(`${base}#/p/general`, { waitUntil: "domcontentloaded" });
    await openChat(page, "Plan waiting for approval");
    await toggle(page).waitFor();
    assert.equal(await page.locator(".workflow-surfaces.is-split").count(), 1, "wide enough to split");
    assert.equal(await runSurface(page).isVisible(), true, "the Tasks column starts on screen");
    assert.equal(await toggle(page).getAttribute("aria-expanded"), "true");
    assert.equal(await toggle(page).getAttribute("aria-label"), "Hide the task column — 2 tasks");
    assert.equal(await page.locator(".tasks-toggle-owed").count(), 0, "nothing rides on the button while the column shows");
    const split = await chatSurface(page).boundingBox();
    await page.screenshot({ path: join(artifacts, "desktop-1440-shown.png") });

    await toggle(page).click();
    await waitFor(page, async () => !(await runSurface(page).isVisible()), "the column to go");
    assert.equal(await page.locator(".workflow-surfaces.is-split").count(), 0, "no split while the column is away");
    assert.equal(await toggle(page).getAttribute("aria-expanded"), "false");
    assert.equal(await toggle(page).getAttribute("aria-label"),
      "Show the task column — 2 tasks, 1 waiting for you");
    assert.equal(await page.locator(".tasks-toggle-owed").innerText(), "1", "the plan waiting rides on the button");
    // styles.css sizes every .icon-btn to a square; the reminder must not
    // squeeze the icon down to a sliver to make room.
    const fits = await toggle(page).evaluate((el) => {
      const box = el.getBoundingClientRect();
      const inside = [...el.children].every((child) => getComputedStyle(child).display === "none"
        || (child.getBoundingClientRect().left >= box.left && child.getBoundingClientRect().right <= box.right));
      return { inside, icon: el.querySelector("svg").getBoundingClientRect().width };
    });
    assert.equal(fits.inside, true, "the count and the reminder fit inside the button");
    assert.ok(fits.icon >= 14, `the icon keeps its size (${fits.icon}px)`);
    const alone = await chatSurface(page).boundingBox();
    assert.ok(alone.width > split.width + 300, `the chat takes the room (${split.width} → ${alone.width})`);
    // Tabs stay away: the button is the way back.
    assert.equal(await page.locator('[aria-label="Conversation view"]').count(), 0);
    assert.equal(await flag(page), "1");
    assert.equal(await noSidewaysScroll(page), true);
    await page.screenshot({ path: join(artifacts, "desktop-1440-hidden.png") });

    // One flag for every chat: the other run's chat opens without its column.
    await openChat(page, "Run already going");
    await waitFor(page, async () => (await toggle(page).getAttribute("aria-label")) === "Show the task column — 1 task",
      "the other chat's button");
    assert.equal(await runSurface(page).isVisible(), false, "the choice is not per chat");
    assert.equal(await page.locator(".tasks-toggle-owed").count(), 0, "nothing waits in this run");

    // And it survives a reload.
    await page.reload({ waitUntil: "domcontentloaded" });
    await openChat(page, "Plan waiting for approval");
    await toggle(page).waitFor();
    assert.equal(await runSurface(page).isVisible(), false, "still away after a reload");

    await toggle(page).click();
    await waitFor(page, () => runSurface(page).isVisible(), "the column to come back");
    assert.equal(await page.locator(".workflow-surfaces.is-split").count(), 1);
    assert.equal(await page.locator(".workflow-run-resizer").count(), 1, "the column can be dragged again");
    assert.equal(await flag(page), "0");
    assert.equal(await noSidewaysScroll(page), true);
    await context.close();
  }

  // ── Below the split: tabs, no button, and the flag changes nothing.
  {
    const { context, page } = await newContext({ width: 1024, height: 800 });
    await page.goto(`${base}#/p/general`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => localStorage.setItem("octiq.v2.tasksShut", "1"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await openChat(page, "Plan waiting for approval");
    const tasksTab = page.locator('[aria-label="Conversation view"] button', { hasText: "Tasks" });
    await tasksTab.waitFor();
    assert.equal(await toggle(page).count(), 0, "no Tasks button where the tabs take turns");
    await tasksTab.click();
    await waitFor(page, () => runSurface(page).isVisible(), "the Tasks tab to show the tasks");
    assert.equal(await chatSurface(page).isVisible(), false);
    assert.equal(await noSidewaysScroll(page), true);
    await page.screenshot({ path: join(artifacts, "tablet-1024-tasks-tab.png") });
    await context.close();
  }

  assert.deepEqual(errors, []);
  console.log(`task column toggle: ok — evidence in ${artifacts}`);
} finally {
  await browser?.close();
  await server.close();
}
