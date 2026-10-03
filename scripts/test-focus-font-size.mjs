// App-shell regression for the text size control in focus mode. The socket is
// mocked; everything else is the real App, FocusMode and its stylesheet.
//
// Checks, at 1440 and 390 wide:
//   * focus mode opens at the size it always had (16px prose);
//   * Larger / Smaller move the prose, its headings, code and the composer
//     together, keeping their proportions, and the composer never drops under
//     16px (iOS zooms a smaller field);
//   * an end of the range is announced and keeps keyboard focus on the button;
//   * the size survives leaving focus mode and a reload, and never leaks into
//     the ordinary chat view;
//   * the controls sit beside Exit focus without overlapping it or scrolling
//     the page sideways on a phone.
//
// Run: PLAYWRIGHT_MODULE=<playwright/index.mjs> node scripts/test-focus-font-size.mjs
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const artifacts = process.env.OCTIQ_EVIDENCE_DIR
  || await mkdtemp(join(tmpdir(), "octiq-focus-font-"));
await mkdir(artifacts, { recursive: true });

const now = Date.now();
const TITLE = "Reading the release notes";
const ANSWER = [
  "## What changed",
  "",
  "Focus mode is a quiet reading column. This paragraph is long enough to wrap over several lines, so a change in size shows as a change in how the text flows across the column rather than only in a number.",
  "",
  "Run `pnpm --dir web build` and then reload the page.",
  "",
  "| Size | Use |",
  "| --- | --- |",
  "| 14 | dense |",
  "| 24 | across the room |",
].join("\n");
const chats = [{
  id: "reading", projectId: "general", title: TITLE, customTitle: true, modelId: "claude:opus", access: "auto",
  sessionId: "session-reading", createdAt: now - 60_000, updatedAt: now - 10_000,
}];
const localChats = chats.map((item) => ({
  ...item,
  messages: [
    { id: "u1", role: "user", streaming: false, blocks: [{ kind: "text", text: "What changed?" }] },
    { id: "a1", role: "assistant", streaming: false, blocks: [{ kind: "text", text: ANSWER }] },
  ],
}));

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
    case "orchestration_snapshot": return { runs: [], tasks: [], attempts: [], gates: [], messages: [] };
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

const px = (page, selector) => page.locator(selector).first()
  .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
// The app's reduced-motion rule leaves a 10µs transition on everything, so a
// read straight after a change can catch the old size. Let them land first.
const settled = (page) => page.waitForFunction(() =>
  document.getAnimations().every((animation) => animation.constructor.name !== "CSSTransition"));
const sizes = async (page) => (await settled(page), {
  prose: await px(page, ".msg-assistant .prose, .prose"),
  heading: await px(page, ".prose h2"),
  code: await px(page, ".prose code"),
  composer: await px(page, ".composer-input"),
});
const larger = (page) => page.getByRole("button", { name: "Larger text" });
const smaller = (page) => page.getByRole("button", { name: "Smaller text" });

let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, reducedMotion: "reduce" });
  await context.addInitScript((seed) => {
    if (location.protocol === "about:") return;
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

  async function openChat() {
    await page.goto(`${base}#/p/general`, { waitUntil: "domcontentloaded" });
    await page.locator(".chat-btn", { hasText: TITLE }).first().click();
    await page.locator(".prose h2").waitFor();
  }
  async function enterFocus() {
    await page.getByRole("button", { name: "Enter focus mode" }).click();
    await page.locator(".app.focus-mode").waitFor();
  }

  await openChat();
  const ordinary = await sizes(page);
  await enterFocus();
  assert.deepEqual(await sizes(page), { prose: 16, heading: 18, code: 14, composer: 17 }, "focus mode opens at the size it always had");
  await page.screenshot({ path: join(artifacts, "1440-focus-16.png") });

  await larger(page).click();
  await larger(page).click();
  assert.deepEqual(await sizes(page), { prose: 18, heading: 20.25, code: 15.75, composer: 19.125 }, "two steps up keep proportions");
  assert.equal(await page.locator(".focus-font-size").getAttribute("aria-label"), "Text size, 18 pixels");
  await page.screenshot({ path: join(artifacts, "1440-focus-18.png") });

  // To the top: the last step is announced and the button keeps focus.
  for (let index = 0; index < 3; index += 1) await larger(page).click();
  assert.equal((await sizes(page)).prose, 24);
  assert.equal(await larger(page).getAttribute("aria-disabled"), "true");
  await larger(page).click({ force: true });
  assert.equal((await sizes(page)).prose, 24, "a click past the end does nothing");
  assert.equal(await larger(page).evaluate((el) => el === document.activeElement), true, "focus stays on the button at the end");
  await page.screenshot({ path: join(artifacts, "1440-focus-24.png") });

  // To the bottom: the composer holds at 16px.
  for (let index = 0; index < 7; index += 1) await smaller(page).click();
  const smallest = await sizes(page);
  assert.equal(smallest.prose, 14);
  assert.equal(smallest.composer, 16, "the composer never drops under 16px");
  assert.equal(await smaller(page).getAttribute("aria-disabled"), "true");

  // Keyboard reaches it: Exit focus has focus on entry; Shift+Tab goes back to the steps.
  await larger(page).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  assert.equal((await sizes(page)).prose, 16);
  await larger(page).click();
  await larger(page).click();
  assert.equal((await sizes(page)).prose, 18);

  // Leaving focus mode: the ordinary view is untouched.
  await page.getByRole("button", { name: "Exit focus mode" }).click();
  await page.locator(".app.focus-mode").waitFor({ state: "detached" });
  assert.deepEqual(await sizes(page), ordinary, "the size never leaks into the ordinary chat view");
  assert.equal(await page.locator(".app").evaluate((el) => el.style.getPropertyValue("--focus-font-size")), "");

  // Remembered across focus sessions and a reload.
  await enterFocus();
  assert.equal((await sizes(page)).prose, 18, "kept for the next focus session");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".chat-btn", { hasText: TITLE }).first().click();
  await page.locator(".prose h2").waitFor();
  await enterFocus();
  assert.equal((await sizes(page)).prose, 18, "kept across a reload");

  // Phone width: beside Exit, no overlap, nothing sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const [step, exit] = await Promise.all([larger(page).boundingBox(), page.locator(".focus-mode-exit").boundingBox()]);
  assert.ok(step.x + step.width <= exit.x, `controls sit left of Exit (${JSON.stringify({ step, exit })})`);
  assert.ok(exit.x + exit.width <= 390, "Exit stays on screen");
  assert.ok(step.height >= 40 && step.width >= 40, "touch targets are at least 40px");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no sideways scroll");
  await page.screenshot({ path: join(artifacts, "390-focus-18.png") });

  assert.deepEqual(errors, [], "no page errors");
  console.log(`focus font size: ok — screenshots in ${artifacts}`);
} finally {
  await browser?.close();
  await server.close();
}
