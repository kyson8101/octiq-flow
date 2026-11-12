// Real App first-paint regression with host reads held across refresh.
// No live backend, build, or model call. Run with PLAYWRIGHT_MODULE if needed.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { browserPaths } from './browser-paths.mjs';
const { webRoot, require, moduleUrl } = browserPaths(import.meta.url);
const { createServer } = await import(moduleUrl(require.resolve('vite')));
const { chromium } = await import(moduleUrl(process.env.PLAYWRIGHT_MODULE || 'playwright'));
const out = process.env.OCTIQ_EVIDENCE_DIR || '/tmp/octiq-sidebar-cache';
await mkdir(out, { recursive: true });
const before = process.env.SHOTS_ONLY === '1';
const now = Date.now();
const chats = Array.from({ length: 12 }, (_, i) => ({ id: i < 2 ? `lead-${i}` : `chat-${i}`, leadOf: i < 2 ? `${i}` : undefined,
  projectId: 'octiq', title: `Cached task ${i}`, latestResponse: 'Saved response from this browser.', messages: [], createdAt: now-i, updatedAt: now-i, synced: true }));
const leads = chats.slice(0,2).map((c,i) => ({ agentId: `${i}`, name: i ? 'STAR LEAD' : 'OCTIQ HEAD', chatKey: `chat:${c.id}`, cwd: '/repo', exists: true }));
const server = await createServer({ root: webRoot, configFile: `${webRoot}/vite.config.ts`, server: { host: '127.0.0.1', port: 0, strictPort: false, fs: { allow: [webRoot, realpathSync(`${webRoot}/node_modules`)] } } });
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const report = [];
try {
  await server.listen();
  for (const mode of ['off', 'tasks', 'agents']) for (const width of [1280,390]) {
    console.log(`Checking ${mode} ${width}`);
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion:'reduce' });
    let held = false, empty = false;
    let socketNow, leadAnswer = leads;
    const pending = [];
    const heldCommands = [];
    await context.addInitScript(({ chats, now }) => {
      if (!sessionStorage.getItem('seeded')) {
        localStorage.setItem('octiq.v2.conversations', JSON.stringify([...chats, { ...chats[3], id: 'deleted', title: 'DELETED MUST STAY HIDDEN' }]));
        localStorage.setItem('octiq.v2.deletedChats', JSON.stringify([{ id:'deleted', key:'chat:deleted', at:now }]));
        localStorage.setItem('octiq.v2.gitColumn', '0');
        sessionStorage.setItem('seeded','1');
      }
      window.__shifts = 0;
      new PerformanceObserver(list => { for (const e of list.getEntries()) if (!e.hadRecentInput) window.__shifts += e.value; }).observe({type:'layout-shift', buffered:true});
    }, { chats, now });
    await context.route('**/token', route=>route.fulfill({body:'stub'}));
    await context.route('**/auth', route=>route.fulfill({body:'ok'}));
    const result = cmd => {
      switch(cmd) {
        case 'list_workspaces': return [{ id:'octiq', name:'OctiqFlow', primary_path:'/repo' }];
        case 'scheduling_get': return { orientation:mode === 'agents' ? 'agents' : 'tasks', hostCap:null, live:{total:0}, lanes:[] };
        case 'lead_threads': return leadAnswer;
        case 'chat_index_list': return empty ? [] : chats.map(c=>({...c,messages:undefined}));
        case 'chat_page': return {events:[],context:[],before:null};
        case 'orchestration_summary': case 'orchestration_snapshot': return {runs:[],tasks:[],attempts:[],gates:[],messages:[]};
        case 'team_head': case 'team_front_desk': return null;
        case 'team_home': return 'octiq';
        case 'memory_usage': return {totalMb:0,procs:0,rows:[]};
        case 'chat_queue_state': return {live:false,queuedTurnIds:[]};
        case 'agent_avatar_status': return {available:false};
        case 'pr_local_list': case 'pr_remote_list': return {items:[],warnings:[]};
        default: return [];
      }
    };
    await context.routeWebSocket(/.*/, socket=>{ socketNow = socket; socket.onMessage(raw=>{
      const r=JSON.parse(String(raw)); if(r.t!=='invoke') return;
      const answer=()=>socket.send(JSON.stringify({t:'reply',id:r.id,ok:true,result:result(r.cmd)}));
      if(held && ['scheduling_get','lead_threads','list_workspaces','chat_index_list','chat_index_deleted'].includes(r.cmd)) { pending.push(answer); heldCommands.push(r.cmd); } else answer();
    }); });
    const page = await context.newPage();
    const errors=[]; page.on('pageerror', e=>errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
    await page.evaluate(mode=>localStorage.setItem('octiq.agentsMode',mode==='off'?'off':'on'),mode);
    await page.reload();
    await page.locator(mode==='agents'?'.lead-row':'.chat-title').first().waitFor({state:'attached'});
    console.log('Warm navigation ready');
    // Recreate large transcript persistence while the shared origin is near quota.
    const sizes = await page.evaluate(async chats=>{
      const {saveConversations,loadConversations} = await import('/src/lib/store.ts');
      let lo=0,hi=6*1024*1024;
      while(lo+1<hi) { const mid=Math.floor((lo+hi)/2); try {localStorage.setItem('quota-fixture','q'.repeat(mid));lo=mid;}catch{hi=mid;} }
      localStorage.setItem('quota-fixture','q'.repeat(Math.max(0,lo-32*1024)));
      const huge=chats.map((c,i)=>({...c,seq:42000,messages:i<2?[{id:'m',role:'assistant',streaming:false,blocks:[{kind:'text',text:'x'.repeat((i?23:10)*1024*1024)}]}]:[]}));
      saveConversations(huge);
      return { cachedRows:loadConversations().length, cacheChars:localStorage.getItem('octiq.v2.conversations').length, originChars:Object.entries(localStorage).reduce((n,[k,v])=>n+k.length+v.length,0) };
    },chats);
    held=true;
    await page.reload();
    await page.locator('.task-sidebar').waitFor({state:'attached'});
    if (width === 390) await page.locator('.topbar-nav').click();
    await page.waitForTimeout(250);
    const rows=await page.locator(mode==='agents'?'.lead-row':'.chat-title').count();
    await page.screenshot({path:`${out}/${mode}-${width}-held.png`});
    report.push({mode,width,rows,...sizes,heldCommands:[...new Set(heldCommands)],cls:await page.evaluate(()=>window.__shifts),errors});
    if(before) assert.equal(rows,mode==='off'?12:0,'baseline should expose the scheduling gate');
    if(!before) {
      assert.equal(rows,mode==='agents'?2:12,JSON.stringify(report.at(-1)));
      assert.equal(await page.locator(mode==='agents'?'.lead-row':'.chat-title').first().isVisible(),true);
      assert.equal(await page.getByText('DELETED MUST STAY HIDDEN').count(),0);
      assert.equal(sizes.cachedRows,12);
    }
    // An empty first index response must retain the cached list; revalidation
    // of the navigation identity must preserve its geometry.
    const box = await page.locator('.task-sidebar').boundingBox();
    const first = rows ? await page.locator(mode==='agents'?'.lead-row':'.chat-title').first().boundingBox() : null;
    empty=true; held=false; pending.splice(0).forEach(fn=>fn());
    await page.waitForTimeout(400);
    if(!before) {
      assert.equal(await page.locator(mode==='agents'?'.lead-row':'.chat-title').count(),mode==='agents'?2:12);
      assert.deepEqual(await page.locator('.task-sidebar').boundingBox(),box);
      assert.deepEqual(await page.locator(mode==='agents'?'.lead-row':'.chat-title').first().boundingBox(),first);
      assert.equal(errors.length,0,errors.join('\n'));
    }
    await page.screenshot({path:`${out}/${mode}-${width}-reconciled.png`});
    if(!before) {
      if(mode==='agents') {
        leadAnswer=[];
        socketNow.send(JSON.stringify({t:'event',event:'team-changed',payload:{}}));
        await page.waitForFunction(()=>document.querySelectorAll('.lead-row').length===0);
        assert.equal(await page.getByText('No leads configured.').count(),1);
        // An empty authoritative roster replaces the saved identities too.
        assert.equal(await page.evaluate(()=>localStorage.getItem('octiq.v2.leadThreads')),'[]');
      } else {
        socketNow.send(JSON.stringify({t:'event',event:'chat-index-changed',payload:{id:'chat-3',gone:true,entry:null}}));
        await page.waitForFunction(()=>document.querySelectorAll('.chat-title').length===11);
      }
    }
    await context.close();
  }
  await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} finally { await browser.close(); await server.close(); }
