// H1: a whole 6 MiB earlier turn must survive App's automatic latest trim.
// Same synthetic record as the independent 221b9b5 review; no live profile.
// Uses the same PLAYWRIGHT_*, OCTIQ_TEST_DIST and HISTORY_ENGINE options as
// test-load-earlier.mjs. HISTORY_BASELINE=1 records the failing control.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {isAbsolute, resolve, join} from 'node:path';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
const web=resolve(process.env.OCTIQ_WEB_ROOT||fileURLToPath(new URL('..',import.meta.url)));
const require=createRequire(join(web,'package.json'));
const {preview,createServer}=await import(pathToFileURL(require.resolve('vite')));
const spec=process.env.PLAYWRIGHT_MODULE||'playwright';
const pw=await import(isAbsolute(spec)||spec.startsWith('.')?pathToFileURL(resolve(spec)).href:spec);
const engine=process.env.HISTORY_ENGINE||'chromium', baseline=process.env.HISTORY_BASELINE==='1';
let server,browser,scratch;
const all=[];
const diagram='```octiq-diagram\n'+JSON.stringify({rows:[[{title:'Read old history',icon:'file'}],[{title:'Keep reader anchor',icon:'check'}]]})+'\n```';
const frame=(id,n)=>[
 {seq:n*4+1,event:{type:'user',uuid:`${id}-u-${n}`,octiq_user_turn_id:`${id}-t-${n}`,message:{content:[{type:'text',text:`Question ${id} ${n}`}]}}},
 {seq:n*4+2,event:{type:'assistant',message:{id:`${id}-a-${n}`,content:[{type:'text',text:`Answer ${id} ${n}\n\n${'Reading paragraph. '.repeat(100)}\n\n${diagram}\n\n![delayed image](/fixture-image-${n}.svg)`},{type:'tool_use',id:`${id}-c-${n}`,name:'Read',input:{path:'/fixture'}}]}}},
 {seq:n*4+3,event:{type:'user',message:{content:[{type:'tool_result',tool_use_id:`${id}-c-${n}`,content:'x'.repeat(64*1024)}]}}},
 {seq:n*4+4,event:{type:'result',subtype:'success'}}];
const empty={runs:[],tasks:[],attempts:[],gates:[],messages:[],notifications:[],nativeDecisions:[],reports:{},services:[],bridges:[],peerAsks:[],summary:true};
function inspect(){
 const root=document.getElementById('root'),h=root[Object.keys(root).find(k=>k.startsWith('__reactContainer$'))],todo=[h.stateNode?.current??h];
 while(todo.length){const f=todo.pop();if(typeof f.type==='function'){let n=0;for(let h=f.memoizedState;h?.next;h=h.next)n++;if(n>200){const vs=[];for(let h=f.memoizedState;h;h=h.next)vs.push(h.memoizedState);const chats=vs.find(v=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.values(v).some(s=>Array.isArray(s?.messages)&&typeof s?.busy==='boolean'))??{};return Object.fromEntries(Object.entries(chats).map(([id,s])=>[id,s.messages.map(m=>m.id)]));}}if(f.child)todo.push(f.child);if(f.sibling)todo.push(f.sibling);}throw Error('missing App');
}
async function fixture(width){
 const total=15;
 const context=await browser.newContext({viewport:{width,height:844},...(width===390?{isMobile:true,hasTouch:true}:{})});
 const requests=[],sockets=[];let now=total;
 await context.route('**/fixture-image-*.svg',async r=>{await new Promise(r=>setTimeout(r,450));await r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="skyblue"/></svg>'});});
 await context.routeWebSocket(/\/ws\?/,ws=>{sockets.push(ws);ws.onMessage(async raw=>{const c=JSON.parse(String(raw));if(c.t!=='invoke')return;const a=c.args??{};let result=[];
  switch(c.cmd){
   case 'chat_subscribe':result={chatKeys:a.chatKeys};break;
   case 'list_workspaces':result=[{id:'p',name:'Fixture',primary_path:'/fixture',paths:['/fixture'],env:{}}];break;
   case 'chat_index_list':result=['main','task'].map(id=>({id,projectId:'p',title:id,createdAt:1,updatedAt:1,modelId:'claude:sonnet-4-6',access:'read',sessionId:id}));break;
   case 'orchestration_summary':case 'orchestration_snapshot':result=empty;break;
   case 'chat_page':{
    const id=a.key.slice(5);requests.push({id,before:a.before});
    const last=a.before==null?now-1:Math.floor((a.before-2)/4),first=last===now-4?last:Math.max(0,last-2);
    result={events:Array.from({length:last-first+1},(_,i)=>frame(id,first+i)).flat(),context:[],before:first?first*4+1:null};
    if(a.before!==null)result.events.forEach(f=>{if(f.event.type==='user'&&f.event.message.content[0]?.type==='tool_result')f.event.message.content[0].content='H'.repeat(6*1024*1024);});await new Promise(r=>setTimeout(r,90));break;
   }
   case 'chat_since':result=Array.from({length:now},(_,n)=>frame(a.key.slice(5),n)).flat().filter(f=>f.seq>a.after);break;
   case 'chat_task':result=null;break;
   case 'resolve_paths':result=a.paths.map(()=>null);break;
   case 'usage_summary':result={sessions:[],totals:{}};break;
  }
  try{ws.send(JSON.stringify({t:'reply',id:c.id,ok:true,result}));}catch{}
 });});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));page.setDefaultTimeout(60000);
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?token=fixture#/c/main`);
 await page.locator('.msgs [data-map-turn]').first().waitFor();await page.waitForTimeout(700);
 return {context,page,requests,sockets,errors,grow(){now++;return frame('main',now-1);}};
}
async function begin(page){
 return page.evaluate(()=>{
  const el=document.querySelector('.msgs'),node=el.querySelector('[data-map-turn]');
  window.__review={id:node.dataset.mapTurn,top:node.getBoundingClientRect().top};
  // A repeated press must not enter a second load while this one is pending.
  const button=el.querySelector('.history-more button');button.click();button.click();
 });
}
try{
 scratch=await mkdtemp(join(tmpdir(),'octiq-large-earlier-'));
 server=process.env.OCTIQ_TEST_DIST
  ?await preview({root:web,build:{outDir:resolve(process.env.OCTIQ_TEST_DIST)},preview:{host:'127.0.0.1',port:0}})
  :await createServer({root:web,cacheDir:join(scratch,'.vite'),server:{host:'127.0.0.1',port:0}});
 if(!process.env.OCTIQ_TEST_DIST)await server.listen();
 browser=await pw[engine].launch({headless:true,...(engine==='chromium'
  ?process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{channel:process.env.PLAYWRIGHT_CHANNEL||'chrome'}
  :process.env.HISTORY_WEBKIT_EXECUTABLE_PATH?{executablePath:process.env.HISTORY_WEBKIT_EXECUTABLE_PATH}:{})});
 for(const width of [390,1280]){
  const f=await fixture(width);
  try{
   // Wait for the deliberate scroll-to-top event before measuring the anchor.
   await f.page.evaluate(()=>{document.querySelector('.msgs').scrollTop=0;});
   await f.page.waitForTimeout(160);
   const count=f.requests.length;
   await begin(f.page);
   await f.page.waitForTimeout(250);
   await f.page.waitForFunction(()=>!document.querySelector('.history-more button:disabled'));
   // Let the trim effect (and any resulting bounded reload) settle as well.
   await f.page.waitForTimeout(1000);
   await f.page.waitForFunction(()=>!document.querySelector('.history-more button:disabled'));
   const sample=await f.page.evaluate(()=>{
    const el=document.querySelector('.msgs'),s=window.__review;
    const anchor=[...el.querySelectorAll('[data-map-turn]')].find(n=>n.dataset.mapTurn===s.id);
    return {first:el.querySelector('[data-map-turn]').dataset.mapTurn,anchor:s.id,driftPx:anchor?anchor.getBoundingClientRect().top-s.top:null};
   });
   const state=await f.page.evaluate(inspect),requests=f.requests.slice(count);
   const result={engine,browserVersion:browser.version(),width,baseline,...sample,state,requests,errors:f.errors};
   all.push(result);
   if(!baseline){
    assert.equal(requests.length,2,'one older and one recent request; no automatic latest reload');
    assert.ok(state.main.includes('main-u-11'),'the requested oversized turn stays loaded');
    assert.ok(state.main.includes('main-u-12'),'the adjacent anchor page stays loaded');
    assert.equal(sample.anchor,'main-u-12');
    assert.notEqual(sample.driftPx,null);
    assert.ok(Math.abs(sample.driftPx)<=1,`anchor drift ${sample.driftPx}px`);
    // Invoke the actual button without Playwright scrolling it into view,
    // which can itself trigger a second automatic earlier read.
    await f.page.getByRole('button',{name:'Return to latest messages',exact:true}).evaluate(button=>button.click());
    await f.page.waitForFunction(()=>!document.querySelector('.history-more button:disabled')&&document.querySelector('.msgs [data-map-turn]')?.dataset.mapTurn==='main-u-12');
    await f.page.waitForTimeout(250);
    const latest=await f.page.evaluate(inspect);
    assert.deepEqual(latest.main,['main-u-12','main-a-12','main-u-13','main-a-13','main-u-14','main-a-14']);
    const beforeGrowth=f.requests.length;
    // More than 8 MiB of conservative projected tool bodies at the latest end.
    // The fixture's latest page remains three small turns after live growth.
    for(let n=0;n<72;n++)for(const frame of f.grow())f.sockets.at(-1).send(JSON.stringify({t:'event',event:'chat-event',payload:{key:'chat:main',...frame}}));
    await f.page.waitForFunction(()=>document.querySelector('.msgs [data-map-turn]')?.dataset.mapTurn==='main-u-84');
    await f.page.waitForTimeout(1000);
    const trimmed=await f.page.evaluate(inspect);
    result.returnedToLatest=latest.main;
    result.liveTrim={requests:f.requests.slice(beforeGrowth),state:trimmed.main};
    assert.ok(result.liveTrim.requests.length>=1,'latest live growth must still trigger automatic trim');
    assert.ok(result.liveTrim.requests.every(r=>r.before===null),'trim reads only the bounded latest page');
    assert.deepEqual(trimmed.main,['main-u-84','main-a-84','main-u-85','main-a-85','main-u-86','main-a-86']);
    assert.deepEqual(f.errors,[]);
   }
   console.log(JSON.stringify(result));
  }finally{await f.context.close();}
 }
}finally{
 if(process.env.HISTORY_RESULTS)await writeFile(process.env.HISTORY_RESULTS,JSON.stringify({results:all},null,2));
 try{await browser?.close();}finally{
  try{if(server?.close)await server.close();else if(server)await new Promise(r=>server.httpServer.close(r));}
  finally{if(scratch)await rm(scratch,{recursive:true,force:true});}
 }
}
