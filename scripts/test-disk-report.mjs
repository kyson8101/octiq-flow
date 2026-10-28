// Real App + CSS, fixture socket only. No host scan, script execution or web/dist build.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs PLAYWRIGHT_CHANNEL=chrome node scripts/test-disk-report.mjs
import assert from "node:assert/strict";
import { readFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const webRoot = resolve(process.env.OCTIQ_WEB_ROOT || fileURLToPath(new URL("../web", import.meta.url)));
const require = createRequire(join(webRoot, "package.json"));
const { createServer } = await import(pathToFileURL(require.resolve("vite")).href);
const pw = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = await import(isAbsolute(pw) ? pathToFileURL(pw).href : pw);
const evidence = process.env.OCTIQ_EVIDENCE_DIR || await mkdtemp(join(tmpdir(), "octiq-disk-"));
await mkdir(evidence, { recursive: true });
let fixture = JSON.parse(await readFile(join(webRoot, "src/lib/__fixtures__/disk-report.json"), "utf8"));
const root = "/fixture/octiq-flow";
const errors = [], screenshots = [], calls = [];
const server = await createServer({ root: webRoot, configFile: join(webRoot, "vite.config.ts"), server: { host: "127.0.0.1", port: 0, strictPort: false } });
const crowded = process.env.OCTIQ_DISK_CROWDED === "1" || process.env.REVIEW_REAL === "1";
if (crowded) fixture = (await server.ssrLoadModule("/src/lib/diskReport.fixture.ts")).crowdedDiskReport();
if (process.env.REVIEW_REAL === "1") fixture = (await server.ssrLoadModule("/src/lib/diskReport.fixture.ts")).realShapedDiskReport();
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
    const nativeRect = Element.prototype.getBoundingClientRect;
    window.diskRectReads = 0; window.diskObserverCallbacks = 0;
    Element.prototype.getBoundingClientRect = function (...args) {
      if (this.closest('.disk-map-probes')) window.diskRectReads++;
      return nativeRect.apply(this, args);
    };
    const NativeObserver = window.ResizeObserver;
    window.ResizeObserver = class extends NativeObserver { constructor(cb) { super((entries, obs) => { window.diskObserverCallbacks++; cb(entries, obs); }); } };
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
  await page.getByRole("article", { name: crowded ? "Linked Git worktree" : "pnpm store", exact: true }).first().waitFor();
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
async function checkCrowded(page, theme, width) {
  assert.equal(fixture.items.length, process.env.REVIEW_REAL === "1" ? 153 : 150);
  await page.waitForFunction(() => [...document.querySelectorAll('.disk-tile-content')].some(el => el.dataset.fit === 'full'));
  assert.ok(await page.locator(".disk-tile").count() < 12, "Crowded reports remain a small readable overview");
  await noOverflow(page);
  await assertWholeLines(page);
  await screenshot(page, `${theme}-${width}-crowded-disk.png`);
  const mapPath = join(evidence, `${theme}-${width}-crowded-treemap.png`);
  await page.locator(".disk-map-panel").screenshot({ path: mapPath }); screenshots.push(mapPath);
  const aggregate = page.getByRole("button", { name: /Linked Git worktrees, 70 items,/ });
  await aggregate.focus(); await aggregate.press("Enter");
  assert.equal(await page.locator(".disk-item.is-found").count(), 70);
  assert.equal(await page.locator(".disk-item.is-found").first().evaluate(el => el === document.activeElement), true);
  await page.locator(".disk-item.is-found").first().getByRole("checkbox").check();
  assert.match(await aggregate.getAttribute("aria-label"), /1 ticked/);
  await aggregate.focus();
  await page.locator(".disk-tile.is-work").hover(); // keyboard focus owns the inspector across incidental hover
  await page.locator(".disk-map-inspector").filter({ hasText: "1 ticked" }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.disk-tile.is-selected .disk-tile-visible-size')].some(el => el.textContent.includes('1 ticked')));
  await assertWholeLines(page);
  const other = page.getByRole("button", { name: /^Other, \d+ items,.*Find in Review first/ });
  const otherCount = Number((await other.getAttribute('aria-label')).match(/Other, (\d+) items/)[1]);
  await other.click();
  assert.equal(await page.locator(".disk-item.is-found").count(), otherCount);
  await page.locator(".disk-item.is-found").first().getByRole("checkbox").check();
  assert.match(await other.getAttribute('aria-label'), /1 ticked/);
  await other.focus();
  await workHover(page); // summary focus also owns the inspector
  await page.locator(".disk-map-inspector").filter({ hasText: `Other, ${otherCount} items` }).waitFor();
  await page.getByRole("button", { name: "Clear highlight" }).click();
  assert.equal(await page.locator(".disk-item.is-found").count(), 0);
  await page.locator(".disk-map-ticked").filter({ hasText: "Other · 1 ticked" }).waitFor();
  assert.equal(await page.locator(".disk-tile.is-work button, button.disk-tile.is-work").count(), 0);
  const work = page.locator(".disk-tile.is-work"); await work.focus();
  assert.match(await work.getAttribute("aria-label"), /38 items.*Your work is labelled only/);
  assert.equal(await page.locator(".disk-page input:checked").count(), 2);
  await page.locator(".disk-map-panel").scrollIntoViewIfNeeded();
  const selectedPath = join(evidence, `${theme}-${width}-crowded-ticked.png`);
  await page.locator(".disk-map-panel").screenshot({ path: selectedPath }); screenshots.push(selectedPath);
  await noOverflow(page);
  // Inspector changes must not measure text or cause a ResizeObserver loop.
  const before = await page.evaluate(() => ({ reads: window.diskRectReads, callbacks: window.diskObserverCallbacks }));
  for (let i = 0; i < 3; i++) { await aggregate.focus(); await work.focus(); }
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({ reads: window.diskRectReads, callbacks: window.diskObserverCallbacks }));
  await page.waitForTimeout(300);
  const idle = await page.evaluate(() => ({ reads: window.diskRectReads, callbacks: window.diskObserverCallbacks }));
  assert.deepEqual(after, before, "Inspector focus does not measure or relayout tiles");
  assert.deepEqual(idle, after, "Measurements settle when idle");
  const geometry = () => page.locator('.disk-tile').evaluateAll(nodes => nodes.map(node => {
    const box = node.getBoundingClientRect(); return [box.width, box.height];
  }));
  const beforeSelection = await geometry();
  await page.getByRole('checkbox', { name: 'Select all Review first' }).check();
  await assertWholeLines(page);
  assert.deepEqual(await geometry(), beforeSelection, "Tick counts do not change map membership or geometry");
  const safeSummary = page.getByRole('button', { name: /^Safe to clean, \d+ items,/ });
  if (await safeSummary.count()) {
    const safeCount = Number((await safeSummary.getAttribute('aria-label')).match(/, (\d+) items/)[1]);
    await safeSummary.click();
    assert.equal(await page.locator('.disk-item.is-found').count(), safeCount);
    assert.equal(await page.locator('.disk-item.is-found').first().evaluate(el => el === document.activeElement), true);
  }
  const metrics = await page.locator('.disk-tile, .disk-map-summary').evaluateAll(nodes => nodes.map(el => ({ description: el.getAttribute('aria-label'), width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height, text: el.textContent })));
  await writeFile(join(evidence, `${theme}-${width}-metrics.json`), JSON.stringify({ metrics, before, after, idle }, null, 2));
}
async function workHover(page) { await page.locator(".disk-tile.is-work").hover(); }
async function assertWholeLines(page) {
  const failures = await page.locator(".disk-tile-content").evaluateAll(nodes => nodes.flatMap(node => {
    const box = node.getBoundingClientRect();
    const size = node.querySelector('.disk-tile-visible-size');
    if (!size || getComputedStyle(size).display === 'none' || !size.textContent.trim()) return [{ fit: node.dataset.fit, error: 'Every visible tile must show its size line' }];
    return [...node.querySelectorAll('.disk-tile-visible-label, .disk-tile-visible-size')].flatMap(line => {
      if (getComputedStyle(line).display === 'none') return [];
      const rect = line.getBoundingClientRect();
      const heightOk = rect.top >= box.top - 0.5 && rect.bottom <= box.bottom + 0.5;
      const sizeOk = !line.classList.contains('disk-tile-visible-size') || line.scrollWidth <= line.clientWidth + 0.5;
      return heightOk && sizeOk ? [] : [{ text: line.textContent, fit: node.dataset.fit, box: box.toJSON(), line: rect.toJSON() }];
    });
  }));
  assert.deepEqual(failures, [], "Every visible tile must show a whole size line without clipped glyphs");
  const blankSummaries = await page.locator('.disk-map-summary').evaluateAll(nodes => nodes.filter(node => {
    const size = node.querySelector('.disk-tile-size');
    return !size?.textContent.trim() || getComputedStyle(size).display === 'none' || size.scrollWidth > size.clientWidth + 0.5;
  }).map(node => node.outerHTML));
  assert.deepEqual(blankSummaries, [], "Summary fallbacks must also show their size");
}
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  const themes = process.env.OCTIQ_DISK_THEMES?.split(",") ?? ["dark", "light", "fun", "manga", "guofeng", "xp", "cyberpunk"];
  for (const theme of themes) {
    for (const width of [1280, 390]) {
      const app = await open(theme, width), { page } = app;
      console.log(`Checking ${theme} ${width}`);
      if (crowded) {
        await checkCrowded(page, theme, width);
        await app.context.close();
        continue;
      }
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
      await assertWholeLines(page);
      await screenshot(page, `${theme}-${width}-disk.png`);
      const mapPath = join(evidence, `${theme}-${width}-treemap.png`);
      await page.locator(".disk-map-panel").screenshot({ path: mapPath }); screenshots.push(mapPath);
      const pnpm = page.getByRole("article", { name: "pnpm store", exact: true });
      await page.getByRole("button", { name: /(?:Cache|Safe to clean), 2 items, 3.2 GB/ }).click();
      assert.equal(await pnpm.evaluate(el => el === document.activeElement), true);
      await pnpm.getByRole("checkbox").check();
      assert.equal(await page.locator(".disk-tile.is-selected, .disk-map-summary.is-selected").count(), 1);
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
