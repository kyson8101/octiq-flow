// Task-oriented sidebar regression with mocked backend data; no live chat is started.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../web/package.json', import.meta.url));
const { createServer } = await import(require.resolve('vite'));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const artifacts = await mkdtemp(join(tmpdir(), 'octiq-task-sidebar-'));
const server = await createServer({
  root: new URL('../web', import.meta.url).pathname,
  server: { host: '127.0.0.1', port: 0, strictPort: false },
});

const projects = [
  { id: 'pa', name: 'General', primary_path: '/test/general' },
  { id: 'pb', name: 'Atlas', primary_path: '/test/atlas' },
  { id: 'ps', name: 'Starfall', primary_path: '/test/starfall' },
  { id: 'pp', name: 'Performance', primary_path: '/test/performance' },
  { id: 'po', name: 'OctiqFlow', primary_path: '/test/octiq' },
  { id: 's1', name: 'Earlier work', shelved: true },
  { id: 's2', name: 'Experiments', shelved: true },
];
const titles = [
  'Review the workspace setup',
  'Review pull request #128',
  'Collect feedback from the latest post',
  '继续 Starfall，第 7 章先定大纲',
  'Prepare the next video for release',
  'Review the remaining pull requests',
  'Simplify the mobile project list',
];
const chats = [['a', 'pa'], ['b', 'pb'], ['c', 'pa'], ['d', 'ps'], ['e', 'ps'], ['f', 'pp'], ['g', 'po']]
  .map(([id, projectId], index) => ({
    id, projectId, title: titles[index], customTitle: true, modelId: 'claude-sonnet',
    sessionId: `session-${id}`, access: null, createdAt: Date.now() - index * 600000,
    updatedAt: Date.now() - index * 600000, pinned: id === 'd',
  }));
const snippets = [
  'The workspace is ready for the next task.',
  'The review is ready. Two changes need attention.',
  'Collected the comments and follow-up replies.',
  '先确认人物动机，再接上下一章。',
  'The export is ready for review.',
  'Three pull requests left to check.',
  'The task-first chat list is ready.',
];
const calls = [];
const errors = [];

async function mockBackend(context) {
  await context.addInitScript(({ chats, snippets }) => {
    localStorage.setItem('octiq.theme', 'fun');
    localStorage.setItem('octiq.v2.conversations', JSON.stringify(chats.map((chat, index) => ({
      ...chat,
      messages: [{ id: `m-${chat.id}`, role: 'assistant', streaming: false, blocks: [{ kind: 'text', text: snippets[index] }] }],
    }))));
  }, { chats, snippets });
  await context.route('**/token', route => route.fulfill({ body: 'mock-token' }));
  await context.route('**/auth', route => route.fulfill({ body: 'ok' }));
  await context.routeWebSocket(/.*/, socket => socket.onMessage(raw => {
    const data = JSON.parse(String(raw));
    if (data.t !== 'invoke') return;
    calls.push(data);
    let result = [];
    if (data.cmd === 'list_workspaces') result = projects;
    if (data.cmd === 'chat_index_list') result = chats;
    if (data.cmd === 'chat_index_deleted') result = [{ ...chats[0], id: 'deleted-1', title: 'Earlier conversation', deletedAt: Date.now() }];
    if (data.cmd === 'chat_page') result = { events: [], context: [], before: null };
    if (data.cmd === 'chat_search' && data.args.query === 'rotation') result = [{
      id: 'g', speaker: 'Assistant', role: 'assistant',
      excerpt: 'The retry rotation lives deep in the transcript.',
    }];
    if (data.cmd === 'chat_queue_state') result = { live: false, queuedTurnIds: [] };
    if (data.cmd === 'memory_usage') result = { totalMb: 25, procs: 1, rows: [] };
    if (data.cmd === 'usage_summary') result = { claude: { available: true, fiveHour: { percent: 100 } }, codex: { available: true, weekly: { percent: 23 } } };
    if (data.cmd === 'git_status') result = { branch: 'main', files: [] };
    socket.send(JSON.stringify({ t: 'reply', id: data.id, ok: true, result }));
  }));
}

let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    ...(process.env.OCTIQ_TEST_BROWSER ? { channel: process.env.OCTIQ_TEST_BROWSER } : {}),
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mockBackend(context);
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.on('pageerror', error => errors.push(String(error)));
  const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
  await page.goto(base + '#/p/general/c/a', { waitUntil: 'domcontentloaded' });
  await page.locator('textarea').waitFor();

  await page.getByRole('button', { name: 'Back to chats', exact: true }).tap();
  const sidebar = page.locator('.sidebar');
  await sidebar.waitFor();
  assert.equal(await page.locator('.main').isVisible(), false);
  assert.equal(await sidebar.getByRole('heading').count(), 0);
  assert.equal(await sidebar.locator('.proj-node').count(), 0, 'Project folders are removed');
  assert.equal(await sidebar.locator('.task-chat-list .chat').count(), chats.length);
  assert.equal(await sidebar.locator('.chat-title').count(), chats.length);
  assert.equal(await sidebar.locator('.chat-snippet').count(), chats.length);
  assert.equal(await sidebar.locator('.chat-project').count(), chats.length);
  assert.equal(await sidebar.locator('.chat-project').filter({ hasText: 'Starfall' }).count(), 2);
  assert.equal(await sidebar.locator('.chat-row').first().locator('.chat-title').textContent(), titles[3], 'Pinned task stays first');
  await page.screenshot({ path: join(artifacts, 'mobile-task-list.png') });

  const search = sidebar.getByRole('searchbox', { name: 'Search chats', exact: true });
  await search.fill('rotation');
  await sidebar.locator('.task-chat-list .chat').waitFor();
  assert.equal(await sidebar.locator('.task-chat-list .chat').count(), 1);
  assert.match(await sidebar.locator('.chat-snippet').textContent(), /deep in the transcript/);
  await sidebar.getByRole('button', { name: 'Clear chat search', exact: true }).tap();
  await page.waitForFunction(count => document.querySelectorAll('.task-chat-list .chat').length === count, chats.length);

  const listTrigger = page.getByRole('button', { name: 'Chat list actions', exact: true });
  const menu = page.getByRole('menu');
  await listTrigger.tap();
  assert.equal(await menu.getByRole('menuitem', { name: /^Project settings:/ }).count(), 0);
  await menu.getByRole('menuitem', { name: 'Shelved projects (2)', exact: true }).waitFor();
  await menu.getByRole('menuitem', { name: 'Deleted chats (1)', exact: true }).waitFor();
  await page.keyboard.press('Escape');

  const firstTitle = titles[3];
  const firstRow = sidebar.locator('.chat').filter({ has: page.locator('.chat-title').filter({ hasText: new RegExp(`^${firstTitle}$`) }) });
  const chatTrigger = firstRow.getByRole('button', { name: `Actions for ${firstTitle}`, exact: true });
  await chatTrigger.tap();
  await menu.getByRole('menuitem', { name: 'Rename chat', exact: true }).tap();
  const rename = page.getByRole('textbox', { name: 'Chat title', exact: true });
  await rename.fill('Plan Starfall chapter 7');
  await rename.press('Enter');
  const renamedTrigger = page.getByRole('button', { name: 'Actions for Plan Starfall chapter 7', exact: true });
  await renamedTrigger.waitFor();
  await renamedTrigger.tap();
  await menu.getByRole('menuitem', { name: 'Unpin chat', exact: true }).tap();
  await renamedTrigger.tap();
  await menu.getByRole('menuitem', { name: 'Delete chat', exact: true }).tap();
  await menu.getByRole('menuitem', { name: 'Cancel delete', exact: true }).tap();

  await page.getByRole('button', { name: 'New chat', exact: true }).tap();
  await page.locator('.main').waitFor();
  assert.equal(await sidebar.isVisible(), false);
  assert.equal(await page.getByRole('heading', { name: 'Start new chat', exact: true }).isVisible(), true);
  assert.match(await page.locator('textarea').getAttribute('placeholder'), /@project-name/);
  assert.equal(await page.locator('textarea').inputValue(), '');

  await page.setViewportSize({ width: 1280, height: 900 });
  await sidebar.waitFor();
  await listTrigger.click();
  assert.equal(await menu.getByRole('menuitem', { name: 'Hide chats', exact: true }).count(), 0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Hide chats', exact: true }).click();
  await sidebar.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Show chats', exact: true }).click();
  await sidebar.waitFor();
  await page.screenshot({ path: join(artifacts, 'desktop-task-list.png') });

  assert.deepEqual(errors, []);
  assert.equal(calls.some(call => ['chat_start', 'chat_send'].includes(call.cmd)), false);
  console.log('PASS: global three-line task list, project context, chat actions, Start new chat, and desktop collapse; no live chats modified.');
  console.log('Screenshots:', artifacts);
} finally {
  await browser?.close();
  await server.close();
}
