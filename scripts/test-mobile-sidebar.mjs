// Real App navigation with mocked backend data; no live chats are modified.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../web/package.json', import.meta.url));
const { createServer } = await import(require.resolve('vite'));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const artifacts = await mkdtemp(join(tmpdir(), 'octiq-mobile-sidebar-'));
const server = await createServer({ root: new URL('../web', import.meta.url).pathname, server: { host: '127.0.0.1', port: 0, strictPort: false } });
let browser;
try {
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
browser = await chromium.launch({...(process.env.OCTIQ_TEST_BROWSER ? {channel:process.env.OCTIQ_TEST_BROWSER} : {}),headless:true});
const context = await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
const projects = [{id:'pa',name:'Project Alpha',primary_path:'/test/alpha'},{id:'pb',name:'Project Beta',primary_path:'/test/beta'}];
const chats = [{id:'a',projectId:'pa',title:'Alpha chat'},{id:'b',projectId:'pb',title:'Beta chat'},{id:'c',projectId:'pa',title:'Another chat'}].map(c=>({...c,modelId:'claude-sonnet',sessionId:null,access:null,createdAt:1,updatedAt:2,pinned:false}));
chats.push(...Array.from({length: 12}, (_,i) => ({...chats[0],id:`extra-${i}`,title:`Conversation ${i + 1}`})));
const calls=[]; const errors=[];
await context.route('**/token',r=>r.fulfill({body:'mock-token'}));
await context.route('**/auth',r=>r.fulfill({body:'ok'}));
await context.routeWebSocket(/.*/, ws=>ws.onMessage(raw=>{
 const data=JSON.parse(String(raw)); if(data.t!=='invoke') return;
 calls.push(data);
 let result=[];
 if(data.cmd==='list_workspaces') result=projects;
 if(data.cmd==='chat_index_list') result=chats;
 if(data.cmd==='chat_index_save') { const chat=chats.find(c=>c.id===data.args.meta.id); if(chat) Object.assign(chat,data.args.meta); }
 if(data.cmd==='chat_page') result={events:[],context:[],before:null};
 if(data.cmd==='chat_queue_state') result={live:false,queuedTurnIds:[]};
 if(data.cmd==='memory_usage') result={totalMb:25,procs:1,rows:[]};
 if(data.cmd==='usage_summary') result={claude:{available:true,fiveHour:{percent:100}},codex:{available:true,weekly:{percent:23}}};
 if(data.cmd==='git_status') result={branch:'main',files:[]};
 ws.send(JSON.stringify({t:'reply',id:data.id,ok:true,result}));
 if(data.cmd==='chat_interrupt') ws.send(JSON.stringify({t:'event',event:'chat-status',payload:{key:data.args.key,kind:'exit',text:'',code:0}}));
}));
console.log('Browser ready');
const page=await context.newPage();
page.setDefaultTimeout(60000);
page.setDefaultNavigationTimeout(60000);
page.on('pageerror',e=>errors.push(String(e)));
await page.goto(base + '#/p/project-alpha/c/a', {waitUntil:'domcontentloaded'});
await page.locator('textarea').waitFor();
await page.getByRole('button',{name:'Back to projects and chats',exact:true}).tap();
await page.locator('.sidebar').waitFor();
console.log('Projects loaded');
await page.locator('.sidebar .usage-val').first().waitFor();
const currentRow = page.locator('.chat').filter({has:page.locator('.chat-title').filter({hasText:/^Alpha chat$/})});
assert.equal(await page.locator('.sidebar a[href="/os"]').count(),1);
assert.equal(await currentRow.locator('.chat-rename-btn').isVisible(),false);
assert.equal(await currentRow.locator('.chat-pin').isVisible(),false);
assert.equal(await currentRow.locator('.chat-del').isVisible(),false);
const bounds = async locator => {const box=await locator.boundingBox(); assert.ok(box); return box;};
const footer = await bounds(page.locator('.sidebar-slot.is-foot'));
assert.ok(footer.height<=50,`footer too tall: ${footer.height}`);
assert.ok((await bounds(page.locator('.proj').first())).y >= (await bounds(page.locator('.sidebar-head'))).y + (await bounds(page.locator('.sidebar-head'))).height);
assert.ok((await bounds(currentRow.locator('.chat-title'))).width > 240);
assert.equal((await bounds(currentRow)).height,44);
await page.screenshot({path:join(artifacts,'mobile-projects.png')});

// Menus are keyboard accessible, restore focus, and never navigate into a chat.
await currentRow.getByRole('button',{name:'Actions for Alpha chat',exact:true}).tap();
const dialog=page.getByRole('dialog',{name:'Alpha chat',exact:true});
await dialog.waitFor();
assert.equal(await page.locator('.sidebar').isVisible(),true);
assert.equal(await dialog.evaluate(el=>el.contains(document.activeElement)),true);
await page.screenshot({path:join(artifacts,'chat-actions.png')});
await page.keyboard.press('Escape');
await dialog.waitFor({state:'hidden'});
assert.equal(await currentRow.locator('.chat-actions-trigger').evaluate(el=>el===document.activeElement),true);
await currentRow.locator('.chat-actions-trigger').tap();
await dialog.getByRole('button',{name:'Pin chat',exact:true}).tap();
await currentRow.locator('.chat-mobile-pin').waitFor();
await currentRow.locator('.chat-actions-trigger').tap();
await dialog.getByRole('button',{name:'Unpin chat',exact:true}).tap();
await currentRow.locator('.chat-mobile-pin').waitFor({state:'hidden'});
await currentRow.locator('.chat-actions-trigger').tap();
await dialog.getByRole('button',{name:'Rename chat',exact:true}).tap();
const rename=page.getByRole('textbox',{name:'Chat title',exact:true});
await rename.waitFor();
assert.equal(await rename.evaluate(el=>el===document.activeElement),true);
await rename.fill('Renamed chat');
await rename.press('Enter');
await page.getByRole('button',{name:'Actions for Renamed chat',exact:true}).waitFor();
const renamedRow=page.locator('.chat').filter({has:page.locator('.chat-title').filter({hasText:/^Renamed chat$/})});
await renamedRow.locator('.chat-actions-trigger').tap();
await page.getByRole('dialog').getByRole('button',{name:'Delete chat',exact:true}).tap();
await renamedRow.getByRole('button',{name:'Cancel delete',exact:true}).tap();
assert.equal(await renamedRow.locator('.chat-actions-trigger').isVisible(),true);

console.log('Menu actions passed');
// Hold opens actions; movement cancels the hold so scrolling stays navigation-free.
const cdp=await context.newCDPSession(page);
const titleBox=await bounds(renamedRow.locator('.chat-btn'));
const x=titleBox.x+80, y=titleBox.y+22;
await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
await page.getByRole('dialog').waitFor();
await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).tap();
assert.equal(await page.locator('.sidebar').isVisible(),true);
await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+25}]});
await page.waitForTimeout(600);
await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
assert.equal(await page.getByRole('dialog').count(),0);

console.log('Touch gestures passed');
// Both readout popovers fit within the viewport, above their shared footer.
for (const [width,height] of [[320,568],[390,500],[700,900]]) {
  await page.setViewportSize({width,height});
  const buttons=page.locator('.sidebar-slot.is-foot .usage-btn');
  assert.equal(await buttons.count(),2);
  const a=await bounds(buttons.nth(0)),b=await bounds(buttons.nth(1));
  assert.equal(a.y,b.y);
  assert.ok(b.x+b.width<=width);
  for(let i=0;i<2;i++) {
    await buttons.nth(i).tap();
    const pop=page.locator('.sidebar-slot.is-foot .usage-pop');
    await pop.waitFor();
    const box=await bounds(pop);
    assert.ok(box.x>=0 && box.x+box.width<=width && box.y>=0 && box.y+box.height<=height);
    await page.locator('.usage-scrim').tap({position:{x:width-3,y:5}});
  }
  await page.screenshot({path:join(artifacts,`projects-${width}x${height}.png`)});
}
await page.setViewportSize({width:1280,height:900});
assert.equal(await renamedRow.locator('.chat-actions-trigger').isVisible(),false);
assert.equal(await renamedRow.locator('.chat-pin').isVisible(),true);
assert.deepEqual(errors,[]);
console.log('PASS: compact phone layout, title space, menus, focus, rename, pin/unpin, delete undo, long press, scroll cancellation, readout popovers, desktop controls.');
console.log('Screenshots:',artifacts);
} finally { await browser?.close(); await server.close(); }
