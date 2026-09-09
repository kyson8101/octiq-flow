// Run against the Vite dev server. All HTTP auth and WebSocket RPCs are mocked;
// this script never starts real agents or writes to a real project.
// PLAYWRIGHT_MODULE may name an isolated installation's absolute index.mjs.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const artifacts = await mkdtemp(join(tmpdir(), 'octiq-split-test-'));
const base = process.env.OCTIQ_TEST_URL || 'http://127.0.0.1:5273/';
import assert from 'node:assert/strict';
const browser = await chromium.launch({channel:process.env.OCTIQ_TEST_BROWSER || 'chrome',headless:true});
const context = await browser.newContext({viewport:{width:1600,height:1000}, reducedMotion:'reduce'});
const projects = [{id:'pa',name:'Project Alpha',primary_path:'/test/alpha'},{id:'pb',name:'Project Beta',primary_path:'/test/beta'}];
const chats = [{id:'a',projectId:'pa',title:'Alpha chat'},{id:'b',projectId:'pb',title:'Beta chat'},{id:'c',projectId:'pa',title:'Another chat'}].map(c=>({...c,modelId:'claude-sonnet',sessionId:null,access:null,createdAt:1,updatedAt:2,pinned:false}));
const calls=[]; const errors=[];
await context.route('**/token',r=>r.fulfill({body:'mock-token'}));
await context.route('**/auth',r=>r.fulfill({body:'ok'}));
await context.routeWebSocket(/.*/, ws=>ws.onMessage(raw=>{
 const data=JSON.parse(String(raw)); if(data.t!=='invoke') return;
 calls.push(data);
 let result=[];
 if(data.cmd==='list_workspaces') result=projects;
 if(data.cmd==='chat_index_list') result=chats;
 if(data.cmd==='chat_page') result={events:[],context:[],before:null};
 if(data.cmd==='chat_queue_state') result={live:false,queuedTurnIds:[]};
 if(data.cmd==='git_status') result={branch:'main',files:[]};
 ws.send(JSON.stringify({t:'reply',id:data.id,ok:true,result}));
}));
const page=await context.newPage(); page.on('pageerror',e=>errors.push(String(e)));
await page.goto(base + '#/p/project-alpha/c/a');
const left=()=>page.frameLocator('iframe[title="Left chat workspace"]');
const right=()=>page.frameLocator('iframe[title="Right chat workspace"]');
await left().locator('textarea').waitFor();
await left().locator('textarea').fill('left draft');
await left().getByRole('button',{name:'Open chat beside',exact:true}).click();
await left().getByRole('dialog').getByRole('button',{name:'Project Beta Beta chat'}).click();
await right().locator('textarea').waitFor();
await page.waitForFunction(()=>location.hash.includes('left=a&right=b'));
assert.equal(await left().locator('textarea').inputValue(),'left draft');
await right().locator('textarea').fill('right draft');
await page.waitForFunction(()=>location.hash.includes('focus=right'));
await page.screenshot({path:join(artifacts,'split.png')});
// Navigate only the left pane while the right keeps its draft and document.
await left().locator('.topbar-title').click();
await left().locator('.chat-title').filter({hasText:'Another chat'}).click();
await page.waitForFunction(()=>location.hash.includes('left=c&right=b'));
assert.equal(await right().locator('textarea').inputValue(),'right draft');
await page.goBack();
await page.waitForFunction(()=>location.hash.includes('left=a&right=b'));
await left().locator('textarea').waitFor();
assert.equal(await left().locator('textarea').inputValue(),'left draft');
await right().locator('textarea').click();
// Close to left, navigate away, and restore the remembered split.
await page.locator('.layout-pane').first().getByRole('button',{name:'Only this chat'}).click();
await page.waitForFunction(()=>!location.hash.startsWith('#/split'));
await page.getByRole('button',{name:'Return to split chat'}).click();
await right().locator('textarea').waitFor();
assert.equal(await right().locator('textarea').inputValue(),'right draft');
assert.equal(await left().locator('textarea').inputValue(),'left draft');
// Browser Back / Forward restore a split without losing the hidden pane.
await page.goBack();
await page.getByRole('button',{name:'Return to split chat'}).waitFor();
await page.goForward();
await right().locator('textarea').waitFor();
assert.equal(await right().locator('textarea').inputValue(),'right draft');
await page.reload();
await right().locator('textarea').waitFor();
await page.waitForFunction(()=>location.hash.includes('left=a&right=b&focus=right'));
// Sending from each independent composer must carry its own cwd and chat key.
await left().locator('textarea').fill('mock alpha'); await left().locator('textarea').press('Enter');
await right().locator('textarea').fill('mock beta'); await right().locator('textarea').press('Enter');
await page.waitForTimeout(300);
const starts=calls.filter(c=>c.cmd==='chat_start');
assert(starts.some(c=>c.args.key==='chat:a'&&c.args.cwd==='/test/alpha'));
assert(starts.some(c=>c.args.key==='chat:b'&&c.args.cwd==='/test/beta'));
assert(!starts.some(c=>c.args.key==='chat:a'&&c.args.cwd==='/test/beta'));
// Stop is scoped to the pane's own agent; the other composer stays busy.
await left().getByRole('button',{name:'Stop',exact:true}).click();
await page.waitForTimeout(100);
assert.deepEqual(calls.filter(c=>c.cmd==='chat_interrupt').map(c=>c.args.key),['chat:a']);
assert(await right().getByRole('button',{name:'Stop',exact:true}).isVisible());
// A same-origin message from an unrelated window cannot mutate the layout.
const beforeSpoof = page.url();
await page.evaluate(()=>window.postMessage({type:'octiq-pane',action:'beside',chat:'spoof'},location.origin));
await page.waitForTimeout(100);
assert.equal(page.url(),beforeSpoof);
// Keyboard resizing is persisted locally, not in the shared URL.
await page.getByRole('separator').focus();
await page.getByRole('separator').press('ArrowLeft');
assert.equal(await page.getByRole('separator').getAttribute('aria-valuenow'),'45');
assert(!page.url().includes('width'));
const missing = await context.newPage();
await missing.goto(base + '#/split?left=a&right=missing&focus=right');
await missing.frameLocator('iframe[title="Right chat workspace"]').getByRole('heading',{name:'Chat unavailable'}).waitFor();
assert(missing.url().includes('right=missing'));
assert.equal(await missing.frameLocator('iframe[title="Right chat workspace"]').locator('textarea').count(),0);
await missing.close();
// The action menu on a phone must keep the modal picker mounted.
await page.setViewportSize({width:390,height:844});
await page.locator('.layout-pane').first().getByRole('button',{name:'Only this chat'}).click();
await left().getByRole('button',{name:'Chat actions',exact:true}).click();
await left().getByRole('button',{name:'Open chat beside',exact:true}).click();
await left().getByRole('dialog').waitFor();
await left().getByRole('dialog').getByRole('button',{name:'Project Beta Beta chat'}).click();
await page.waitForFunction(()=>location.hash.includes('left=a&right=b'));
await page.getByRole('button',{name:'Left chat',exact:true}).click();
await page.waitForFunction(()=>location.hash.includes('focus=left'));
await page.getByRole('button',{name:'Right chat',exact:true}).click();
await page.waitForFunction(()=>location.hash.includes('focus=right'));
await page.screenshot({path:join(artifacts,'mobile.png')});
assert.deepEqual(errors,[]);
console.log(JSON.stringify({ok:true,artifacts,starts:starts.map(c=>({key:c.args.key,cwd:c.args.cwd})),errors,commands:[...new Set(calls.map(c=>c.cmd))]},null,2));
await browser.close();
