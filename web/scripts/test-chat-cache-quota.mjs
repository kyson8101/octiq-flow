// A NATIVE full disk against lib/chatCache: real Chrome, CDP's per-origin quota
// override (6 MiB), random (incompressible) 1 MiB checkpoints. A quota error
// aborts the write's transaction, so eviction must have been committed before
// it; once the disk is full the newest row must still be stored and the oldest
// freed. fake-indexeddb cannot say this (see chatCache.test.ts for its model).
// Usage: PLAYWRIGHT_MODULE=/abs/playwright/index.mjs node web/scripts/test-chat-cache-quota.mjs
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
const cacheDir = await mkdtemp(join(tmpdir(), 'octiq-quota-vite-'));
const server = await createServer({
  root: web, cacheDir, server: { host: '127.0.0.1', port: 0 },
  plugins: [{ name: 'blank', configureServer(s) { s.middlewares.use('/__quota', (_q, r) => { r.setHeader('Content-Type', 'text/html'); r.end('<html><body>Quota test</body></html>'); }); } }],
});
let browser;
try {
  await server.listen();
  const origin = 'http://127.0.0.1:' + server.httpServer.address().port;
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  const p = await browser.newPage();
  await p.goto(origin + '/__quota');
  const cdp = await p.context().newCDPSession(p);
  await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: 6 * 1024 * 1024 });
  const stages = await p.evaluate(async () => {
    const { saveChatCheckpoint, readChatCheckpoint } = await import('/src/lib/chatCache.ts');
    const { emptyChat } = await import('/src/lib/chat.ts');
    const errors = [];
    const native = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...a) { const tx = native.apply(this, a); tx.addEventListener('abort', () => errors.push(tx.error?.name)); return tx; };
    const make = () => {
      const parts = [];
      for (let i = 0; i < 32; i++) { const a = new Uint8Array(32768); crypto.getRandomValues(a); parts.push(Array.from(a, x => String.fromCharCode(33 + x % 90)).join('')); }
      const s = emptyChat(); s.messages = [{ id: 'm', role: 'assistant', streaming: false, blocks: [{ kind: 'text', text: parts.join('') }] }]; return s;
    };
    const keys = () => new Promise((r, j) => { const op = indexedDB.open('octiq.chat-cache', 2); op.onsuccess = () => { const d = op.result, q = d.transaction('checkpoints').objectStore('checkpoints').getAllKeys(); q.onsuccess = () => { d.close(); r(q.result); }; q.onerror = j; }; });
    const out = [];
    for (let i = 0; i < 9; i++) {
      let threw = false;
      try { await saveChatCheckpoint({ id: 'q' + i, seq: i, state: make(), updatedAt: i + 1 }); } catch { threw = true; }
      out.push({ i, threw, keys: await keys(), found: !!await readChatCheckpoint('q' + i), errors: errors.length });
    }
    return out;
  });
  for (const s of stages) {
    assert.equal(s.threw, false, `save ${s.i} threw into the caller`);
    assert.equal(s.found, true, `save ${s.i} did not store the newest row: ${JSON.stringify(s)}`);
  }
  const last = stages.at(-1);
  assert.ok(stages.some(s => s.errors > 0), 'the quota override never produced a native QuotaExceededError');
  assert.ok(!last.keys.includes('q0'), 'the oldest row was not freed on a full disk');
  assert.ok(last.keys.includes('q8'));
  console.log(JSON.stringify({ ok: true, finalKeys: last.keys, nativeQuotaAborts: last.errors }));
} finally {
  await browser?.close(); await server.close(); await rm(cacheDir, { recursive: true, force: true });
}
