// A transcript the window cache has let go must be collectable. Real App, real
// V8: chats whose results are big unique strings are opened in turn (a tiny
// window budget evicts all but the newest), a character is typed in the
// composer, and then every chat but the open one is forgotten. After a full GC
// a heap snapshot is read, and none of the three closures below may still reach
// a result string of a chat other than the open one. Closures made in an App
// render share V8's scope, so a window listener, a context value or a paste
// store holding one of them kept whatever `chats` held then: the pending view's
// `forRow`, the paste store's `receive` (-> `insertText` -> `onPutBack`), and
// the focus/blur `tell`. Other holders of an old render exist (a live fiber's
// previous props, a detached node's handlers); they are React's, bounded to one
// old render, and not what this probe asserts.
// PLAYWRIGHT_MODULE=/abs/playwright/index.mjs node web/scripts/test-scope-retention.mjs
// EXPECT_LEAK=1 inverts the final assertion, for running against a build that
// still has the leaks (the control: the probe must be able to see them).
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const web = resolve(process.env.OCTIQ_WEB_ROOT || fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(join(web, 'package.json'));
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const moduleUrl = spec => isAbsolute(spec) || spec.startsWith('.') ? pathToFileURL(resolve(spec)).href : spec;
const { chromium } = await import(moduleUrl(process.env.PLAYWRIGHT_MODULE || 'playwright'));
const project = { id: 'scope', name: 'Scope fixture', primary_path: '/fixture', paths: ['/fixture'], env: {} };
const N = 14;
const BIG = 3 * 1024 * 1024;
const rows = Array.from({ length: N }, (_, i) => ({
  id: `row-${i}`, projectId: project.id, title: `Row ${i}`, createdAt: i + 1, updatedAt: 1000 + i,
  modelId: 'claude:sonnet-4-6', access: 'read', sessionId: `s-${i}`, latestResponse: `Answer row-${i}.`,
}));
const forgotten = new Set();
const frames = id => forgotten.has(id) ? [] : [
  { seq: 1, event: { type: 'user', uuid: `u-${id}`, message: { content: [{ type: 'text', text: `Question ${id}.` }] } } },
  { seq: 2, event: { type: 'assistant', message: { id: `a-${id}`, content: [{ type: 'text', text: `Answer ${id}.` }, { type: 'tool_use', id: `t-${id}`, name: 'Read', input: { file_path: `/fixture/${id}.txt` } }] } } },
  { seq: 3, event: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t-${id}`, content: `Result ${id} `.padEnd(BIG, 'x') }] } } },
  { seq: 4, event: { type: 'result', subtype: 'success' } },
];
const instrumentation = {
  name: 'tiny-window-budget', enforce: 'pre',
  transform(code, id) {
    // Two big windows at most: everything older than that is evicted.
    if (id.endsWith('/src/lib/chatWindowCache.ts')) code = code.replace(/RECENT_CHAT_BYTES = \d+/, 'RECENT_CHAT_BYTES = 7');
    return code;
  },
};
const cacheDir = await mkdtemp(join(tmpdir(), 'octiq-scope-vite-'));

/** What a heap snapshot says about big strings, and which of the three named
 *  closures can still reach one. A closure "reaches" a string when a walk along
 *  its strong edges (its scope chain, and everything those scopes hold) finds
 *  it, which is exactly what keeps a transcript alive when the closure itself
 *  is kept by a window listener, a context value or a store. */
function analyse(chunks, closureNames) {
  const snap = JSON.parse(chunks.join(''));
  const m = snap.snapshot.meta;
  const nf = m.node_fields, ef = m.edge_fields, nw = nf.length, ew = ef.length;
  const typeAt = nf.indexOf('type'), nameAt = nf.indexOf('name'), sizeAt = nf.indexOf('self_size'), countAt = nf.indexOf('edge_count');
  const toAt = ef.indexOf('to_node'), etypeAt = ef.indexOf('type'), nameAt2 = ef.indexOf('name_or_index');
  const ntypes = m.node_types[0], etypes = m.edge_types[0];
  const nodes = snap.nodes, edges = snap.edges, strings = snap.strings;
  const count = nodes.length / nw;
  const first = new Float64Array(count + 1);
  const bigName = new Map(), closures = [];
  let pos = 0;
  for (let i = 0; i < count; i++) {
    first[i] = pos; pos += nodes[i * nw + countAt] * ew;
    const type = ntypes[nodes[i * nw + typeAt]], name = strings[nodes[i * nw + nameAt]];
    if (nodes[i * nw + sizeAt] >= 1_000_000 && type.includes('string')) {
      const id = /^Result (row-\d+) /.exec(name)?.[1];
      if (id) bigName.set(i, id);
    } else if (type === 'closure' && closureNames.includes(name)) closures.push({ i, name });
  }
  first[count] = pos;
  const skip = new Set(['weak', 'shortcut']);
  // Never walk out of the closure's own data into the engine: a function's map,
  // shared info, code and native context lead to the global object, and from
  // there to everything, which says nothing about what the closure keeps.
  const engine = new Set(['map', 'shared', 'shared_info', 'feedback_cell', 'feedback_vector', 'code', 'native_context', 'script', 'scope_info', 'prototype', 'constructor', '__proto__', 'global_object', 'global_proxy_object']);
  // The browser's own objects (the window, the document, DOM nodes) are alive
  // for their own reasons and reach every fiber; a listener holding `window`
  // is not thereby holding the app. From a function held in a scope only its own
  // scope chain is followed, never its properties; and a captured React binding
  // (`useContext`, `ReactSharedInternals`) is not followed at all, since React's
  // internals reach every fiber. What a closure keeps is its scope chain and the
  // data in it: an old render's `chats` shows up there as a variable.
  const library = /^(use[A-Z]\w*|React\w*|_?jsxs?\w*|Fragment|memo|forwardRef|createContext|lazy|startTransition|flushSync)$/;
  const boundary = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const type = ntypes[nodes[i * nw + typeAt]], name = strings[nodes[i * nw + nameAt]];
    if (type === 'native' || type === 'synthetic' || /^(Window|HTMLDocument|Document|system \/ NativeContext)\b/.test(name)) boundary[i] = 1;
  }
  // A leak is short: closure, its scope, the render scope before it, the `chats`
  // variable, the chat, its messages, a block, the result. A path past MAX_HOPS
  // runs through a module scope into the app's own roots and says nothing about
  // what the closure keeps, so the walk is breadth-first and stops there.
  const MAX_HOPS = 14;
  const reach = start => {
    const seen = new Uint8Array(count), found = new Set(), via = process.env.DEBUG_CHAIN ? new Map() : null;
    let level = [start];
    seen[start] = 1;
    for (let hop = 0; hop <= MAX_HOPS && level.length; hop++) {
      const next = [];
      for (const n of level) {
        if (bigName.has(n)) {
          if (via && !found.size) {
            const chain = [];
            for (let at = n; at !== start && chain.length < 60; at = via.get(at).from) chain.push(`${via.get(at).edge} -> ${ntypes[nodes[at * nw + typeAt]]}:${strings[nodes[at * nw + nameAt]].slice(0, 30)}`);
            console.error('CHAIN', JSON.stringify(chain.reverse()));
          }
          found.add(bigName.get(n));
        }
        for (let e = first[n]; e < first[n + 1]; e += ew) {
          const etype = etypes[edges[e + etypeAt]];
          if (skip.has(etype)) continue;
          const ename = strings[edges[e + nameAt2]];
          if ((etype === 'internal' || etype === 'property') && engine.has(ename)) continue;
          if (etype === 'context' && library.test(ename)) continue;
          if (ntypes[nodes[n * nw + typeAt]] === 'closure' && n !== start && !(etype === 'internal' && ename === 'context')) continue;
          const to = edges[e + toAt] / nw;
          if (seen[to] || boundary[to]) continue;
          seen[to] = 1; next.push(to);
          if (via) via.set(to, { from: n, edge: `${etype}:${etype === 'element' || etype === 'hidden' ? edges[e + nameAt2] : ename}` });
        }
      }
      level = next;
    }
    return [...found];
  };
  return {
    live: [...bigName.values()],
    closures: closures.map(c => ({ name: c.name, reaches: reach(c.i) })),
  };
}

if (process.env.ANALYSE_SNAPSHOT) {
  // Read an existing snapshot (DUMP wrote it) instead of driving the app.
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(process.env.ANALYSE_SNAPSHOT, 'utf8');
  const { live, closures } = analyse([text], ['forRow', 'tell', 'receive']);
  console.log(JSON.stringify({ live, closures }));
  process.exit(0);
}
let server, browser;
try {
  server = await createServer({ cacheDir: join(cacheDir, 'node_modules', '.vite'), root: web, configFile: join(web, 'vite.config.ts'), server: { host: '127.0.0.1', port: 0, strictPort: false }, plugins: [instrumentation] });
  await server.listen();
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true, args: ['--js-flags=--expose-gc'] });
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
          case 'chat_record_head': result = { lastSeq: forgotten.has(id) ? 0 : 4, generation: forgotten.has(id) ? 'g2' : 'g' }; break;
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
    page.setDefaultTimeout(60000);
    forgotten.clear();
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?token=fixture-token#/c/row-0`, { waitUntil: 'domcontentloaded' });
    await page.locator('.msgs').getByText('Answer row-0.', { exact: true }).waitFor();
    for (let i = 0; i < N; i++) {
      await page.evaluate(id => { location.hash = '#/c/' + id; }, `row-${i}`);
      await page.locator('.msgs').getByText(`Answer row-${i}.`, { exact: true }).waitFor();
      await page.waitForTimeout(80);
    }
    // Type in the composer: its next render is the one a paste store would keep.
    const box = page.locator('textarea.composer-input');
    await box.click();
    await box.pressSequentially('a');
    // Every chat but the open one goes away on the host: its window is reset.
    for (let i = 0; i < N - 1; i++) {
      forgotten.add(`row-${i}`);
      socket.send(JSON.stringify({ t: 'event', event: 'chat-forgotten', payload: { key: `chat:row-${i}` } }));
    }
    await page.waitForTimeout(1500);
    // React keeps the render before the last as the other half of its double
    // buffer; a few more renders let that go, so what is left is held by
    // something longer-lived.
    for (const ch of 'bcd') { await box.pressSequentially(ch); await page.waitForTimeout(300); }
    await page.waitForTimeout(1000);
    const cdp = await context.newCDPSession(page);
    await cdp.send('HeapProfiler.enable');
    const chunks = [];
    cdp.on('HeapProfiler.addHeapSnapshotChunk', ({ chunk }) => chunks.push(chunk));
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    // DUMP=/abs/dir keeps each snapshot, to find what retains a string.
    if (process.env.DUMP) await writeFile(join(process.env.DUMP, `scope-${width}.heapsnapshot`), chunks.join(''));
    const { live, closures } = analyse(chunks, ['forRow', 'tell', 'receive']);
    const open = `row-${N - 1}`;
    // Chats other than the open one that the three named closures still reach.
    const kept = closures.map(c => ({ name: c.name, reaches: c.reaches.filter(id => id !== open) }));
    assert.deepEqual(errors, []);
    report.push({ width, live, closures: closures.length, kept: kept.filter(c => c.reaches.length) });
    await context.close();
  }
  console.log(JSON.stringify(report));
  for (const r of report) {
    if (process.env.EXPECT_LEAK === '1') assert.ok(r.kept.length > 0, `${r.width}px: expected the old build to keep a forgotten transcript through forRow, tell or receive`);
    else assert.deepEqual(r.kept, [], `${r.width}px: forRow, tell or receive still keeps a transcript the window cache let go`);
  }
} finally {
  await browser?.close(); await server?.close(); await rm(cacheDir, { recursive: true, force: true });
}
