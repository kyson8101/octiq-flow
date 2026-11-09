// Real App regression: sidebar changes must reach Settings, and a full or
// blocked localStorage must not freeze the palette, switch or scheme history.
// Only the backend socket is mocked. No model calls or production builds.
// PLAYWRIGHT_MODULE / PLAYWRIGHT_CHANNEL / PLAYWRIGHT_EXECUTABLE_PATH choose
// the browser; OCTIQ_EVIDENCE_DIR chooses the screenshot/report folder.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const webRoot = resolve(fileURLToPath(new URL("../web", import.meta.url)));
const require = createRequire(join(webRoot, "package.json"));
const moduleUrl = spec => isAbsolute(spec) || spec.startsWith(".") ? pathToFileURL(resolve(spec)).href : spec;
const { createServer } = await import(moduleUrl(require.resolve("vite")));
const { chromium } = await import(moduleUrl(process.env.PLAYWRIGHT_MODULE || "playwright"));
const artifacts = process.env.OCTIQ_EVIDENCE_DIR || await mkdtemp(join(tmpdir(), "octiq-toggle-"));
await mkdir(artifacts, { recursive: true });
const now = Date.now();
const main = {
  id: "main", projectId: "octiq", title: "Review the sidebar", customTitle: true,
  modelId: "claude:opus", access: "auto", effort: "high", sessionId: "session-main",
  cwd: webRoot, createdAt: now - 500_000, updatedAt: now - 1_000,
};
const chats = [main, ...Array.from({ length: 80 }, (_, i) => ({
  ...main, id: `review-${i}`, sessionId: `session-review-${i}`, title: `Review ${i}`, updatedAt: now - 10_000 - i * 1_000,
}))];
function resultFor(request) {
  switch (request.cmd) {
    case "list_workspaces": return [{ id: "octiq", name: "octiq-flow", primary_path: webRoot }];
    case "chat_index_list": return chats;
    case "chat_page": return { events: [], context: [], before: null };
    case "provider_fallback_choices": case "chat_index_deleted": case "chat_since":
    case "permission_pending": case "question_pending": case "chat_list": case "chat_activity":
    case "safety_block_pending": case "access_request_pending": case "pr_repositories":
    case "codex_skills": case "team_list": case "team_leads": return [];
    case "chat_queue_state": return { live: false, queuedTurnIds: [] };
    case "orchestration_snapshot": return { runs: [], tasks: [], attempts: [], gates: [], messages: [], notifications: [] };
    case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
    case "usage_summary": return {};
    case "agent_models": return { source: "mock", models: [] };
    case "agent_installs": return [{ id: "claude", installed: true, path: "/mock/claude" }];
    case "pr_local_list": case "pr_remote_list": return { items: [], warnings: [] };
    case "git_status_summary": return [{ path: webRoot, repo_root: webRoot, is_repo: true, branch: "develop", changed: 0, ahead: 0, behind: 0 }];
    case "git_local_branches": return { is_repo: true, current: "develop", branches: ["develop"], is_worktree: false };
    case "chat_task": return { chatId: request.args?.chatId, projectId: "octiq" };
    default: return null;
  }
}

const server = await createServer({ root: webRoot, configFile: join(webRoot, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, strictPort: false, fs: { strict: false } },
});
const report = { errors: [], scenes: [] };
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
  });
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 600 }, reducedMotion: "reduce" });
    await context.addInitScript(() => {
      localStorage.setItem("octiq.theme", "dark");
      localStorage.setItem("octiq.agentsMode", "off");
      localStorage.setItem("octiq.v2.gitColumn", "0");
    });
    await context.route("**/token", r => r.fulfill({ body: "mock-token" }));
    await context.route("**/auth", r => r.fulfill({ body: "ok" }));
    let appSocket;
    await context.routeWebSocket(/.*/, socket => socket.onMessage(raw => {
      const r = JSON.parse(String(raw));
      if (r.t === "invoke") {
        appSocket = socket;
        socket.send(JSON.stringify({ t: "reply", id: r.id, ok: true, result: resultFor(r) }));
      }
    }));
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on("pageerror", e => report.errors.push(String(e.stack)));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/#/p/octiq-flow/c/main`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator(".composer-row").first().waitFor();
    // Refresh after App has subscribed; the deep-link fixture can read the
    // initial index before its ordinary sidebar subscriber has mounted.
    appSocket.send(JSON.stringify({ t: "event", event: "chat-index-changed", payload: { id: main.id, gone: false } }));
    await page.waitForFunction(count => document.querySelectorAll(".task-chat-list > .chat-row").length === count, chats.length);
    const toggle = page.getByRole("switch", { name: "Dark mode" });
    const showSidebar = async () => {
      if (!await toggle.isVisible()) await page.getByRole("button", { name: "Show chats", exact: true }).first().click();
    };
    const assertTheme = async (id, scheme, checked) => {
      try {
        await page.waitForFunction(({ id, scheme, checked }) =>
          document.documentElement.dataset.colorScheme === scheme
          && document.querySelectorAll('.thm[data-theme-id][aria-checked="true"]').length === 1
          && document.querySelector('.thm[data-theme-id][aria-checked="true"]')?.dataset.themeId === id
          && document.querySelector('.appearance-toggle')?.getAttribute("aria-checked") === String(checked),
        { id, scheme, checked });
      } catch (error) {
        report.actual = await page.evaluate(() => ({
          scheme: document.documentElement.dataset.colorScheme,
          selected: [...document.querySelectorAll('.thm[data-theme-id][aria-checked="true"]')].map(el => el.dataset.themeId),
          switches: [...document.querySelectorAll('.appearance-toggle')].map(el => el.getAttribute("aria-checked")),
        }));
        await page.screenshot({ path: join(artifacts, `failure-${width}.png`) });
        throw error;
      }
      assert.equal(await page.locator('.thm[data-theme-id][aria-checked="true"]').count(), 1);
    };
    // M1: a real sidebar press while Settings is unmounted, then open it.
    await showSidebar();
    await toggle.click();
    await page.locator(".sidebar-place", { hasText: /^Settings$/ }).click();
    await page.getByRole("button", { name: /Appearance/ }).first().click();
    await assertTheme("light", "light", false);
    await page.screenshot({ path: join(artifacts, `settings-after-toggle-${width}.png`) });
    // Keep Settings mounted while the sidebar changes its selected tile.
    await showSidebar();
    await toggle.click();
    await assertTheme("dark", "dark", true);
    if (width === 390) await page.locator(".sidebar-place", { hasText: /^Settings$/ }).click();
    await page.locator('.thm[data-theme-id="guofeng"]').click();
    await assertTheme("guofeng", "dark", true);
    await page.locator('.thm[data-theme-id="manga"]').click();
    await assertTheme("manga", "light", false);
    await page.locator('.thm[data-theme-id="dark"]').click();
    await assertTheme("dark", "dark", true);

    // M2: persisted Dark stays stale; live palette and both controls still
    // round-trip to the last light choice, even when every write throws.
    await page.evaluate(() => {
      Storage.prototype.setItem = () => { throw new DOMException("Full", "QuotaExceededError"); };
    });
    await showSidebar();
    await toggle.click();
    await assertTheme("manga", "light", false);
    await toggle.click();
    await assertTheme("dark", "dark", true);
    assert.equal(await page.evaluate(() => localStorage.getItem("octiq.theme")), "dark");
    // A fresh last-used choice survives in memory too, with reads blocked.
    if (width === 390) await page.locator(".sidebar-place", { hasText: /^Settings$/ }).click();
    await page.evaluate(() => {
      Storage.prototype.getItem = () => { throw new DOMException("Blocked", "SecurityError"); };
    });
    await page.locator('.thm[data-theme-id="xp"]').click();
    await assertTheme("xp", "light", false);
    await showSidebar();
    await toggle.click();
    await assertTheme("dark", "dark", true);
    await toggle.click();
    await assertTheme("xp", "light", false);
    let layout = null;
    if (width === 1280) {
      layout = await page.evaluate(() => {
        const footer = document.querySelector(".sidebar-settings").getBoundingClientRect();
        const scroller = document.querySelector(".task-chat-content");
        scroller.scrollTop = scroller.scrollHeight;
        const rows = [...scroller.querySelectorAll(".chat-row")];
        return { footerTop: footer.top, footerHeight: footer.height, scrollerBottom: scroller.getBoundingClientRect().bottom,
          rows: rows.length, lastRowBottom: rows.at(-1).getBoundingClientRect().bottom };
      });
      assert.equal(layout.rows, chats.length);
      assert.ok(layout.scrollerBottom <= layout.footerTop, JSON.stringify(layout));
      assert.ok(layout.lastRowBottom <= layout.footerTop, JSON.stringify(layout));
    }
    report.scenes.push({ width, outsideSettings: "pass", quotaRoundTrip: "pass", blockedStorageHistory: "pass", layout });
    await context.close();
  }
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.failure = String(error.stack);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
  await writeFile(join(artifacts, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ artifacts, ...report }, null, 2));
}
