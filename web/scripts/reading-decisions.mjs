// Component regression for retained Run detail: display is not permission.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';

export async function readingDecisions(browser, origin, scratch) {
  await writeFile(join(scratch, 'decisions.html'), '<html><body><div id="root"></div><script type="module" src="/.test-reading-continuity.local/decisions.tsx"></script></body></html>');
  await writeFile(join(scratch, 'decisions.tsx'), `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{OrchestrationPanel}from'/src/components/OrchestrationPanel.tsx';import{RunDetailOnScreen,useOrchestrationFeed}from'/src/lib/useOrchestrationSnapshot.ts';import{orchestrationFeed}from'/src/lib/orchestrationFeed.ts';window.feed=orchestrationFeed;function Scene(){useOrchestrationFeed();const[shown,setShown]=useState(true);return <><button onClick={()=>setShown(!shown)}>{shown?'Hide review':'Show review'}</button><div hidden={!shown}><RunDetailOnScreen value={shown}><OrchestrationPanel project={null} coordinatorKey="chat:lead" embedded onOpenChat={()=>{}} onClose={()=>{}}/></RunDetailOnScreen></div></>}createRoot(document.getElementById('root')).render(<Scene/>);`);
  const empty = {runs: [], tasks: [], attempts: [], gates: [], messages: [], notifications: [], reports: {}};
  const run = {id: 'r', objective: 'Review mission', coordinatorChatKey: 'chat:lead', workspaceId: 'p', workspaceMode: 'mission', rootPath: '/fixture', status: 'running', maxConcurrent: 1, createdAt: 1, updatedAt: 1};
  const task = {id: 't', runId: 'r', title: 'Review task', spec: 'Retained task brief', dependsOn: [], status: 'ready', assignee: {id: 'maya', name: 'Maya'}, createdAt: 1, updatedAt: 1};
  const gate = {id: 'g', runId: 'r', createdByChatKey: 'chat:worker', targetChatKey: 'chat:lead', kind: 'decision', question: 'Review gate?', options: ['Yes'], status: 'open', awaits: 'person', createdAt: 1};
  const failures = [];
  for (const width of [1280, 390]) {
    const context = await browser.newContext({viewport: {width, height: 844}});
    let socket, hold = false, revision = 'epoch:1';
    const held = [], commands = [], errors = [];
    const full = token => ({...empty, runs: [run], tasks: [task], gates: [gate], runRevisions: {r: token}});
    await context.route('**/token', r => r.fulfill({body: 'fixture-token'}));
    await context.routeWebSocket(/\/ws\?/, ws => {
      socket = ws;
      ws.onMessage(raw => {
        const call = JSON.parse(String(raw));
        if (call.t !== 'invoke') return;
        commands.push(call);
        if (hold && call.cmd === 'orchestration_run_detail') { held.push(call); return; }
        let result = [];
        if (call.cmd === 'orchestration_summary') result = {...full(revision), summary: true, tasks: [{...task, spec: ''}]};
        if (call.cmd === 'orchestration_run_detail') result = full(revision);
        if (call.cmd === 'orchestration_destinations') result = {projects: [{id: 'p', name: 'Fixture', reports: [{id: 'maya', name: 'Maya'}, {id: 'noah', name: 'Noah'}]}]};
        ws.send(JSON.stringify({t: 'reply', id: call.id, ok: true, result}));
      });
    });
    const reply = async token => {
      const deadline = Date.now() + 15000;
      while (!held.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      assert.ok(held.length, 'the detail read must actually be held');
      for (const call of held.splice(0)) socket.send(JSON.stringify({t: 'reply', id: call.id, ok: true, result: full(token)}));
    };
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', e => errors.push(String(e)));
    const count = command => commands.filter(c => c.cmd === command).length;
    try {
      await page.goto(`${origin}/.test-reading-continuity.local/decisions.html?token=fixture-token`);
      const opener = page.getByRole('button', {name: 'Reassign task: Review task', exact: true});
      const send = page.getByRole('button', {name: 'Reassign', exact: true});
      await opener.waitFor();
      await page.waitForFunction(() => window.feed.getState().details?.has('r') && !window.feed.getState().detailPending?.has('r'));
      const release = async () => {
        await page.getByRole('button', {name: 'Hide review', exact: true}).click();
        await page.waitForFunction(() => window.feed.getState().details?.size === 0);
        hold = true;
        await page.getByRole('button', {name: 'Show review', exact: true}).click();
        await page.waitForFunction(() => window.feed.getState().detailPending?.has('r'));
        await page.waitForFunction(() => window.feed.getState().details?.has('r'));
      };
      const blocked = async formOpen => {
        assert.equal((await page.locator('body').innerText()).includes('Reading run'), false);
        const gateButton = page.getByRole('button', {name: 'Yes', exact: true});
        assert.equal(await gateButton.getAttribute('aria-disabled'), 'true');
        await gateButton.click({force: true});
        assert.equal(count('orchestration_gate_resolve'), 0);
        assert.equal(await opener.isDisabled(), true, `${width}: pending Reassign opener`);
        if (formOpen) {
          assert.equal(await send.isDisabled(), true, `${width}: already-open form must be held`);
          // Invoke the component callback directly as well: the submit handler
          // must refuse independently of the DOM button's disabled attribute.
          await send.evaluate(button => button[Object.keys(button).find(k => k.startsWith('__reactProps'))].onClick());
          assert.equal(count('orchestration_task_reassign'), 0);
        }
        await page.locator('.orch-settings-toggle').click();
        const stop = page.getByRole('button', {name: 'Stop', exact: true});
        assert.equal(await stop.isEnabled(), true);
        await stop.click();
        assert.equal(await page.locator('.orch-stop-confirm').getByRole('button', {name: 'Stop', exact: true}).isEnabled(), true);
        assert.equal(await page.getByRole('button', {name: 'Stop and archive', exact: true}).isDisabled(), true);
        await page.locator('.orch-stop-confirm').getByRole('button', {name: 'Cancel', exact: true}).click();
        await page.locator('.orch-settings-toggle').click();
      };
      await release();
      await blocked(false);
      await reply(revision); hold = false;
      await page.waitForFunction(() => !window.feed.getState().detailPending?.has('r'));
      await opener.click();
      await page.locator('.mission-reassign select').selectOption('noah');
      await page.getByPlaceholder('Maya is out; Noah takes over').fill('Review pending-detail decision');
      // Invalidation must hold the open form even when the revision has not
      // changed (the f5e6160 path); cached matching evidence is insufficient.
      hold = true;
      socket.send(JSON.stringify({t: 'event', event: 'orchestration-changed', payload: {runId: 'r', revision}}));
      await page.waitForFunction(() => window.feed.getState().detailPending?.has('r'));
      await blocked(true);
      await reply(revision); hold = false;
      await page.waitForFunction(() => !window.feed.getState().detailPending?.has('r'));
      // Same-run invalidation, with an obsolete read arriving before the exact
      // revision. The open form must stay held throughout both states.
      hold = true; revision = 'epoch:2';
      socket.send(JSON.stringify({t: 'event', event: 'orchestration-changed', payload: {runId: 'r', revision}}));
      await page.waitForFunction(() => window.feed.getState().detailPending?.has('r'));
      await blocked(true);
      await page.waitForFunction(() => window.feed.getState().snapshot?.runRevisions?.r === 'epoch:2');
      await reply('epoch:1');
      await page.waitForFunction(() => !window.feed.getState().detailPending?.has('r'));
      assert.equal(await send.isDisabled(), true, 'mismatching revision cannot authorize submission');
      assert.equal(count('orchestration_task_reassign'), 0);
      socket.send(JSON.stringify({t: 'event', event: 'orchestration-changed', payload: {runId: 'r', revision}}));
      await page.waitForFunction(() => window.feed.getState().detailPending?.has('r'));
      await reply(revision); hold = false;
      await page.waitForFunction(() => !window.feed.getState().detailPending?.has('r'));
      await send.click();
      await page.waitForFunction(() => !document.querySelector('.mission-reassign'));
      assert.equal(count('orchestration_task_reassign'), 1);
      assert.equal(count('orchestration_gate_resolve'), 0);
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({width, pendingReassignRPC: 0, pendingGateRPC: 0, stopAvailable: true, exactRevisionReassignRPC: 1, openFormHeld: true, sameRunInvalidation: true}));
    } catch (error) {
      failures.push(error);
      console.error(`${width}: ${error.message}`);
    } finally { await context.close(); }
  }
  if (failures.length) throw new AggregateError(failures, 'Run decision continuity failed');
}
