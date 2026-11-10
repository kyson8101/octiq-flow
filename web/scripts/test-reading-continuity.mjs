// Real App + Run panel; disposable browser and fixture sockets only.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node web/scripts/test-reading-continuity.mjs
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {browserPaths} from '../../scripts/browser-paths.mjs';

const {webRoot: web, require, moduleUrl} = browserPaths(new URL('../../scripts/browser-paths.mjs', import.meta.url).href);
const {createServer} = await import(pathToFileURL(require.resolve('vite')).href);
const {chromium} = await import(moduleUrl(process.env.PLAYWRIGHT_MODULE || 'playwright'));
const empty = {runs: [], tasks: [], attempts: [], gates: [], messages: [], notifications: [], reports: {}};
const project = {id: 'continuity', name: 'Continuity fixture', primary_path: '/fixture', paths: ['/fixture'], env: {}};
const rows = ['a', 'b', 'slow', 'empty'].map((id, i) => ({id, projectId: project.id, title: `Chat ${id}`, createdAt: i + 1, updatedAt: i + 1, modelId: 'claude:sonnet-4-6', access: 'read'}));
const frames = id => [{seq: 100, event: {type: 'user', uuid: `q-${id}`, message: {content: [{type: 'text', text: `Question ${id}`}]}}},
  {seq: 101, event: {type: 'assistant', message: {id: `m-${id}`, content: [{type: 'text', text: `Answer ${id}`}]}}}];
const run = {id: 'r', objective: 'Running fixture', coordinatorChatKey: 'chat:a', workspaceId: project.id, rootPath: '/fixture', status: 'running', maxConcurrent: 1, createdAt: 1, updatedAt: 1};
const task = {id: 't', runId: 'r', title: 'Visible worker task', spec: 'Worker detail', dependsOn: [], status: 'running', activeAttemptId: 'at', createdAt: 1, updatedAt: 1};
const attempt = {id: 'at', runId: 'r', taskId: 't', number: 1, workerChatKey: 'chat:w', agent: 'codex', access: 'auto', status: 'running', cwd: '/fixture', branch: 'feature/fixture', isWorktree: true, filesModified: [], createdAt: 1, updatedAt: 1,
  execution: {state: 'executing', lastActivityAt: 1, lastProgressAt: 1, retryCount: 0}};
const detail = revision => ({...empty, runs: [run], tasks: [task], attempts: [attempt], runRevisions: {r: revision}});
async function until(check, label) {
  const deadline = Date.now() + 60000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(check(), label);
}
let server, browser, scratch, cache;
try {
  scratch = join(web, '.test-reading-continuity.local');
  cache = await mkdtemp(join(tmpdir(), 'octiq-reading-vite-'));
  await mkdir(scratch, {recursive: true});
  await writeFile(join(scratch, 'index.html'), '<html><body><div id="root"></div><script type="module" src="/.test-reading-continuity.local/entry.tsx"></script></body></html>');
  await writeFile(join(scratch, 'entry.tsx'), `import React from 'react';import{createRoot}from'react-dom/client';import{OrchestrationPanel}from'/src/components/OrchestrationPanel.tsx';import{useOrchestrationFeed}from'/src/lib/useOrchestrationSnapshot.ts';function Scene(){useOrchestrationFeed();return <OrchestrationPanel project={null} coordinatorKey="chat:a" embedded onOpenChat={()=>{}} onClose={()=>{}}/>}createRoot(document.getElementById('root')).render(<Scene/>);`);
  server = await createServer({root: web, cacheDir: join(cache, 'node_modules', '.vite'), configFile: join(web, 'vite.config.ts'), server: {host: '127.0.0.1', port: 0, strictPort: false}});
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {channel: 'chrome'}), headless: true});
  for (const width of [1280, 390]) {
    const context = await browser.newContext({viewport: {width, height: 844}});
    let socket, selected = new Set(), holdChat = false, holdDetail = false, runScene = false, revision = 'epoch:1';
    const held = [], commands = [], errors = [];
    await context.route('**/token', route => route.fulfill({body: 'fixture-token'}));
    await context.routeWebSocket(/\/ws\?/, ws => {
      socket = ws;
      ws.onMessage(raw => {
        const call = JSON.parse(String(raw));
        if (call.t !== 'invoke') return;
        commands.push(call);
        const args = call.args ?? {}, id = String(args.key ?? '').replace(/^chat:/, '');
        if ((holdChat && ['chat_page', 'chat_since'].includes(call.cmd)) || (holdDetail && call.cmd === 'orchestration_run_detail')) { held.push({ws, call}); return; }
        let result = [];
        switch (call.cmd) {
          case 'list_workspaces': result = [project]; break;
          case 'chat_index_list': result = rows; break;
          case 'chat_subscribe': selected = new Set(args.chatKeys); result = {chatKeys: args.chatKeys}; break;
          case 'orchestration_summary': result = runScene ? {...detail(revision), summary: true, tasks: [{...task, spec: ''}]} : {...empty, summary: true}; break;
          case 'orchestration_run_detail': result = detail(revision); break;
          case 'chat_page':
            assert.ok(selected.has(args.key));
            result = {events: id === 'empty' ? [] : frames(id), context: [], before: id === 'empty' ? null : 100}; break;
          case 'chat_since': assert.ok(args.after > 0, 'never replay an entire chat'); result = []; break;
          case 'chat_task': result = null; break;
          case 'resolve_paths': result = args.paths.map(() => null); break;
          case 'usage_summary': result = {sessions: [], totals: {}}; break;
        }
        ws.send(JSON.stringify({t: 'reply', id: call.id, ok: true, result}));
      });
    });
    const replyHeld = () => {
      for (const {ws, call} of held.splice(0)) ws.send(JSON.stringify({t: 'reply', id: call.id, ok: true,
        result: call.cmd === 'chat_page' ? {events: frames(call.args.key.slice(5)), context: [], before: 100} : call.cmd === 'chat_since' ? [] : detail(revision)}));
    };
    const page = await context.newPage();
    page.setDefaultTimeout(60000); page.on('pageerror', e => errors.push(String(e)));
    await page.goto(`${origin}/?token=fixture-token#/c/a`, {waitUntil: 'domcontentloaded'});
    await page.locator('.msgs').getByText('Answer a', {exact: true}).waitFor();
    await page.evaluate(() => {location.hash = '#/c/b';});
    await page.locator('.msgs').getByText('Answer b', {exact: true}).waitFor();
    for (const id of ['a', 'b', 'a']) {
      holdChat = true;
      const before = commands.length;
      await page.evaluate(id => {location.hash = '#/c/' + id;}, id);
      // The socket stays held throughout this assertion: only the retained
      // snapshot can supply these words. The old App clears them on switch.
      await page.locator('.msgs').getByText(`Answer ${id}`, {exact: true}).waitFor();
      await until(() => commands.slice(before).some(c => c.cmd === 'chat_page'), 'cached opening must probe the recent page');
      assert.equal(commands.slice(before).filter(c => c.cmd === 'chat_page').length, 1);
      holdChat = false; replyHeld();
      await until(() => commands.slice(before).some(c => c.cmd === 'chat_since'), 'cached opening must catch up its missing tail');
      assert.deepEqual(commands.slice(before).filter(c => c.cmd === 'chat_since').map(c => c.args.after), [101]);
      assert.equal(await page.locator('.msgs').getByText(`Answer ${id}`, {exact: true}).count(), 1);
    }
    // Start a slow read, leave it, then let its response arrive under chat b.
    holdChat = true;
    await page.evaluate(() => {location.hash = '#/c/slow';});
    await page.waitForFunction(() => location.hash.endsWith('/c/slow'));
    await until(() => held.some(({call}) => call.cmd === 'chat_page' && call.args.key === 'chat:slow'), 'stale-response probe must actually hold an old request');
    await page.evaluate(() => {location.hash = '#/c/b';});
    await page.locator('.msgs').getByText('Answer b', {exact: true}).waitFor();
    holdChat = false; replyHeld();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.msgs').getByText('Answer slow', {exact: true}).count(), 0);
    await page.evaluate(() => {location.hash = '#/c/empty';});
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.msgs').getByText('Answer b', {exact: true}).count(), 0);
    // Render the actual panel and hold its background refresh while worker
    // events continue to say executing. The detail DOM must not unmount.
    runScene = true;
    await page.goto(`${origin}/.test-reading-continuity.local/index.html?token=fixture-token`);
    await page.locator('.orch-run-detail').waitFor();
    await page.evaluate(() => {window.originalRunDetail = document.querySelector('.orch-run-detail');});
    holdDetail = true;
    for (let n = 2; n <= 7; n++) {
      revision = `epoch:${n}`;
      socket.send(JSON.stringify({t: 'event', event: 'orchestration-changed', payload: {runId: 'r', revision, attemptId: 'at', execution: {...attempt.execution, lastActivityAt: n}}}));
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => document.querySelector('.orch-run-detail') === window.originalRunDetail), true);
      assert.equal((await page.locator('body').innerText()).includes('Reading run'), false);
      await page.getByText('Visible worker task', {exact: true}).waitFor();
    }
    holdDetail = false; replyHeld();
    await page.waitForTimeout(1500);
    assert.equal((await page.locator('body').innerText()).includes('Reading run'), false);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({width, cachedSwitches: 3, boundedTail: true, staleChatIgnored: true, emptyChat: true, detailStayedMounted: true, errors}));
    await context.close();
  }
} finally {
  await browser?.close(); await server?.close();
  if (scratch) await rm(scratch, {recursive: true, force: true});
  if (cache) await rm(cache, {recursive: true, force: true});
}
