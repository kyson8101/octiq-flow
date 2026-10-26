// Real App + CSS, fixture socket only. No host scan, script execution or web/dist build.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs PLAYWRIGHT_CHANNEL=chrome node scripts/test-disk-report.mjs
import assert from "node:assert/strict";
import { readFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const webRoot = resolve(fileURLToPath(new URL("../web", import.meta.url)));
const require = createRequire(join(webRoot, "package.json"));
const { createServer } = await import(pathToFileURL(require.resolve("vite")).href);
const pw = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = await import(isAbsolute(pw) ? pathToFileURL(pw).href : pw);
const evidence = process.env.OCTIQ_EVIDENCE_DIR || await mkdtemp(join(tmpdir(), "octiq-disk-"));
await mkdir(evidence, { recursive: true });
const fixture = JSON.parse(await readFile(join(webRoot, "src/lib/__fixtures__/disk-report.json"), "utf8"));
const root = "/fixture/octiq-flow";
const errors = [], screenshots = [], calls = [];
const server = await createServer({ root: webRoot, configFile: join(webRoot, "vite.config.ts"), server: { host: "127.0.0.1", port: 0, strictPort: false } });
let browser;

function resultFor(cmd) {
  switch (cmd) {
    case "list_workspaces": return [{ id: "octiq", name: "octiq-flow", primary_path: root }];
    case "chat_index_list": case "chat_index_deleted": case "chat_since": case "permission_pending": case "question_pending":
    case "chat_list": case "chat_activity": case "safety_block_pending": case "access_request_pending": case "pr_repositories":
    case "codex_skills": case "team_list": case "team_leads": return [];
    case "chat_page": return { events: [], context: [], before: null };
    case "chat_queue_state": return { live: false, queuedTurnIds: [] };
    case "orchestration_snapshot": return { runs: [], tasks: [], attempts: [], gates: [], messages: [], notifications: [] };
    case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
    case "usage_summary": return {};
    case "agent_models": return { source: "mock", models: [] };
    case "agent_installs": return [];
    case "pr_local_list": case "pr_remote_list": return { items: [], warnings: [] };
    case "git_status_summary": return [];
    default: return null;
  }
}
async function open(theme, width) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce", acceptDownloads: true });
  await context.addInitScript(mode => {
    localStorage.clear();
    localStorage.setItem("octiq.theme", mode);
    localStorage.setItem("octiq.web.token", "fixture");
    localStorage.setItem("octiq.v2.gitColumn", "0");
    localStorage.setItem("octiq.v2.navShut", "0");
  }, theme);
  let currentReport = structuredClone(fixture), running = null, unavailable = false, scanNumber = 0;
  let sendEvent;
  const localCalls = [];
  await context.route("**/token", route => route.fulfill({ body: "fixture" }));
  await context.route("**/auth", route => route.fulfill({ body: "ok" }));
  await context.routeWebSocket(/\/ws\?token=/, socket => {
    sendEvent = (event, payload) => socket.send(JSON.stringify({ t: "event", event, payload }));
    socket.onMessage(raw => {
      const request = JSON.parse(String(raw));
      if (request.t !== "invoke") return;
      localCalls.push(request); calls.push({ theme, width, cmd: request.cmd, args: request.args });
      let result;
      if (request.cmd.startsWith("disk_") && unavailable) {
        socket.send(JSON.stringify({ t: "reply", id: request.id, ok: false, error: `'${request.cmd}' is not available on this backend — it may be older than the page asking for it` })); return;
      }
      if (request.cmd === "disk_scan_state") result = { running, report: currentReport };
      else if (request.cmd === "disk_scan_start") {
        running = { scanId: `next-scan-${++scanNumber}`, startedAt: Date.now(), phase: "home", entries: 0, bytes: 0 };
        result = { scanId: running.scanId };
      } else if (request.cmd === "disk_scan_cancel") { running = null; result = { cancelled: true }; }
      else if (request.cmd === "disk_cleanup_script") result = { fileName: currentReport.platform === "windows" ? "cleanup-fixture.ps1" : "cleanup-fixture.sh", script: "# Fixture script only\necho 'Nothing deleted'\n" };
      else result = resultFor(request.cmd);
      socket.send(JSON.stringify({ t: "reply", id: request.id, ok: true, result }));
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.on("pageerror", error => errors.push(String(error.stack ?? error)));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`, { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.locator(".sidebar:visible, .topbar-nav:visible").first().waitFor();
  const diskLink = page.getByRole("button", { name: "Disk", exact: true });
  if (!await diskLink.isVisible()) await page.getByRole("button", { name: /Show chats|Show sidebar/i }).first().click();
  await diskLink.click();
  await page.getByRole("region", { name: "Disk report", exact: true }).waitFor();
  await page.getByText("Development leftovers", { exact: true }).waitFor();
  await page.getByRole("article", { name: "pnpm store", exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  return { page, context, localCalls, setUnavailable: () => { unavailable = true; },
    finish: () => { const scanId = running.scanId; currentReport = { ...currentReport, scanId, scannedAt: Date.now() }; running = null; sendEvent("disk-scan-done", { scanId, ok: true }); },
    progress: () => { running = { ...running, phase: "git", entries: 1234, bytes: 450000000 }; sendEvent("disk-scan-progress", running); },
    windows: () => { currentReport = { ...currentReport, platform: "windows" }; sendEvent("disk-scan-done", { scanId: "refresh", ok: true }); } };
}
async function screenshot(page, name) {
  const path = join(evidence, name); await page.screenshot({ path }); screenshots.push(path);
}
async function noOverflow(page) {
  const wide = await page.locator(".disk-page").evaluate(el => el.scrollWidth > el.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth);
  assert.equal(wide, false, "Disk page must not overflow horizontally");
}
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  const themes = process.env.OCTIQ_DISK_THEMES?.split(",") ?? ["dark", "light", "fun", "manga", "guofeng", "xp", "cyberpunk"];
  for (const theme of themes) {
    for (const width of [1280, 390]) {
      const app = await open(theme, width), { page } = app;
      console.log(`Checking ${theme} ${width}`);
      assert.equal(await page.locator(".disk-page input:checked").count(), 0);
      assert.equal(app.localCalls.filter(call => call.cmd === "disk_scan_start").length, 0, "Opening the page must never start a scan");
      const recent = page.getByRole("article", { name: "Recent chat history", exact: true }).getByRole("checkbox");
      assert.equal(await recent.getAttribute("aria-disabled"), "true");
      assert.equal(await recent.getAttribute("disabled"), null, "Unavailable cleanup rows stay in the keyboard order");
      await recent.focus(); await recent.press("Space");
      assert.equal(await recent.isChecked(), false);
      await page.getByRole("checkbox", { name: "Select all Review first" }).check();
      assert.equal(await recent.isChecked(), false);
      await page.getByRole("checkbox", { name: "Select all Review first" }).uncheck();
      await page.locator(".disk-body").evaluate(el => { el.scrollTop = 0; });
      await page.evaluate(() => window.scrollTo(0, 0));
      await noOverflow(page);
      await screenshot(page, `${theme}-${width}-disk.png`);
      const mapPath = join(evidence, `${theme}-${width}-treemap.png`);
      await page.locator(".disk-map-panel").screenshot({ path: mapPath }); screenshots.push(mapPath);
      const pnpm = page.getByRole("article", { name: "pnpm store", exact: true });
      await page.getByRole("button", { name: /pnpm store, 2.4 GB/ }).click();
      assert.equal(await pnpm.evaluate(el => el === document.activeElement), true);
      await pnpm.getByRole("checkbox").check();
      assert.equal(await page.locator(".disk-tile.is-selected").count(), 1);
      await pnpm.getByRole("button", { name: "Show details for pnpm store" }).click();
      await pnpm.locator(".disk-full-path").waitFor({ state: "visible" });
      await page.getByRole("checkbox", { name: "Select all Safe to clean" }).check();
      const download = page.getByRole("button", { name: "Download cleanup script" });
      await download.scrollIntoViewIfNeeded();
      await screenshot(page, `${theme}-${width}-controls.png`);
      const downloaded = page.waitForEvent("download"); await download.click();
      assert.equal((await downloaded).suggestedFilename(), "cleanup-fixture.sh");
      assert.deepEqual(app.localCalls.findLast(call => call.cmd === "disk_cleanup_script").args, { scanId: "fixture-scan", itemIds: ["pnpm", "temp"], allowRm: false });
      await page.getByRole("switch").check();
      const nextDownload = page.waitForEvent("download"); await download.click(); await nextDownload;
      assert.equal(app.localCalls.findLast(call => call.cmd === "disk_cleanup_script").args.allowRm, true);
      if (theme === "dark" && width === 1280) {
        await app.windows(); await page.getByText('powershell -File', { exact: false }).waitFor();
        await page.getByRole("button", { name: "Scan", exact: true }).click();
        await page.getByRole("button", { name: "Cancel scan" }).waitFor();
        app.progress(); await page.getByText("Scanning Git worktrees", { exact: false }).waitFor();
        await screenshot(page, "dark-1280-running.png");
        app.finish(); await page.getByRole("button", { name: "Scan", exact: true }).waitFor();
        await page.waitForFunction(() => document.querySelectorAll('.disk-page input:checked').length === 0);
        assert.equal(await page.locator(".disk-page input:checked").count(), 0, "A new scan clears selections and rm consent");
        await page.getByRole("button", { name: "Scan", exact: true }).click();
        await page.getByRole("button", { name: "Cancel scan" }).click();
        await page.getByRole("button", { name: "Scan", exact: true }).waitFor();
        app.setUnavailable(); await page.getByRole("button", { name: "Scan", exact: true }).click();
        await page.getByRole("alert").filter({ hasText: "not available on this backend" }).waitFor();
        await screenshot(page, "dark-1280-old-backend.png");
      }
      await noOverflow(page);
      await app.context.close();
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(join(evidence, "results.json"), JSON.stringify({ passed: true, mockedBackend: true, screenshots, calls: calls.filter(call => call.cmd.startsWith("disk_")) }, null, 2));
  console.log(JSON.stringify({ passed: true, mockedBackend: true, evidence, screenshots }, null, 2));
} catch (error) {
  for (const context of browser?.contexts() ?? []) for (const page of context.pages()) await page.screenshot({ path: join(evidence, "failure.png") }).catch(() => {});
  console.error({ evidence, errors }); throw error;
} finally { await browser?.close(); await server.close(); }
