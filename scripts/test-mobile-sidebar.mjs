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
console.log('Screenshots:',artifacts);
const server = await createServer({ root: new URL('../web', import.meta.url).pathname, server: { host: '127.0.0.1', port: 0, strictPort: false } });
let browser;
try {
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
browser = await chromium.launch({...(process.env.OCTIQ_TEST_BROWSER ? {channel:process.env.OCTIQ_TEST_BROWSER} : {}),headless:true});
const context = await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
const projects = [
 {id:'pa',name:'General',primary_path:'/test/general'},
 {id:'pb',name:'Atlas',primary_path:'/test/atlas'},
 {id:'ps',name:'Starfall',primary_path:'/test/starfall'},
 {id:'pp',name:'Performance',primary_path:'/test/performance'},
 {id:'po',name:'OctiqFlow',primary_path:'/test/octiq'},
 {id:'s1',name:'Earlier work',shelved:true},
 {id:'s2',name:'Experiments',shelved:true},
];
const titles = ['Review the workspace setup', 'Review pull request #128', 'Collect feedback from the latest post', '继续 Starfall，第 7 章先定大纲', 'Prepare the next video for release', 'Review the remaining pull requests', 'Simplify the mobile project list'];
const chats = [ ['a','pa'], ['b','pb'], ['c','pa'], ['d','ps'], ['e','ps'], ['f','pp'], ['g','po'] ].map(([id,projectId],i) => ({
 id,projectId,title:titles[i],customTitle:true,modelId:'claude-sonnet',sessionId:`session-${id}`,access:null,
 createdAt:Date.now()-i*600000,updatedAt:Date.now()-i*600000,pinned:id==='d',
}));
const snippets = ['', 'The review is ready. Two changes need attention.', 'Collected the comments and follow-up replies.', '先确认人物动机，再接上下一章。', 'The export is ready for review.', 'Three pull requests left to check.', 'Move every action into a dropdown.'];
const calls=[]; const errors=[];
async function mockBackend(context) {
await context.addInitScript(({chats,snippets}) => {
 localStorage.setItem('octiq.theme','sage');
 localStorage.setItem('octiq.v2.openFolders',JSON.stringify(['pa','pb','ps','pp','po']));
 localStorage.setItem('octiq.v2.conversations',JSON.stringify(chats.map((c,i)=>({...c,messages:snippets[i] ? [{id:`m-${c.id}`,role:'assistant',streaming:false,blocks:[{kind:'text',text:snippets[i]}]}] : []}))));
}, {chats,snippets});
await context.route('**/token',r=>r.fulfill({body:'mock-token'}));
await context.route('**/auth',r=>r.fulfill({body:'ok'}));
await context.routeWebSocket(/.*/, ws=>ws.onMessage(raw=>{
 const data=JSON.parse(String(raw)); if(data.t!=='invoke') return;
 calls.push(data);
 let result=[];
 if(data.cmd==='list_workspaces') result=projects;
 if(data.cmd==='chat_index_list') result=chats;
 if(data.cmd==='chat_index_deleted') result=[{...chats[0],id:'deleted-1',title:'Earlier conversation',deletedAt:Date.now()}];
 if(data.cmd==='chat_index_save') { const chat=chats.find(c=>c.id===data.args.meta.id); if(chat) Object.assign(chat,data.args.meta); }
 if(data.cmd==='chat_page') result={events:[],context:[],before:null};
 if(data.cmd==='chat_queue_state') result={live:false,queuedTurnIds:[]};
 if(data.cmd==='memory_usage') result={totalMb:25,procs:1,rows:[]};
 if(data.cmd==='usage_summary') result={claude:{available:true,fiveHour:{percent:100}},codex:{available:true,weekly:{percent:23}}};
 if(data.cmd==='git_status') result={branch:'main',files:[]};
 ws.send(JSON.stringify({t:'reply',id:data.id,ok:true,result}));
 if(data.cmd==='chat_interrupt') ws.send(JSON.stringify({t:'event',event:'chat-status',payload:{key:data.args.key,kind:'exit',text:'',code:0}}));
}));
}
await mockBackend(context);
console.log('Browser ready');
const page=await context.newPage();
page.setDefaultTimeout(60000);
page.setDefaultNavigationTimeout(60000);
page.on('pageerror',e=>errors.push(String(e)));
await page.goto(base + '#/p/general/c/a', {waitUntil:'domcontentloaded'});
await page.locator('textarea').waitFor().catch(async error => {
  await page.screenshot({path:join(artifacts,'startup-failure.png')});
  console.error('Startup errors:', errors, 'Screenshots:', artifacts);
  throw error;
});
await page.getByRole('button',{name:'Back to projects and chats',exact:true}).tap();
await page.locator('.sidebar').waitFor();
console.log('Projects loaded');
await page.locator('.sidebar .usage-val').first().waitFor();
const bounds = async locator => {const box=await locator.boundingBox(); assert.ok(box); return box;};
const menu = page.getByRole('menu');
const listTrigger = page.getByRole('button',{name:'Project list actions',exact:true});
const projectTrigger = page.getByRole('button',{name:'Actions for project General',exact:true});
const currentRow = page.locator('.chat').filter({has:page.locator('.chat-title').filter({hasText:new RegExp(`^${titles[0]}$`)})});
const chatTrigger = currentRow.getByRole('button',{name:`Actions for ${titles[0]}`,exact:true});
const action = name => menu.getByRole('menuitem',{name,exact:true});
const insideViewport = async locator => {
 const box=await bounds(locator),size=page.viewportSize();
 assert.ok(box.x>=0 && box.y>=0 && box.x+box.width<=size.width && box.y+box.height<=size.height,JSON.stringify(box));
};
assert.equal(await page.locator('.sidebar .proj-add, .sidebar .proj-drag, .sidebar .chat-pin, .sidebar .chat-del, .sidebar .chat-rename-btn, .sidebar .sidebar-add').count(),0);
assert.equal(await menu.count(),0);
assert.ok((await bounds(currentRow.locator('.chat-title'))).width>280);
assert.equal((await bounds(currentRow)).height,56);
assert.equal(await chatTrigger.evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)');
assert.ok((await bounds(page.locator('.sidebar-slot.is-foot'))).height<=50);
await page.screenshot({path:join(artifacts,'mobile-projects.png')});

// Page actions all open their original surfaces from the dropdown.
for (const [label,dialogName] of [['New project','New project'],['Shelved projects (2)','Shelved projects'],['Deleted chats (1)','Deleted chats']]) {
 await listTrigger.tap();
 await insideViewport(menu);
 await action(label).tap();
 const dialog=page.getByRole('dialog',{name:dialogName,exact:true});
 await dialog.waitFor();
 assert.equal(await menu.count(),0);
 await dialog.getByRole('button',{name:'Close',exact:true}).tap();
}
console.log('Page menu passed');

// Project actions retain settings, reordering, and creation.
await projectTrigger.tap();
await page.screenshot({path:join(artifacts,'project-dropdown.png')});
await action('Project settings').tap();
await page.getByRole('dialog',{name:'General',exact:true}).getByRole('button',{name:'Close',exact:true}).tap();
await projectTrigger.tap();
await action('Move project down').tap();
await page.waitForFunction(()=>document.querySelector('.proj-name')?.textContent==='Atlas');
assert.ok(calls.some(c=>c.cmd==='reorder_workspaces' && c.args.orderedIds[1]==='pa'));
await projectTrigger.tap();
await action('Move project up').tap();
await page.waitForFunction(()=>document.querySelector('.proj-name')?.textContent==='General');

// Keyboard navigation, focus restoration, and dismissal cannot open a chat.
await chatTrigger.tap();
await menu.waitFor();
assert.equal(await menu.evaluate(el=>el.contains(document.activeElement)),true);
await page.keyboard.press('ArrowDown');
assert.equal(await action('Pin chat').evaluate(el=>el===document.activeElement),true);
await page.keyboard.press('End');
assert.equal(await action('Delete chat').evaluate(el=>el===document.activeElement),true);
await page.keyboard.press('Home');
assert.equal(await action('Rename chat').evaluate(el=>el===document.activeElement),true);
await page.keyboard.press('Escape');
assert.equal(await chatTrigger.evaluate(el=>el===document.activeElement),true);
await page.keyboard.press('ArrowDown');
await menu.waitFor();
await page.keyboard.press('Tab');
await menu.waitFor({state:'hidden'});
assert.equal(await page.locator('.sidebar').isVisible(),true);

await chatTrigger.tap();
await action('Pin chat').tap();
await currentRow.locator('.chat-mobile-pin').waitFor();
await chatTrigger.tap();
await action('Unpin chat').tap();
await currentRow.locator('.chat-mobile-pin').waitFor({state:'hidden'});
await chatTrigger.tap();
await action('Rename chat').tap();
const rename=page.getByRole('textbox',{name:'Chat title',exact:true});
await rename.waitFor();
assert.equal(await rename.evaluate(el=>el===document.activeElement),true);
await rename.fill('Renamed chat');
await rename.press('Enter');
const renamedTrigger=page.getByRole('button',{name:'Actions for Renamed chat',exact:true});
await renamedTrigger.waitFor();
const renamedRow=page.locator('.chat').filter({has:page.locator('.chat-title').filter({hasText:/^Renamed chat$/})});
await renamedTrigger.tap();
await page.screenshot({path:join(artifacts,'chat-dropdown.png')});
await action('Delete chat').tap();
await action('Cancel delete').waitFor();
assert.equal(await action('Rename chat').isDisabled(),true);
await page.keyboard.press('Escape');
await renamedTrigger.tap();
await action('Cancel delete').tap();
assert.equal(await renamedRow.locator('.chat-drain-arc').count(),0);
assert.equal(await menu.count(),0);
console.log('Chat menus, keyboard, rename, pin and delete undo passed');

// Long press opens the same anchored menu; a scrolling gesture cancels it.
const cdp=await context.newCDPSession(page);
const titleBox=await bounds(renamedRow.locator('.chat-btn'));
const x=titleBox.x+80,y=titleBox.y+22;
await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
await menu.waitFor();
await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
assert.equal(await menu.isVisible(),true);
await page.keyboard.press('Escape');
assert.equal(await page.locator('.sidebar').isVisible(),true);
await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+25}]});
await page.waitForTimeout(600);
await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
assert.equal(await menu.count(),0);

// Menus flip above the trigger near the bottom and never leave a short phone.
for (const [width,height] of [[320,568],[390,500],[700,900]]) {
 await page.setViewportSize({width,height});
 const list=page.locator('.proj-list');
 await list.evaluate(el=>{el.scrollTop=el.scrollHeight;});
 const lastTrigger=page.locator('.chat-actions-trigger').last();
 await lastTrigger.tap();
 await insideViewport(menu);
 const anchor=await bounds(lastTrigger),popup=await bounds(menu);
 if (anchor.y+anchor.height+4+popup.height>height-8) {
  assert.ok(popup.y+popup.height<=anchor.y+1,`bottom menu should open upward: ${JSON.stringify({anchor,popup,width,height})}`);
 } else assert.ok(popup.y>=anchor.y+anchor.height,'menu should open below when there is room');
 await page.screenshot({path:join(artifacts,`dropdown-${width}x${height}.png`)});
 await page.keyboard.press('Escape');
 await list.evaluate(el=>{el.scrollTop=0;});
 await listTrigger.tap();
 await page.mouse.click(2,height-4);
 assert.equal(await menu.count(),0);
 const buttons=page.locator('.sidebar-slot.is-foot .usage-btn');
 assert.equal(await buttons.count(),2);
 for(let i=0;i<2;i++) {
  await buttons.nth(i).tap();
  const pop=page.locator('.sidebar-slot.is-foot .usage-pop');
  await pop.waitFor();
  await insideViewport(pop);
  await page.locator('.usage-scrim').tap({position:{x:width-3,y:5}});
 }
 await page.screenshot({path:join(artifacts,`projects-${width}x${height}.png`)});
}
await page.setViewportSize({width:390,height:844});
await projectTrigger.tap();
await action('New chat in this project').tap();
await page.locator('.main').waitFor();
assert.equal(await page.locator('.sidebar').isVisible(),false);
assert.equal(await page.locator('textarea').inputValue(),'');

// Desktop uses the same dropdown contract, including hide and restore.
await page.setViewportSize({width:1280,height:900});
await page.locator('.sidebar').waitFor();
await listTrigger.click();
await action('Hide projects').click();
await page.locator('.sidebar').waitFor({state:'hidden'});
await page.getByRole('button',{name:'Projects and chats',exact:true}).click();
await page.locator('.sidebar').waitFor();
await renamedTrigger.click();
await insideViewport(menu);
await page.screenshot({path:join(artifacts,'desktop-dropdown.png')});
await page.keyboard.press('Escape');

// A desktop mouse has the same menu; touch media queries are not required.
const desktop=await browser.newContext({viewport:{width:1280,height:900}});
await mockBackend(desktop);
const desktopPage=await desktop.newPage();
desktopPage.on('pageerror',e=>errors.push(String(e)));
await desktopPage.goto(base+'#/p/general/c/a');
await desktopPage.locator('.sidebar').waitFor();
assert.equal(await desktopPage.evaluate(()=>matchMedia('(pointer: fine)').matches),true);
assert.equal(await desktopPage.locator('.sidebar .chat-pin, .sidebar .proj-add, .sidebar .chat-del').count(),0);
await desktopPage.getByRole('button',{name:'Actions for Renamed chat',exact:true}).click();
await desktopPage.getByRole('menuitem',{name:'Rename chat',exact:true}).waitFor();
await desktopPage.screenshot({path:join(artifacts,'desktop-mouse-dropdown.png')});
await desktop.close();
assert.deepEqual(errors,[]);
assert.equal(calls.some(c=>['chat_start','chat_send'].includes(c.cmd)),false);
console.log('PASS: all sidebar actions in dropdowns, page/project/chat actions, keyboard focus, undo, gestures, viewport bounds, desktop collapse; no live chats modified.');
console.log('Screenshots:',artifacts);
} finally { await browser?.close(); await server.close(); }
