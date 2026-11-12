// Which sidebar rows exist while the person switches chats? Real App, synthetic
// index + records, no live server. For every switch the script records the set
// of chat rows in the list and compares it with what the list must show: every
// listed chat except those ticked done (Active view), plus the open chat.
// ONLY_EVICT=1 additionally forces the old six-window cap so window eviction is
// exercised hard; the rows must be the same either way (eviction never touches
// conversation metadata).
// PLAYWRIGHT_MODULE=/abs/playwright/index.mjs node web/scripts/test-sidebar-rows.mjs
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const web = resolve(process.env.OCTIQ_WEB_ROOT || fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(join(web, 'package.json'));
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const moduleUrl = spec => isAbsolute(spec) || spec.startsWith('.') ? pathToFileURL(resolve(spec)).href : spec;
const { chromium } = await import(moduleUrl(process.env.PLAYWRIGHT_MODULE || 'playwright'));
const project = { id: 'rows', name: 'Rows fixture', primary_path: '/fixture', paths: ['/fixture'], env: {} };
const N = 40;
const done = new Set([3, 11, 25]);
const rows = Array.from({ length: N }, (_, i) => ({
  id: `row-${i}`, projectId: project.id, title: `Row ${i}`, createdAt: i + 1, updatedAt: 1000 + i, modelId: 'claude:sonnet-4-6', access: 'read', sessionId: `s-${i}`,
  latestResponse: `Answer row-${i}.`, ...(done.has(i) ? { doneAt: 5000 } : {}),
}));
const frames = id => [
  { seq: 1, event: { type: 'user', uuid: `u-${id}`, message: { content: [{ type: 'text', text: `Question ${id}.` }] } } },
  { seq: 2, event: { type: 'assistant', message: { id: `a-${id}`, content: [{ type: 'text', text: `Answer ${id}.` }] } } },
  { seq: 3, event: { type: 'result', subtype: 'success' } },
];
const evict = process.env.ONLY_EVICT === '1';
const instrumentation = {
  name: 'six-window-cap', enforce: 'pre',
  transform(code, id) {
    if (evict && id.endsWith('/src/lib/chatWindowCache.ts')) code = code.replace('RECENT_CHAT_BYTES = 256', 'RECENT_CHAT_BYTES = 8');
    return code;
  },
};
const cacheDir = await mkdtemp(join(tmpdir(), 'octiq-rows-vite-'));
let server, browser;
try {
  server = await createServer({ cacheDir: join(cacheDir, 'node_modules', '.vite'), root: web, configFile: join(web, 'vite.config.ts'), server: { host: '127.0.0.1', port: 0, strictPort: false }, plugins: [instrumentation] });
  await server.listen();
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const report = [];
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 840 } });
    let socket;
    await context.route('**/token', route => route.fulfill({ body: 'fixture-token' }));
    await context.routeWebSocket(/\/ws\?/, ws => {
      socket = ws;
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
    page.setDefaultTimeout(30000);
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?token=fixture-token#/c/row-0`, { waitUntil: 'domcontentloaded' });
    await page.locator('.msgs').getByText('Answer row-0.', { exact: true }).waitFor();
    // At phone width the list lives behind the menu; the rows stay in the DOM
    // only while it is open, so open it where it is closed.
    const listed = () => page.evaluate(() => [...document.querySelectorAll('li.chat-row[data-row]')].map(el => el.getAttribute('data-row')));
    const vanished = [];
    const seen = new Set();
    for (let i = 0; i < N; i++) {
      await page.evaluate(id => { location.hash = '#/c/' + id; }, `row-${i}`);
      await page.locator('.msgs').getByText(`Answer row-${i}.`, { exact: true }).waitFor();
      await page.waitForTimeout(60);
      const ids = await listed();
      if (width === 390 && ids.length === 0) { seen.add('menu-closed'); continue; }
      const listedSet = new Set(ids);
      const expected = rows.map(r => r.id).filter(id => !done.has(Number(id.slice(4))) || id === `row-${i}`);
      const missing = expected.filter(id => !listedSet.has(id));
      if (missing.length) vanished.push({ at: i, missing });
      // A done chat that was open and has been left must be gone again: that is
      // the Active view's rule (the open chat is always kept), not a lost row.
      if (i > 0 && done.has(i - 1) && width === 1280) assert.equal(listedSet.has(`row-${i - 1}`), false, 'a done chat left behind should leave the Active view');
      for (const id of ids) seen.add(id);
    }
    // And a reconnect (full list answer) mid-way keeps every row.
    if (width === 1280) {
      socket.close();
      await page.waitForTimeout(1500);
      const ids = new Set(await listed());
      const missing = rows.map(r => r.id).filter(id => !done.has(Number(id.slice(4))) && id !== 'row-39' && !ids.has(id));
      assert.deepEqual(missing, [], 'rows missing after a reconnect');
    }
    assert.deepEqual(errors, []);
    report.push({ width, evict, switches: N, vanishedNonDone: vanished, rowsSeen: seen.size });
    await context.close();
  }
  console.log(JSON.stringify(report));
  for (const r of report) if (r.width === 1280) assert.deepEqual(r.vanishedNonDone, [], 'a listed, not-done chat vanished from the sidebar while switching');
} finally {
  await browser?.close(); await server?.close(); await rm(cacheDir, { recursive: true, force: true });
}
