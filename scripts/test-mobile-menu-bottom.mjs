// App-shell regression for feedback ef1adcd3 at 375px: once the phone Chats
// menu has been scrolled away, reaching the end of the list must not bring it
// back. At the end the list moves up by itself — Safari's toolbar collapses
// and the list's box grows, a row leaves — and that is not upward intent. A
// real upward scroll away from the end, or the top, still brings it back.
// The socket is mocked; everything else is the real App.
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const artifacts = process.env.OCTIQ_EVIDENCE_DIR || await mkdtemp(join(tmpdir(), "octiq-menu-bottom-"));
await mkdir(artifacts, { recursive: true });

const now = Date.now();
const chats = Array.from({ length: 40 }, (_, i) => ({
  id: `chat-${i}`, projectId: "general", title: `Conversation ${i + 1}`, customTitle: true, modelId: "claude:opus",
  access: "auto", sessionId: `session-${i}`, createdAt: now - 1_000_000 + i, updatedAt: now - 1_000 * i,
}));

function resultFor(request) {
  switch (request.cmd) {
    case "list_workspaces": return [{ id: "general", name: "General", primary_path: "/Users/kyson/General" }];
    case "chat_index_list": return chats;
    case "chat_index_deleted": return [];
    case "chat_page": return { events: [], context: [], before: null };
    case "chat_list": case "chat_activity": case "permission_pending": case "question_pending":
    case "safety_block_pending": case "team_list": case "team_leads": case "pr_repositories": case "codex_skills":
      return [];
    case "chat_queue_state": return { live: false, queuedTurnIds: [] };
    case "orchestration_snapshot": return { runs: [], tasks: [], attempts: [], gates: [], messages: [], notifications: [] };
    case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
    case "usage_summary": return {};
    case "agent_installs": return [{ id: "claude", installed: true, path: "/mock/claude" }];
    case "pr_local_list": case "pr_remote_list": return { items: [], warnings: [] };
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
const errors = [];
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
  const context = await browser.newContext({ viewport: { width: 375, height: 700 }, reducedMotion: "reduce", hasTouch: true, isMobile: true });
  await context.route("**/token", (route) => route.fulfill({ body: "mock-token" }));
  await context.route("**/auth", (route) => route.fulfill({ body: "ok" }));
  await context.routeWebSocket(/.*/, (socket) => socket.onMessage((raw) => {
    const request = JSON.parse(String(raw));
    if (request.t === "invoke") socket.send(JSON.stringify({ t: "reply", id: request.id, ok: true, result: resultFor(request) }));
  }));
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) => errors.push(error.stack ?? String(error)));
  await page.goto(base, { waitUntil: "domcontentloaded" });
  const show = page.getByRole("button", { name: "Show chats", exact: true });
  if (await show.isVisible().catch(() => false)) await show.click();
  const scroller = page.locator(".task-sidebar .task-chat-scroll");
  await page.locator(".task-chat-list .chat").nth(39).waitFor({ state: "attached" });
  const menu = page.locator("#chats-navigation");
  const state = () => menu.evaluate((el) => ({
    floating: el.classList.contains("is-floating"), hidden: el.classList.contains("is-hidden"),
  }));
  // Scroll like a finger does: many small steps, each its own scroll event.
  const scrollTo = async (target) => {
    const from = await scroller.evaluate((el) => el.scrollTop);
    const steps = Math.max(1, Math.ceil(Math.abs(target - from) / 40));
    for (let i = 1; i <= steps; i += 1) {
      await scroller.evaluate((el, top) => { el.scrollTop = top; }, from + ((target - from) * i) / steps);
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(60);
  };
  const end = () => scroller.evaluate((el) => el.scrollHeight - el.clientHeight);
  // React settles the class a frame or two after the last scroll event.
  const settled = async (expected, message) => {
    let got;
    for (let i = 0; i < 20; i += 1) {
      got = await state();
      if (got.floating === expected.floating && got.hidden === expected.hidden) return;
      await page.waitForTimeout(50);
    }
    const top = await scroller.evaluate((el) => el.scrollTop);
    assert.deepEqual(got, expected, `${message} (scrollTop ${top})`);
  };

  await scrollTo(await end());
  await settled({ floating: true, hidden: true }, "scrolled down to the end: the menu is away");
  await page.screenshot({ path: join(artifacts, "bottom-hidden.png") });

  // The list's range shrinks under the finger — here the last row leaves;
  // on an iPhone, Safari's toolbar collapsing does the same — and the
  // browser pulls scrollTop up to the new end. (Headless Chromium does not
  // resize this scroller with the viewport, so the row stands in for it.)
  const before = await scroller.evaluate((el) => el.scrollTop);
  await page.locator(".task-chat-list .chat").nth(39).evaluate((row) => { row.style.display = "none"; });
  // Long enough for a reveal to have landed if one was coming.
  await page.waitForTimeout(400);
  const after = await scroller.evaluate((el) => el.scrollTop);
  assert(after < before - 20, `the browser pulled the list up (${before} -> ${after})`);
  assert.deepEqual(await state(), { floating: true, hidden: true }, "settling at the end does not bring the menu back");
  await page.screenshot({ path: join(artifacts, "bottom-after-settle.png") });

  // A real upward scroll away from the end still brings it back.
  await scrollTo(after - 120);
  await settled({ floating: true, hidden: false }, "an upward scroll brings the menu back");
  await page.screenshot({ path: join(artifacts, "upward-revealed.png") });
  await scrollTo(0);
  await settled({ floating: false, hidden: false }, "the top shows it in place");
  assert.deepEqual(errors, []);
  console.log(`mobile menu bottom: PASS (${artifacts})`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
}
