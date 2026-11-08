// Real App, disposable browser and synthetic command socket. No live profile.
// HISTORY_BASELINE=1 records the unfixed control without enforcing budgets.
// HISTORY_ENGINE=webkit uses Playwright WebKit; Chromium accepts a local binary.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const web = resolve(process.env.OCTIQ_WEB_ROOT || fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(join(web, 'package.json'));
const { createServer, preview } = await import(pathToFileURL(require.resolve('vite')).href);
const spec = process.env.PLAYWRIGHT_MODULE || 'playwright';
const playwright = await import(isAbsolute(spec) || spec.startsWith('.') ? pathToFileURL(resolve(spec)).href : spec);
const engine = process.env.HISTORY_ENGINE || 'chromium', baseline = process.env.HISTORY_BASELINE === '1';
const project = { id: 'history', name: 'History fixture', primary_path: '/fixture', paths: ['/fixture'], env: {} };
const turns = 1200, pageTurns = Number(process.env.HISTORY_PAGE_TURNS || 3), presses = Number(process.env.HISTORY_PRESSES || 16);
const frames = n => [
  { seq: n * 4 + 1, event: { type: 'user', uuid: `u-${n}`, octiq_user_turn_id: `t-${n}`, message: { content: [{ type: 'text', text: `Question ${n}.` }] } } },
  { seq: n * 4 + 2, event: { type: 'assistant', message: { id: `a-${n}`, content: [{ type: 'text', text: `Answer ${n}.\n\n` + ('A paragraph for reading history. '.repeat(12) + '\n\n').repeat(4) }, { type: 'tool_use', id: `c-${n}`, name: 'Read', input: { path: '/fixture/file' } }] } } },
  { seq: n * 4 + 3, event: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `c-${n}`, content: `${n}:` + 'x'.repeat(64 * 1024) }] } } },
  { seq: n * 4 + 4, event: { type: 'result', subtype: 'success' } },
];
let server, browser, scratch;
const results = [];
try {
  scratch = await mkdtemp(join(tmpdir(), 'octiq-earlier-'));
  server = process.env.OCTIQ_TEST_DIST
    ? await preview({ root: web, build: { outDir: resolve(process.env.OCTIQ_TEST_DIST) }, preview: { host: '127.0.0.1', port: 0, strictPort: false } })
    : await createServer({ root: web, cacheDir: join(scratch, '.vite'), server: { host: '127.0.0.1', port: 0, strictPort: false, fs: { allow: [web, fileURLToPath(new URL('../node_modules', import.meta.url))] } } });
  if (!process.env.OCTIQ_TEST_DIST) await server.listen();
  browser = await playwright[engine].launch({ headless: true, ...(engine === 'chromium' ? {
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : { channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' }),
    args: ['--enable-precise-memory-info'],
  } : process.env.HISTORY_WEBKIT_EXECUTABLE_PATH ? { executablePath: process.env.HISTORY_WEBKIT_EXECUTABLE_PATH } : {}) });
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, ...(width === 390 ? { isMobile: true, hasTouch: true } : {}) });
    let reads = 0, wireBytes = 0;
    await context.route('**/token', route => route.fulfill({ body: 'fixture' }));
    await context.routeWebSocket(/\/ws\?/, ws => ws.onMessage(async raw => {
      const call = JSON.parse(String(raw)); if (call.t !== 'invoke') return;
      const a = call.args || {}; let result = [];
      switch (call.cmd) {
        case 'chat_subscribe': result = { chatKeys: a.chatKeys }; break;
        case 'list_workspaces': result = [project]; break;
        case 'chat_index_list': result = [{ id: 'history', projectId: 'history', title: 'Long history', createdAt: 1, updatedAt: 1, modelId: 'claude:sonnet-4-6', access: 'read', sessionId: 'fixture' }]; break;
        case 'orchestration_summary': case 'orchestration_snapshot': result = { runs: [], tasks: [], attempts: [], gates: [], nativeDecisions: [], messages: [], notifications: [], services: [], bridges: [], peerAsks: [], reports: {}, summary: true }; break;
        case 'chat_page': {
          reads++;
          const last = a.before == null ? turns - 1 : Math.floor((a.before - 2) / 4);
          const first = Math.max(0, last - pageTurns + 1);
          result = { events: Array.from({ length: last - first + 1 }, (_, i) => frames(first + i)).flat(), context: [], before: first ? first * 4 + 1 : null };
          // Time for continued scrolling while the response is in flight.
          await new Promise(resolve => setTimeout(resolve, 80));
          wireBytes += Buffer.byteLength(JSON.stringify(result)); break;
        }
        case 'chat_task': result = null; break;
        case 'resolve_paths': result = a.paths.map(() => null); break;
        case 'usage_summary': result = { sessions: [], totals: {} }; break;
      }
      try { ws.send(JSON.stringify({ t: 'reply', id: call.id, ok: true, result })); } catch { /* context closed */ }
    }));
    const page = await context.newPage(), errors = [];
    if (process.env.HISTORY_TRACE) await page.addInitScript(() => {
      const d = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
      Object.defineProperty(Element.prototype, 'scrollTop', { ...d, set(value) {
        const s = window.__historySample;
        if (s && this.matches?.('.msgs')) {
          s.drift.push({ value, expected: s.top, time: Math.round(performance.now() - s.started), first: this.querySelector('[data-map-turn]')?.dataset.mapTurn, stack: new Error().stack.split('\n').slice(1, 4) });
        }
        d.set.call(this, value);
      } });
    });
    page.on('pageerror', error => { errors.push(String(error)); console.error(error.stack); });
    page.setDefaultTimeout(30000);
    try {
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?token=fixture#/c/history`);
      await page.locator('.msgs [data-map-turn]').first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      const cdp = engine === 'chromium' ? await context.newCDPSession(page) : null;
      const heap = async () => {
        if (!cdp) return null;
        await cdp.send('HeapProfiler.collectGarbage');
        return (await cdp.send('Runtime.getHeapUsage')).usedSize;
      };
      const initialHeap = await heap(), samples = [];
      for (let i = 0; i < presses; i++) {
        // No scrollIntoView side effects from Playwright: place the control
        // explicitly, then issue input through the real DOM listener.
        const beforeReads = reads, beforeBytes = wireBytes;
        const mode = ['button', 'scroll', 'momentum'][i % 3];
        await page.evaluate(mode => {
          const el = document.querySelector('.msgs');
          if (mode !== 'button') el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }));
          el.scrollTop = 0;
          const anchor = el.querySelector('[data-map-turn]');
          window.__historySample = { id: anchor.dataset.mapTurn, top: anchor.getBoundingClientRect().top, started: performance.now(), drift: [] };
          window.__historyScroll?.abort();
          window.__historyScroll = new AbortController();
          el.addEventListener('scroll', () => {
            // The native scroll event can land a frame after scrollTop was
            // assigned. Follow that gesture only while the old DOM is intact.
            if (el.querySelector('[data-map-turn]')?.dataset.mapTurn === window.__historySample.id) {
              window.__historySample.top = anchor.getBoundingClientRect().top;
            }
          }, { signal: window.__historyScroll.signal });
          if (mode === 'button') {
            const button = el.querySelector('.history-more button');
            button.click(); button.click(); button.click();
          }
          else {
            el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }));
            el.scrollTop = 100;
            window.__historySample.top = anchor.getBoundingClientRect().top;
            el.dispatchEvent(new Event('scroll'));
            if (mode === 'momentum') {
              // A continued gesture changes its own target before the page lands.
              let count = 0;
              const move = () => {
                el.scrollTop = Math.max(0, el.scrollTop - 5);
                window.__historySample.top = anchor.getBoundingClientRect().top;
                el.dispatchEvent(new Event('scroll'));
                if (++count < 3) requestAnimationFrame(move);
              };
              requestAnimationFrame(move);
            }
          }
        }, mode);
        await page.waitForFunction(() => {
          const el = document.querySelector('.msgs'), s = window.__historySample;
          return el.querySelector('[data-map-turn]')?.dataset.mapTurn !== s.id && !el.querySelector('.history-more button:disabled');
        });
        const elapsed = await page.evaluate(() => performance.now() - window.__historySample.started);
        await page.waitForTimeout(160);
        const drift = await page.evaluate(() => {
          const s = window.__historySample;
          const anchor = [...document.querySelectorAll('.msgs [data-map-turn]')].find(node => node.dataset.mapTurn === s.id);
          return anchor ? anchor.getBoundingClientRect().top - s.top : null;
        });
        samples.push({ mode, elapsedMs: Math.round(elapsed), driftPx: drift, pageReads: reads - beforeReads, wireBytes: wireBytes - beforeBytes, heap: await heap() });
        if (process.env.HISTORY_TRACE) console.log('trace', i, JSON.stringify(await page.evaluate(() => window.__historySample)));
        if (!baseline) {
          assert.notEqual(drift, null, 'prepend must keep the old visible anchor');
          assert.ok(Math.abs(drift) <= 2, `${engine} ${width} ${mode} anchor drift ${drift}px`);
          assert.ok(reads - beforeReads <= 2, 'one older page and at most one bounded catch-up');
          const pageBudget = 2 * pageTurns * Buffer.byteLength(JSON.stringify(frames(turns - 1))) + 1024;
          assert.ok(wireBytes - beforeBytes <= pageBudget, 'per-press bytes must depend on the page, not the loaded window');
          // Includes the native-scroll quiet wait and two 80ms fixture RTTs.
          assert.ok(elapsed < 5000, `per-press wall time ${elapsed}ms`);
          const drawn = await page.locator('.msgs [data-map-turn]').count();
          assert.ok(drawn <= pageTurns * 12, `bounded history DOM: ${drawn} turns`);
        }
      }
      // A late media/font height change above the reader must keep the same
      // anchor after the initial layout restoration, too.
      const reflow = await page.evaluate(async () => {
        const s = window.__historySample, el = document.querySelector('.msgs');
        const anchor = [...el.querySelectorAll('[data-map-turn]')].find(node => node.dataset.mapTurn === s.id);
        if (!anchor) return null;
        const top = anchor.getBoundingClientRect().top;
        el.querySelector('[data-map-turn]').style.marginTop = '137px';
        await new Promise(resolve => setTimeout(resolve, 120));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (Math.abs(anchor.getBoundingClientRect().top - top) > 2) console.log('late-layout', { anchorStyle: el.style.overflowAnchor, top, now: anchor.getBoundingClientRect().top, inner: el.querySelector('.msgs-inner').getBoundingClientRect().height });
        return anchor.getBoundingClientRect().top - top;
      });
      if (!baseline) {
        assert.notEqual(reflow, null);
        assert.ok(Math.abs(reflow) <= 2, `late layout drift ${reflow}px`);
        if (samples.at(-1).heap !== null && pageTurns === 3 && presses >= 12) assert.ok(samples.at(-1).heap - samples[11].heap < 4 * 1024 * 1024, 'heap must plateau once the page window is full');
      }
      const result = { engine, browserVersion: browser.version(), width, baseline, pageTurns, initialHeap, samples, lateLayoutDriftPx: reflow, errors };
      results.push(result); console.log(JSON.stringify(result));
      assert.deepEqual(errors, []);
      await cdp?.detach();
    } finally { await context.close(); }
  }
  if (process.env.HISTORY_RESULTS) await writeFile(process.env.HISTORY_RESULTS, JSON.stringify({ results }, null, 2));
} finally {
  await browser?.close();
  if (server) { if (server.close) await server.close(); else await new Promise(resolve => server.httpServer.close(resolve)); }
  if (scratch) await rm(scratch, { recursive: true, force: true });
}
