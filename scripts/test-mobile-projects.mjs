// Real App navigation with mocked backend data; no live chats are modified.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../web/package.json', import.meta.url));
const { createServer } = await import(require.resolve('vite'));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const artifacts = await mkdtemp(join(tmpdir(), 'octiq-projects-screen-'));
const server = await createServer({ root: new URL('../web', import.meta.url).pathname, server: { host: '127.0.0.1', port: 0, strictPort: false } });
let browser;
try {
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
browser = await chromium.launch({channel:process.env.OCTIQ_TEST_BROWSER || 'chrome',headless:true});
const context = await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
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
 if(data.cmd==='chat_interrupt') ws.send(JSON.stringify({t:'event',event:'chat-status',payload:{key:data.args.key,kind:'exit',text:'',code:0}}));
}));
const page=await context.newPage();
page.on('pageerror',e=>errors.push(String(e)));
await page.goto(base + '#/p/project-alpha/c/a');
await page.locator('textarea').waitFor();
await page.locator('textarea').fill('Keep my mobile draft');
await page.locator('textarea').evaluate(el=>window.originalComposer=el);
const initialHash = new URL(page.url()).hash;
assert.equal(await page.locator('.sidebar').isVisible(),false);
assert.equal(await page.locator('.scrim').count(),0);

// An actual browser touch sequence cannot reveal or click through a drawer.
const cdp = await context.newCDPSession(page);
const swipe = async () => {
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:5,y:350}]});
  for (const x of [30,70,140,240]) await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:350}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
};
await swipe();
assert.equal(new URL(page.url()).hash,initialHash);
assert.equal(await page.locator('.sidebar').isVisible(),false);

await page.getByRole('button',{name:'Back to projects and chats',exact:true}).tap();
await page.locator('.sidebar').waitFor();
assert.equal(await page.locator('.main').isVisible(),false);
assert.equal(await page.locator('textarea').evaluate(el=>el===window.originalComposer),true);
assert.equal(await page.locator('.sidebar').evaluate(el=>getComputedStyle(el).position),'relative');
assert.equal(await page.locator('.sidebar').evaluate(el=>getComputedStyle(el).transform),'none');
await page.screenshot({path:join(artifacts,'mobile-projects.png')});
await swipe();
assert.equal(new URL(page.url()).hash,initialHash);
assert.equal(await page.locator('.sidebar').isVisible(),true);
await page.getByRole('button',{name:'Return to chat',exact:true}).tap();
assert.equal(await page.locator('textarea').inputValue(),'Keep my mobile draft');
assert.equal(await page.locator('.sidebar').isVisible(),false);

await page.getByRole('button',{name:'Back to projects and chats',exact:true}).tap();
await page.locator('.chat-title').filter({hasText:'Another chat'}).tap();
await page.waitForFunction(()=>location.hash.endsWith('/c/c'));
assert.equal(await page.locator('.main').isVisible(),true);
assert.equal(await page.locator('.sidebar').isVisible(),false);
await page.goBack();
await page.waitForFunction(()=>location.hash.endsWith('/c/a'));
assert.equal(await page.locator('textarea').inputValue(),'Keep my mobile draft');
await page.screenshot({path:join(artifacts,'mobile-chat.png')});

// File navigation leaves the list, and selecting a chat from Files enters Chat.
await page.getByRole('button',{name:'Back to projects and chats',exact:true}).tap();
await page.locator('.sidebar .mode-btn').filter({hasText:'Files'}).tap();
await page.locator('.ws-host').waitFor();
assert.equal(await page.locator('.sidebar').isVisible(),false);
await page.getByRole('button',{name:'Back to projects and chats',exact:true}).tap();
await page.locator('.chat-title').filter({hasText:'Another chat'}).tap();
await page.waitForFunction(()=>location.hash.endsWith('/c/c'));
assert.equal(await page.locator('.main').isVisible(),true);
assert.equal(await page.locator('.ws-host').isVisible(),false);

// Desktop retains its persistent column, including collapse and restore.
await page.setViewportSize({width:1280,height:900});
await page.locator('.sidebar').waitFor();
assert.equal(await page.locator('.main').isVisible(),true);
await page.getByRole('button',{name:'Hide projects',exact:true}).click();
await page.locator('.sidebar').waitFor({state:'hidden'});
await page.getByRole('button',{name:'Projects and chats',exact:true}).click();
await page.locator('.sidebar').waitFor();
await page.screenshot({path:join(artifacts,'desktop.png')});

// Tablet and short phone layouts still have explicit navigation controls.
for (const [width,height] of [[800,900],[390,500],[320,568]]) {
  await page.setViewportSize({width,height});
  await page.getByRole('button',{name:'Back to projects and chats',exact:true}).tap();
  await page.locator('.sidebar').waitFor();
  assert.equal(await page.locator('.main').isVisible(),false);
  const box = await page.getByRole('button',{name:'Return to chat',exact:true}).boundingBox();
  assert.ok(box.x>=0 && box.x+box.width<=width && box.y+box.height<=height);
  await page.screenshot({path:join(artifacts,`projects-${width}x${height}.png`)});
  await page.getByRole('button',{name:'Return to chat',exact:true}).tap();
}
await page.getByRole('button',{name:'Back to projects and chats',exact:true}).tap();
await page.getByRole('button',{name:'New chat in this project',exact:true}).first().tap();
await page.locator('.main').waitFor();
assert.equal(await page.locator('.sidebar').isVisible(),false);
assert.equal(await page.locator('textarea').inputValue(),'');
assert.deepEqual(errors,[]);
assert.equal(calls.some(c=>['chat_start','chat_send'].includes(c.cmd)),false);
console.log('PASS: mobile pages, touch gestures, chat selection, draft retention, Files navigation, browser history, desktop collapse, tablet and short phone; no browser errors.');
console.log('Screenshots:',artifacts);
} finally { await browser?.close(); await server.close(); }
