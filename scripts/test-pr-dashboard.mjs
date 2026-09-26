// Browser integration checks against synthetic RPC data. No real agent, PR,
// ticket, or project is modified. PLAYWRIGHT_MODULE can point to an isolated
// Playwright installation; OCTIQ_TEST_BROWSER defaults to installed Chrome.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../web/package.json', import.meta.url));
const { createServer } = await import(require.resolve('vite'));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const artifacts = await mkdtemp(join(tmpdir(), 'octiq-pr-dashboard-'));
const server = await createServer({
  root: new URL('../web', import.meta.url).pathname,
  server: { host: '127.0.0.1', port: 0, strictPort: false },
});
const root = '/test/octiq';
const headSha = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);
const mergeBaseSha = 'c'.repeat(40);
const project = { id: 'project', name: 'OctiqFlow', primary_path: root, paths: [root] };
const localPr = {
  id: 'local:feature/task', source: 'local', root, title: 'Keep task completion tied to its commit',
  number: null, url: null, state: 'local', branch: 'feature/task', base: 'develop',
  headSha, baseSha, author: 'Mira', updatedAt: '2026-09-24T09:00:00Z', commitCount: 2,
  additions: 12, deletions: 3, changedFiles: 2, reviewDecision: '', approved: false,
  worktreePath: '/test/worktrees/task',
};
const remotePr = {
  ...localPr, id: 'github:17', source: 'github', number: 17, state: 'open',
  title: 'Prevent stale task completion', url: 'https://github.com/example/octiq/pull/17',
  reviewDecision: 'APPROVED', approved: true,
};
const secondRemotePr = { ...remotePr, id: 'github:18', number: 18, title: 'Add worker summary', url: 'https://github.com/example/octiq/pull/18' };
const patch = '@@ -1,2 +1,3 @@\n const task = loadTask();\n-return task.done;\n+return task.done && task.head === currentHead;\n+++count;\n';
const files = [
  { path: 'src/task.ts', oldPath: null, status: 'modified', additions: 2, deletions: 1, binary: false, patch: null, patchUnavailable: null },
  { path: 'assets/mark.png', oldPath: null, status: 'modified', additions: 0, deletions: 0, binary: true, patch: null, patchUnavailable: 'Binary file' },
];
const chats = [{
  id: 'source-chat', projectId: project.id, title: 'Implement task completion', customTitle: true,
  modelId: 'codex:sol', sessionId: null, access: 'auto', cwd: '/test/worktrees/task',
  createdAt: 1, updatedAt: 2, pinned: false,
}];
const calls = [];
const errors = [];
const liveChats = new Set();
const finishChats = new Map();
let workflow = null;
let failNextLaunch = false;
let competeNextAttach = false;
let remoteFailure = false;
let holdNextWorkflowSave = false;
let releaseWorkflowSave;

async function mockBackend(context) {
  await context.addInitScript(({ chats }) => {
    localStorage.setItem('octiq.theme', 'dark');
    localStorage.setItem('octiq.v2.model', 'codex:sol');
    localStorage.setItem('octiq.v2.gitColumn', '0');
    localStorage.setItem('octiq.v2.conversations', JSON.stringify(chats.map(chat => ({ ...chat, messages: [] }))));
  }, { chats });
  await context.route('**/token', route => route.fulfill({ body: 'mock-token' }));
  await context.route('**/auth', route => route.fulfill({ body: 'ok' }));
  await context.routeWebSocket(/.*/, socket => socket.onMessage(raw => {
    const data = JSON.parse(String(raw));
    if (data.t !== 'invoke') return;
    calls.push(data);
    const args = data.args ?? {};
    let result = [];
    let error;
    switch (data.cmd) {
      case 'list_workspaces': result = [project]; break;
      case 'chat_index_list': result = chats; break;
      case 'chat_index_save': {
        const index = chats.findIndex(chat => chat.id === args.meta.id);
        if (index >= 0) chats[index] = args.meta; else chats.push(args.meta);
        result = null;
        break;
      }
      case 'chat_page': result = { events: [], context: [], before: null }; break;
      case 'chat_queue_state': result = { live: liveChats.has(args.key), queuedTurnIds: [] }; break;
      case 'chat_task': result = { chatId: args.chatId, prCompletion: workflow?.completion.state === 'completed' && args.chatId === workflow.chatId ? { root, number: 17, url: remotePr.url, headSha, trigger: workflow.completeOn, completedAt: 3 } : null }; break;
      case 'agent_installs': result = [{ id: 'codex', installed: true, path: '/test/codex' }]; break;
      case 'orchestration_snapshot': result = { runs: [], tasks: [], attempts: [], gates: [], messages: [], reports: {} }; break;
      case 'sandbox_snapshot': result = { defaultEnabled: false, environments: {} }; break;
      case 'git_branches': result = { is_repo: true, current: 'feature/task', branches: ['develop', 'feature/task'], is_worktree: true }; break;
      case 'git_status_summary': result = (args.paths ?? []).map(path => ({ path, repo_root: root, branch: 'feature/task', changed: 0, insertions: 0, deletions: 0, ahead: 2, behind: 0, is_repo: true })); break;
      case 'pr_repositories': result = [{ root, name: 'octiq', branches: ['develop', 'feature/task'], defaultBase: 'develop' }]; break;
      case 'pr_local_list': result = { items: [localPr], warnings: [] }; break;
      case 'pr_remote_list':
        if (remoteFailure) error = 'GitHub is unavailable. Local comparisons are still available.';
        else result = { items: [remotePr, secondRemotePr], warnings: [] };
        break;
      case 'pr_detail': result = { pr: args.source === 'local' ? localPr : args.number === 18 ? secondRemotePr : remotePr, body: 'Keep completion tied to the exact reviewed commit.', files: files.map(file => ({ ...file, patch: args.source === 'github' && !file.binary ? patch : null })), commits: [{ sha: headSha, title: 'Verify completion snapshot', author: 'Mira' }], mergeBaseSha, warnings: [] }; break;
      case 'pr_file_diff': result = { text: patch, binary: false, tooLarge: false }; break;
      case 'pr_workflow_get': result = args.number === 17 ? workflow : null; break;
      case 'pr_workflow_save': {
        const complete = args.completeOn === 'approved';
        workflow = { root, number: 17, url: remotePr.url, headSha, baseSha, chatId: args.chatId, ticket: args.ticket, completeOn: args.completeOn, completion: { state: complete ? 'completed' : 'pending', trigger: args.completeOn, headSha, completedAt: complete ? 3 : null, note: complete ? 'Approved at this head.' : 'Waiting for merge.' }, ticketAction: null, updatedAt: 3 };
        result = workflow;
        break;
      }
      case 'pr_completion_refresh': result = workflow; break;
      case 'pr_ticket_prepare':
        if (!workflow?.ticket || workflow.completion.state !== 'completed') error = 'Complete the PR first.';
        else {
          workflow = { ...workflow, ticketAction: workflow.ticketAction && workflow.ticketAction.status !== 'failed' ? workflow.ticketAction : { id: `action-${calls.length}`, headSha, status: 'pending', chatId: null, message: '', updatedAt: 4 } };
          result = { workflow, actionId: workflow.ticketAction.id, prompt: `Complete Workspace ticket ${workflow.ticket.reference} for ${remotePr.url}.`, cwd: root, title: 'Complete linked ticket' };
        }
        break;
      case 'pr_ticket_attach':
        if (competeNextAttach) {
          competeNextAttach = false;
          chats.push({ ...chats.find(chat => chat.id === args.chatId), id: 'winning-ticket-chat', title: 'Existing ticket agent' });
          workflow = { ...workflow, ticketAction: { ...workflow.ticketAction, status: 'running', chatId: 'winning-ticket-chat' } };
          socket.send(JSON.stringify({ t: 'event', event: 'chat-index-changed', payload: {} }));
          error = 'Already attached to another chat.';
        }
        else if (!workflow?.ticketAction || !chats.some(chat => chat.id === args.chatId)) error = 'Save completion chat first.';
        else if (workflow.ticketAction.chatId && workflow.ticketAction.chatId !== args.chatId) error = 'Already attached.';
        else { workflow.ticketAction = { ...workflow.ticketAction, status: 'running', chatId: args.chatId }; result = workflow; }
        break;
      case 'pr_ticket_confirm':
        workflow.ticketAction = { ...workflow.ticketAction, status: args.confirmed ? 'confirmed' : 'failed', message: args.message };
        result = workflow;
        break;
      case 'chat_start':
        if (failNextLaunch) { failNextLaunch = false; error = 'Test agent startup failed'; }
        else {
          assert(chats.some(chat => `chat:${chat.id}` === args.key), 'chat must be durable before process start');
          liveChats.add(args.key); result = null;
          finishChats.set(args.key, () => {
            liveChats.delete(args.key);
            socket.send(JSON.stringify({ t: 'event', event: 'chat-event', payload: { key: args.key, event: { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } } } }));
            socket.send(JSON.stringify({ t: 'event', event: 'chat-status', payload: { key: args.key, kind: 'exit', text: '', code: 0 } }));
          });
        }
        break;
    }
    const response = JSON.stringify({ t: 'reply', id: data.id, ok: !error, ...(error ? { error } : { result }) });
    if (data.cmd === 'pr_workflow_save' && holdNextWorkflowSave) {
      holdNextWorkflowSave = false;
      releaseWorkflowSave = () => socket.send(response);
    } else socket.send(response);
  }));
}

let browser;
let page;
try {
  await server.listen();
  browser = await chromium.launch({ channel: process.env.OCTIQ_TEST_BROWSER || 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });
  await mockBackend(context);
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(String(error)));
  const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
  await page.goto(base + '#/p/octiqflow/c/source-chat');
  await page.getByRole('button', { name: 'Pull requests', exact: true }).click();
  const dashboard = page.getByRole('region', { name: 'Pull requests dashboard' });
  await dashboard.getByRole('listitem').filter({ hasText: localPr.title }).click();
  await dashboard.getByRole('heading', { name: localPr.title }).waitFor();
  const overviewTab = dashboard.getByRole('tab', { name: 'Overview', exact: true });
  const filesTab = dashboard.getByRole('tab', { name: /Files changed/ });
  const commitsTab = dashboard.getByRole('tab', { name: /Commits/ });
  await overviewTab.focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await commitsTab.getAttribute('aria-selected'), 'true', 'left arrow wraps to the last tab');
  await page.keyboard.press('Home');
  assert.equal(await overviewTab.getAttribute('aria-selected'), 'true');
  await page.keyboard.press('End');
  assert.equal(await commitsTab.getAttribute('aria-selected'), 'true');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  assert.equal(await filesTab.getAttribute('aria-selected'), 'true');
  assert.equal(await filesTab.getAttribute('tabindex'), '0');
  assert.equal(await overviewTab.getAttribute('tabindex'), '-1');
  assert.equal(await filesTab.evaluate(element => element === document.activeElement), true);
  const filesPanel = dashboard.getByRole('tabpanel', { name: /Files changed/ });
  assert.equal(await filesTab.getAttribute('aria-controls'), await filesPanel.getAttribute('id'));
  assert.equal(await filesPanel.getAttribute('aria-labelledby'), await filesTab.getAttribute('id'));
  assert.equal(await dashboard.getByRole('tabpanel').count(), 1, 'only the selected panel is visible');
  await dashboard.getByRole('table', { name: 'Unified diff' }).waitFor();
  assert(calls.some(call => call.cmd === 'pr_file_diff' && call.args.baseSha === mergeBaseSha && call.args.headSha === headSha));
  const increment = dashboard.getByRole('row').filter({ hasText: '+++count;' });
  assert.equal(await increment.getAttribute('data-kind'), 'add');
  assert.equal(await increment.locator('.pr-line-no').nth(1).innerText(), '3');
  await dashboard.getByRole('button', { name: /assets\/mark.png/ }).click();
  await dashboard.getByText('Binary file. A text diff is not available.', { exact: true }).waitFor();
  await dashboard.getByRole('button', { name: /src\/task.ts/ }).click();
  await dashboard.getByRole('table', { name: 'Unified diff' }).waitFor();
  await page.screenshot({ path: join(artifacts, 'local-diff-desktop.png') });

  await dashboard.getByRole('button', { name: /^Study/ }).click();
  await dashboard.getByText(/started in a separate chat/).waitFor();
  const study = calls.find(call => call.cmd === 'chat_start');
  assert(study, 'Study launches an agent');
  assert.notEqual(study.args.key, 'chat:source-chat');
  assert.equal(study.args.cwd, localPr.worktreePath);
  assert.equal(study.args.model, 'gpt-5.6-sol');
  assert.equal(study.args.access, 'read');
  assert(study.args.prompt.includes(headSha));
  assert(study.args.prompt.includes(baseSha));
  assert.equal(calls.some(call => ['git_switch_branch', 'git_prepare_chat_workspace', 'chat_stop', 'chat_interrupt'].includes(call.cmd)), false);

  await dashboard.getByRole('button', { name: /^GitHub/ }).click();
  await dashboard.getByRole('listitem').filter({ hasText: remotePr.title }).click();
  await dashboard.getByRole('tab', { name: 'Overview', exact: true }).click();
  await dashboard.getByLabel('Originating chat').selectOption('source-chat');
  await dashboard.getByLabel('Ticket reference', { exact: true }).fill('T26050092');
  assert.equal(await dashboard.getByRole('radio', { name: /PR is merged/ }).isChecked(), true);
  await dashboard.getByRole('button', { name: 'Save tracking', exact: true }).click();
  await dashboard.getByText('Waiting for merge.', { exact: true }).first().waitFor();
  assert.equal(await dashboard.getByRole('button', { name: 'Start ticket update', exact: true }).count(), 0);
  holdNextWorkflowSave = true;
  await dashboard.getByRole('radio', { name: 'Current head is approved', exact: true }).check();
  await dashboard.getByRole('button', { name: 'Save tracking', exact: true }).click();
  await page.waitForTimeout(100);
  assert(releaseWorkflowSave, 'delayed save must reach the backend');
  const anotherPr = dashboard.getByRole('listitem').filter({ hasText: secondRemotePr.title });
  if (await anotherPr.isEnabled()) {
    await anotherPr.click();
    await dashboard.getByRole('heading', { name: secondRemotePr.title }).waitFor();
    releaseWorkflowSave();
    await page.waitForTimeout(150);
    assert.equal(await dashboard.getByLabel('Originating chat').inputValue(), '', 'old save must not populate another PR form');
    assert.equal(await dashboard.getByLabel('Ticket reference', { exact: true }).inputValue(), '');
    await dashboard.getByRole('listitem').filter({ hasText: remotePr.title }).click();
  } else releaseWorkflowSave();
  await dashboard.getByRole('button', { name: 'Start ticket update', exact: true }).waitFor();
  const raceStart = calls.length;
  competeNextAttach = true;
  await dashboard.getByRole('button', { name: 'Start ticket update', exact: true }).click();
  await dashboard.getByText(/Another browser already claimed/).waitFor();
  assert(calls.slice(raceStart).some(call => call.cmd === 'pr_workflow_get'), 'rejected claim reloads authoritative workflow');
  assert.equal(calls.slice(raceStart).some(call => ['chat_start', 'pr_ticket_confirm'].includes(call.cmd)), false, 'loser cannot start or fail the winning action');
  await page.getByRole('button', { name: /Existing ticket agent/ }).first().waitFor();
  await dashboard.getByRole('button', { name: 'Open chat', exact: true }).click();
  await page.waitForURL(/winning-ticket-chat/);
  await page.getByRole('button', { name: 'Pull requests', exact: true }).click();
  await dashboard.getByRole('button', { name: /^GitHub/ }).click();
  await dashboard.getByRole('listitem').filter({ hasText: remotePr.title }).click();
  await dashboard.getByRole('button', { name: 'Mark failed', exact: true }).click();
  failNextLaunch = true;
  await dashboard.getByRole('button', { name: 'Retry ticket update', exact: true }).click();
  await dashboard.getByText(/Could not start ticket completion/).first().waitFor();
  await dashboard.getByRole('button', { name: 'Retry ticket update', exact: true }).waitFor();
  assert.equal(workflow.ticketAction.status, 'failed');
  await dashboard.getByRole('button', { name: 'Retry ticket update', exact: true }).click();
  await dashboard.getByText(/The agent turn is still running/).waitFor();
  const ticketChatId = workflow.ticketAction.chatId;
  const attachedAt = calls.findIndex(call => call.cmd === 'pr_ticket_attach' && call.args.chatId === ticketChatId);
  const savedAt = calls.findIndex(call => call.cmd === 'chat_index_save' && call.args.meta.id === ticketChatId);
  const launchedAt = calls.findIndex(call => call.cmd === 'chat_start' && call.args.key === `chat:${ticketChatId}`);
  assert(savedAt < attachedAt && attachedAt < launchedAt, 'save -> claim -> launch prevents duplicate ticket agents');
  assert.equal(await dashboard.getByRole('button', { name: 'Confirm ticket updated', exact: true }).count(), 0);
  finishChats.get(`chat:${ticketChatId}`)();
  await dashboard.getByRole('button', { name: 'Confirm ticket updated', exact: true }).waitFor();
  assert.equal(await dashboard.getByRole('button', { name: 'Confirm ticket updated', exact: true }).isDisabled(), true);
  await dashboard.getByRole('checkbox', { name: /I checked the ticket/ }).check();
  await dashboard.getByRole('button', { name: 'Confirm ticket updated', exact: true }).click();
  await dashboard.getByText(/User.confirmed/).first().waitFor();
  assert.equal(workflow.ticketAction.status, 'confirmed');
  await page.screenshot({ path: join(artifacts, 'github-completion-desktop.png') });

  remoteFailure = true;
  await dashboard.getByRole('combobox', { name: /^State/ }).selectOption('all');
  await dashboard.getByText('GitHub is unavailable', { exact: true }).waitFor();
  await dashboard.getByRole('group', { name: 'Pull request source' }).getByRole('button', { name: /^Local/ }).click();
  await dashboard.getByRole('listitem').filter({ hasText: localPr.title }).click();
  await dashboard.getByRole('heading', { name: localPr.title }).waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(artifacts, 'github-mobile.png') });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  assert.equal(overflow, false, 'mobile dashboard must not overflow the viewport');
  await page.screenshot({ path: join(artifacts, 'dashboard.png') });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, artifacts, calls: calls.map(call => call.cmd) }, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {});
  console.error(`Artifacts: ${artifacts}`);
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
