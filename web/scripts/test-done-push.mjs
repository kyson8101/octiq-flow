// A chat ticked done while the Active view lists it is pushed out by a robot
// three seconds later. Real App, synthetic index + records, no live server.
// Asserts: the row stays 2.9 s, then gets the robot, then is gone; the open chat
// stays open; the page never scrolls sideways; and takes screenshots mid-push
// (animations paused part-way) at 1280 and 390, for the themes in THEMES.
//
// PLAYWRIGHT_MODULE=/abs/playwright/index.mjs SHOTS=/abs/dir THEMES=dark,light \
//   node web/scripts/test-done-push.mjs
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const web = resolve(process.env.OCTIQ_WEB_ROOT || fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(join(web, 'package.json'));
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const moduleUrl = spec => isAbsolute(spec) || spec.startsWith('.') ? pathToFileURL(resolve(spec)).href : spec;
const { chromium } = await import(moduleUrl(process.env.PLAYWRIGHT_MODULE || 'playwright'));
const shots = process.env.SHOTS ? resolve(process.env.SHOTS) : null;
const themes = (process.env.THEMES || 'dark').split(',');
if (shots) await mkdir(shots, { recursive: true });
const project = { id: 'rows', name: 'Rows fixture', primary_path: '/fixture', paths: ['/fixture'], env: {} };
const rows = Array.from({ length: 6 }, (_, i) => ({
  id: `row-${i}`, projectId: project.id, title: `Chat number ${i}`, createdAt: i + 1, updatedAt: 1000 + i, modelId: 'claude:sonnet-4-6', access: 'read', sessionId: `s-${i}`,
  latestResponse: `Answer row-${i}.`,
}));
const frames = id => [
  { seq: 1, event: { type: 'user', uuid: `u-${id}`, message: { content: [{ type: 'text', text: `Question ${id}.` }] } } },
  { seq: 2, event: { type: 'assistant', message: { id: `a-${id}`, content: [{ type: 'text', text: `Answer ${id}.` }] } } },
  { seq: 3, event: { type: 'result', subtype: 'success' } },
];
const cacheDir = await mkdtemp(join(tmpdir(), 'octiq-donepush-vite-'));
let server, browser;
try {
  server = await createServer({ cacheDir: join(cacheDir, 'node_modules', '.vite'), root: web, configFile: join(web, 'vite.config.ts'), server: { host: '127.0.0.1', port: 0, strictPort: false } });
  await server.listen();
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const report = [];
  for (const theme of themes) for (const width of [1280, 390]) {
    const reduced = process.env.REDUCED === '1';
    const context = await browser.newContext({ viewport: { width, height: 840 }, reducedMotion: reduced ? 'reduce' : 'no-preference' });
    await context.addInitScript(t => { try { localStorage.setItem('octiq.theme', t); } catch {} }, theme);
    // The picture is taken by hand while the push is frozen part-way, and the
    // page's own 560 ms push timer would not wait for it: stretch that one
    // timer (once) so the robot is still there when the screenshot is taken.
    await context.addInitScript(() => {
      const real = window.setTimeout.bind(window);
      window.__stretch = true;
      window.setTimeout = (fn, ms, ...rest) => {
        if (window.__stretch && ms === 560) { window.__stretch = false; ms = 10000; }
        return real(fn, ms, ...rest);
      };
    });
    await context.route('**/token', route => route.fulfill({ body: 'fixture-token' }));
    await context.routeWebSocket(/\/ws\?/, ws => {
      ws.onMessage(raw => {
        const call = JSON.parse(String(raw));
        if (call.t !== 'invoke') return;
        const a = call.args ?? {}, id = a.key?.slice(5);
        let result = [];
        switch (call.cmd) {
          case 'list_workspaces': result = [project]; break;
          case 'chat_index_list': result = rows; break;
          case 'chat_subscribe': result = { chatKeys: a.chatKeys }; break;
          case 'orchestration_summary': result = { runs: [], tasks: [], attempts: [], gates: [], messages: [], notifications: [], reports: {}, batches: [], services: [], bridges: [], peerAsks: [], nativeDecisions: [], summary: true, revision: 'r:1', runRevisions: {} }; break;
          case 'chat_page': result = { events: frames(id), context: [], before: null }; break;
          case 'chat_since': result = frames(id).filter(f => f.seq > a.after); break;
          case 'chat_record_head': result = { lastSeq: 3, generation: 'g' }; break;
          case 'chat_queue_state': result = { live: false, queuedTurnIds: [] }; break;
          case 'chat_task': result = null; break;
          case 'usage_summary': result = { sessions: [], totals: {} }; break;
          case 'resolve_paths': result = (a.paths ?? []).map(() => null); break;
        }
        ws.send(JSON.stringify({ t: 'reply', id: call.id, ok: true, result }));
      });
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.setDefaultTimeout(120000);
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?token=fixture-token#/c/row-2`, { waitUntil: 'domcontentloaded', timeout: 240000 });
    await page.locator('.msgs').getByText('Answer row-2.', { exact: true }).waitFor();
    if (width === 390) await page.getByRole('button', { name: 'Show chats' }).click().catch(() => {});
    const row = id => page.locator(`li.chat-row[data-row="${id}"]`);
    await row('row-4').waitFor();
    await page.waitForTimeout(800);
    const tick = async id => {
      const badge = row(id).locator('.chat-badge').first();
      await badge.dblclick();
    };
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const label = `${theme}-${width}`;

    // 1. Another chat is ticked. Its row stays three seconds, then the robot
    // comes and the push is frozen part-way for the picture. The page itself
    // notes when the robot appeared: a loaded machine makes any wait from
    // here unreliable.
    await page.evaluate(() => {
      window.__robotAt = null;
      new MutationObserver(() => {
        if (window.__robotAt || !document.querySelector('.done-push-robot')) return;
        window.__robotAt = performance.now();
        document.getAnimations().forEach(a => { a.pause(); a.currentTime = 330; });
      }).observe(document.body, { childList: true, subtree: true });
    });
    const tickedAt = await page.evaluate(() => performance.now());
    await tick('row-4');
    if (reduced) {
      // No robot, no slide: a short fade and the collapse, then the row is gone.
      await page.waitForFunction(() => document.querySelector('li.chat-row[data-row="row-4"].is-pushing'), null, { timeout: 30000 });
      assert.equal(await page.locator('.done-push-lane').evaluate(el => getComputedStyle(el).display).catch(() => 'none'), 'none');
      await row('row-4').waitFor({ state: 'detached', timeout: 40000 });
      await tick('row-2');
      await row('row-2').waitFor({ state: 'detached', timeout: 40000 });
      assert.ok(new URL(page.url()).hash.endsWith('/c/row-2'));
      report.push({ label: `${label}-reduced`, ok: true });
      await context.close();
      continue;
    }
    await page.waitForFunction(() => window.__robotAt, null, { timeout: 30000 });
    const waited = await page.evaluate(at => window.__robotAt - at, tickedAt);
    assert.ok(waited >= 2900 && waited < 20000, `robot arrives about 3 s after the tick (was ${Math.round(waited)} ms)`);
    if (process.env.DEBUG_PUSH) console.log(await page.evaluate(() => { const li = document.querySelector('li.is-pushing'); const r = e => { const b = e.getBoundingClientRect(); return [b.x, b.y, b.width, b.height].map(Math.round).join(','); }; return { li: li.className, pos: getComputedStyle(li).position, liRect: r(li), lane: r(li.querySelector('.done-push-lane')), robot: r(li.querySelector('.done-push-robot')), left: getComputedStyle(li.querySelector('.done-push-robot')).left }; }));
    assert.ok(await page.locator('.done-push-robot').evaluate(el => getComputedStyle(el).pointerEvents) === 'none');
    assert.ok((await overflow()) <= 0, 'no horizontal page scroll mid-push');
    if (shots) await page.screenshot({ path: join(shots, `push-${label}.png`), clip: width === 1280 ? { x: 0, y: 0, width: 360, height: 700 } : undefined });
    await page.evaluate(() => { window.__robotAt = 1; document.getAnimations().forEach(a => a.play()); });
    await row('row-4').waitFor({ state: 'detached', timeout: 40000 });
    assert.equal(await page.locator('.msgs').getByText('Answer row-2.', { exact: true }).count(), 1, 'open chat stays open');

    // 2. The OPEN chat is ticked. Its row leaves, the chat stays on screen.
    await tick('row-2');
    await row('row-2').waitFor({ state: 'detached', timeout: 20000 });
    assert.equal(await page.locator('.msgs').getByText('Answer row-2.', { exact: true }).count(), 1, 'open chat stays open');
    assert.ok(new URL(page.url()).hash.endsWith('/c/row-2'), 'nothing navigated');
    assert.ok((await overflow()) <= 0);
    assert.deepEqual(errors, []);
    report.push({ label, ok: true });
    await context.close();
  }
  console.log(JSON.stringify(report));
} finally {
  await browser?.close(); await server?.close(); await rm(cacheDir, { recursive: true, force: true });
}
