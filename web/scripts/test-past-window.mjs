// Real App and Claude stream envelopes through a synthetic socket; no paid calls.
// Reuses the H2 reviewer fixture (side-effects.mjs / ordinary-past.mjs).
// Both an oversized earlier page and 13 ordinary presses must keep a visible way back.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {writeFile,mkdtemp,rm} from 'node:fs/promises';
import {join,resolve,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
const web=resolve(process.env.OCTIQ_WEB_ROOT||fileURLToPath(new URL('..',import.meta.url)));
const require=createRequire(join(web,'package.json'));
const {preview,createServer}=await import(pathToFileURL(require.resolve('vite')));
const spec=process.env.PLAYWRIGHT_MODULE||'playwright';
const pw=await import(isAbsolute(spec)||spec.startsWith('.')?pathToFileURL(resolve(spec)).href:spec);
const engine=process.env.HISTORY_ENGINE||'chromium';
const scratch=await mkdtemp(join(tmpdir(),'octiq-past-window-'));
const server=process.env.OCTIQ_TEST_DIST
 ?await preview({root:web,build:{outDir:resolve(process.env.OCTIQ_TEST_DIST)},preview:{host:'127.0.0.1',port:0}})
 :await createServer({root:web,cacheDir:join(scratch,'.vite'),server:{host:'127.0.0.1',port:0,strictPort:false}});
if(!process.env.OCTIQ_TEST_DIST)await server.listen();
const executablePath=engine==='chromium'?process.env.PLAYWRIGHT_EXECUTABLE_PATH:process.env.HISTORY_WEBKIT_EXECUTABLE_PATH;
const browser=await pw[engine].launch({headless:true,...(executablePath?{executablePath}:engine==='chromium'?{channel:process.env.PLAYWRIGHT_CHANNEL||'chrome'}:{})});
const results=[];
let large=false;
const frame=(id,n)=>[
 {event:{type:'user',uuid:`${id}-u-${n}`,octiq_user_turn_id:`${id}-t-${n}`,message:{content:[{type:'text',text:`Question ${id} ${n}`}]}}},
 {event:{type:'assistant',message:{id:`${id}-a-${n}`,content:[{type:'text',text:`Answer ${id} ${n}\n\n${'Reading paragraph. '.repeat(100)}`},{type:'tool_use',id:`${id}-c-${n}`,name:'Read',input:{path:'/fixture'}}]}}},
 {event:{type:'user',message:{content:[{type:'tool_result',tool_use_id:`${id}-c-${n}`,content:'x'.repeat(large&&n===11?6*1024*1024:64*1024)}]}}},
 {event:{type:'result',subtype:'success'}}];
const empty={runs:[],tasks:[],attempts:[],gates:[],messages:[],notifications:[],nativeDecisions:[],reports:{},services:[],bridges:[],peerAsks:[],summary:true};
function inspect(){
 const root=document.getElementById('root'),h=root[Object.keys(root).find(k=>k.startsWith('__reactContainer$'))],todo=[h.stateNode?.current??h];
 while(todo.length){const f=todo.pop();if(typeof f.type==='function'){let n=0;for(let h=f.memoizedState;h?.next;h=h.next)n++;if(n>200){const vs=[];for(let h=f.memoizedState;h;h=h.next)vs.push(h.memoizedState);const chats=vs.find(v=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.values(v).some(s=>Array.isArray(s?.messages)&&typeof s?.busy==='boolean'))??{};const hist=vs.find(v=>v?.current?.isPast&&v?.current?.slices)?.current;return {chats:Object.fromEntries(Object.entries(chats).map(([id,s])=>[id,{ids:s.messages.map(m=>m.id),busy:s.busy,texts:s.messages.map(m=>({id:m.id,blocks:m.blocks.filter(b=>b.kind==='text').map(b=>b.text?.slice(0,160))}))}])),history:Object.fromEntries(Object.keys(chats).map(id=>[id,hist?.get(id)??null]))};}}if(f.child)todo.push(f.child);if(f.sibling)todo.push(f.sibling);}throw Error('missing App');
}
async function fixture(width,kind){
 large=kind==='big';
 const context=await browser.newContext({viewport:{width,height:844},...(width===390?{isMobile:true,hasTouch:true}:{})});
 const groups=Array.from({length:large?15:120},(_,n)=>frame('main',n));let seq=0;for(const g of groups)for(const f of g)f.seq=++seq;
 const requests=[],calls=[],connections=[],sockets=[],errors=[];
 let holdLatest=false,failLatest=false;const pendingLatest=[];
 const page=await context.newPage();page.on('pageerror',e=>errors.push(String(e)));page.setDefaultTimeout(20000);
 await context.routeWebSocket(/\/ws\?/,ws=>{sockets.push(ws);const conn=[];connections.push(conn);ws.onMessage(async raw=>{const c=JSON.parse(String(raw));if(c.t!=='invoke')return;conn.push(c.cmd);calls.push({cmd:c.cmd,args:c.args});const a=c.args??{};let result=[];
 switch(c.cmd){
 case 'chat_subscribe':result={chatKeys:a.chatKeys};break;
 case 'list_workspaces':result=[{id:'p',name:'Fixture',primary_path:'/fixture',paths:['/fixture'],env:{}}];break;
 case 'chat_index_list':result=['main','task'].map(id=>({id,projectId:'p',title:id,createdAt:1,updatedAt:1,modelId:'claude:sonnet-4-6',access:'read',sessionId:id}));break;
 case 'orchestration_summary':case 'orchestration_snapshot':result=empty;break;
 case 'chat_page':{
  requests.push({id:a.key,before:a.before});
  if(a.key==='chat:main'){
   const last=a.before==null?groups.length-1:groups.findLastIndex(g=>g[0].seq<a.before),first=last===11?11:Math.max(0,last-2);
   result={events:groups.slice(first,last+1).flat(),context:[],before:first?groups[first][0].seq:null};
  }else result={events:frame('task',0).map((f,i)=>({...f,seq:i+1})),context:[],before:null};
  if(a.before==null&&holdLatest)await new Promise(r=>pendingLatest.push(r));
  await new Promise(r=>setTimeout(r,90));
  if(a.before==null&&failLatest){failLatest=false;ws.send(JSON.stringify({t:'reply',id:c.id,ok:false,error:'Fixture latest read failed'}));return;}break;
 }
 case 'chat_since':result=(a.key==='chat:main'?groups.flat():[]).filter(f=>f.seq>a.after);break;
 case 'chat_task':result=null;break;
 case 'resolve_paths':result=a.paths.map(()=>null);break;
 case 'usage_summary':result={sessions:[],totals:{}};break;
 }
 try{ws.send(JSON.stringify({t:'reply',id:c.id,ok:true,result}));}catch{}
 });});
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?token=fixture#/c/main`);await page.locator('.msgs [data-map-turn]').first().waitFor();await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(150);
 function send(g,events){for(const ff of events){const f={seq:++seq,event:ff.type?ff:ff.event};g.push(f);sockets.at(-1).send(JSON.stringify({t:'event',event:'chat-event',payload:{key:'chat:main',...f}}));}}
 let streaming;const newTurn=groups.length;
 return {page,context,requests,calls,connections,sockets,errors,groups,newTurn,
  set holdLatest(v){holdLatest=v;},set failLatest(v){failLatest=v;},
  releaseLatest(){holdLatest=false;pendingLatest.splice(0).forEach(r=>r());},
  start(){streaming=[];groups.push(streaming);send(streaming,[{type:'user',uuid:`main-u-${newTurn}`,octiq_user_turn_id:`main-t-${newTurn}`,message:{content:[{type:'text',text:`Question main ${newTurn}`}]}},{type:'stream_event',event:{type:'message_start',message:{id:`main-a-${newTurn}`}}},{type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}}},{type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'PREFIX '}}}]);},
  finish(){send(streaming,[{type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'SUFFIX COMPLETE'}}},{type:'stream_event',event:{type:'message_stop'}},{type:'result',subtype:'success'}]);},
  grow(){const n=groups.length,g=[];groups.push(g);send(g,frame('main',n));}
 };
}
async function bottom(f){await f.page.locator('.msgs').evaluate(el=>{el.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:10000}));el.scrollTop=el.scrollHeight;el.dispatchEvent(new Event('scroll'));});await f.page.waitForTimeout(450);}
function geometry(){
 const sc=document.querySelector('.msgs'),sr=sc.getBoundingClientRect(),b=sc.querySelector('.jump-latest');
 const br=b?.getBoundingClientRect(),cs=b&&getComputedStyle(b);
 return {text:b?.textContent,visible:!!br&&br.top>=sr.top&&br.bottom<=sr.bottom&&cs.visibility==='visible'&&Number(cs.opacity)>0,height:br?.height,width:br?.width,tabIndex:b?.tabIndex,disabled:b?.disabled,
  gap:sc.scrollHeight-sc.scrollTop-sc.clientHeight,top:sc.scrollTop,composer:document.querySelector('.composer-box')?.getBoundingClientRect().top};
}
async function cue(f){
 const g=await f.page.evaluate(geometry);
 assert.ok(g.visible,'past window has a visible cue in the viewport');
 assert.match(g.text,/Newer messages.*Return to latest/);
 assert.ok(g.height>=44&&g.width>=44,'touch target is at least 44px');
 assert.equal(g.tabIndex,0);assert.equal(g.disabled,false);
 return g;
}
try{
 for(const width of (process.env.HISTORY_WIDTHS||'390,1280').split(',').map(Number))for(const kind of (process.env.PAST_CASES||'big,ordinary').split(',')){
 const f=await fixture(width,kind);try{
  // The prefix is already rendered when paging freezes this window.
  f.start();await f.page.waitForFunction(()=>document.querySelector('.msgs').textContent.includes('PREFIX'));
  const pages=kind==='big'?1:13,samples=[];
  for(let i=0;i<pages;i++){
   await f.page.locator('.msgs').evaluate(e=>e.scrollTop=0);await f.page.waitForTimeout(160);
   const before=await f.page.locator('.msgs [data-map-turn]').first().getAttribute('data-map-turn');
   await f.page.locator('.history-more button').evaluate(b=>b.click());
   await f.page.waitForFunction(id=>document.querySelector('.msgs [data-map-turn]')?.dataset.mapTurn!==id&&!document.querySelector('.history-more button:disabled'),before);
   await f.page.waitForTimeout(220);samples.push(await f.page.evaluate(inspect));
  }
  const kept=await f.page.evaluate(inspect);assert.ok(kept.history.main?.end!==undefined,'both paths really reach past');
  await bottom(f);const beforeCue=await cue(f);
  // New output must be announced even while reading away from the loaded bottom.
  await f.page.locator('.msgs').evaluate(el=>{el.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:100}));el.scrollTop=Math.max(0,(el.scrollHeight-el.clientHeight)/2);el.dispatchEvent(new Event('scroll'));});
  await f.page.waitForTimeout(450);const beforeOutput=await f.page.evaluate(geometry);
  f.finish();await f.page.waitForTimeout(450);
  const afterOutput=await f.page.evaluate(inspect),readingCue=await cue(f);
  assert.deepEqual(afterOutput.chats.main.ids,kept.chats.main.ids,'output does not auto-return reader');
  assert.equal(afterOutput.chats.main.busy,false);assert.equal(readingCue.composer,beforeOutput.composer,'cue never moves composer');
  assert.ok(Math.abs(readingCue.top-beforeOutput.top)<1,'new output never moves reading position');
  await bottom(f);const bottomCue=await cue(f);assert.ok(bottomCue.gap<1,'cue stays visible at loaded bottom');
  if(process.env.HISTORY_SCREENSHOTS)await f.page.screenshot({path:`${process.env.HISTORY_SCREENSHOTS}/${engine}-${width}-${kind}-past.png`});
  const latest=f.page.getByRole('button',{name:'Return to latest messages',exact:true});
  const heldDropped=await latest.evaluate(b=>!b.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',repeat:true,bubbles:true,cancelable:true})));
  assert.equal(heldDropped,true,'held Enter is dropped');
  const count=f.requests.length;
  await latest.evaluate(b=>{const r=b.getBoundingClientRect(),p={bubbles:true,cancelable:true,detail:1,clientX:r.x+r.width/2,clientY:r.y+r.height/2};document.querySelector('.msgs-inner').dispatchEvent(new MouseEvent('click',p));b.dispatchEvent(new MouseEvent('click',p));});
  await f.page.waitForTimeout(180);assert.equal(f.requests.length,count,'a repeat from another control cannot activate latest');
  await f.page.waitForTimeout(720);
  // Press Return while reconnect owns the read, then reject that same read.
  // The failure must preserve the past window and permit a new explicit try.
  f.holdLatest=true;f.failLatest=true;f.sockets.at(-1).close();
  for(let n=0;n<100&&f.requests.length===count;n++)await f.page.waitForTimeout(50);
  assert.equal(f.requests.length-count,1,'reconnect read is held');
  if(width===390)await latest.tap();else{await latest.focus();await f.page.keyboard.press('Enter');}
  await latest.evaluate(b=>b.click());await f.page.waitForTimeout(150);
  assert.equal(f.requests.length-count,1,'double Return shares the reconnect read');
  f.releaseLatest();await f.page.waitForTimeout(600);
  const reconnect=await f.page.evaluate(inspect),failedCue=await cue(f);
  const failedAlert=await f.page.getByRole('alert').filter({hasText:'Could not load earlier messages'}).count();
  assert.ok(f.connections.length>=2);assert.ok(f.connections.every(c=>c[0]==='chat_subscribe'));
  assert.ok(reconnect.history.main?.end!==undefined);
  assert.deepEqual(reconnect.chats.main.ids,kept.chats.main.ids,'failed return preserves past messages');
  f.holdLatest=true;
  await latest.evaluate(b=>{b.click();b.click();});
  for(let n=0;n<40&&f.requests.length===count+1;n++)await f.page.waitForTimeout(50);
  assert.equal(f.requests.length-count,2,'second press after reconnect failure starts one retry');
  // The existing loading commit may replace the latest button while held.
  // The synchronous double press above already exercises the re-entry guard.
  await f.page.waitForTimeout(150);
  assert.equal(f.requests.length-count,2,'in-flight double press sends one request');
  assert.equal(failedAlert,1,'failed reconnect Return shows the existing retry error');
  f.releaseLatest();
  await f.page.waitForFunction(()=>!document.querySelector('.jump-latest')&&!document.querySelector('.history-more button:disabled'));
  await f.page.waitForTimeout(500);const returned=await f.page.evaluate(inspect),landed=await f.page.evaluate(geometry);
  const n=f.newTurn,expected=[n-2,n-1,n].flatMap(n=>[`main-u-${n}`,`main-a-${n}`]);
  assert.deepEqual(returned.chats.main.ids,expected);assert.ok(returned.history.main?.end===undefined);
  assert.equal(returned.chats.main.texts.at(-1).blocks.join(''),'PREFIX SUFFIX COMPLETE');
  assert.ok(landed.gap<1,'Return lands at newest messages');
  f.grow();await f.page.waitForFunction(n=>!!document.querySelector(`[data-map-turn="main-u-${n}"]`),n+1);
  assert.equal((await f.page.evaluate(inspect)).chats.main.ids.at(-1),`main-a-${n+1}`);
  // Switching chats still reopens latest, as in the reviewer probe.
  await f.page.evaluate(()=>{location.hash='#/c/task';});await f.page.locator('[data-map-turn="task-u-0"]').waitFor();
  await f.page.evaluate(()=>{location.hash='#/c/main';});await f.page.locator(`[data-map-turn="main-u-${n+1}"]`).waitFor();
  assert.ok((await f.page.evaluate(inspect)).history.main?.end===undefined);
  assert.deepEqual(f.errors,[]);
  if(process.env.HISTORY_SCREENSHOTS)await f.page.screenshot({path:`${process.env.HISTORY_SCREENSHOTS}/${engine}-${width}-${kind}-latest.png`});
  results.push({engine,width,kind,pages,samples,kept,beforeCue,readingCue,bottomCue,reconnect,failedCue,failedAlert,returned,landed,requests:f.requests,errors:f.errors});
 }catch(e){results.push({engine,width,kind,error:String(e),state:await f.page.evaluate(inspect).catch(()=>null),requests:f.requests,errors:f.errors});}finally{f.releaseLatest();await f.context.close();}}
}finally{
 if(process.env.HISTORY_RESULTS)await writeFile(process.env.HISTORY_RESULTS,JSON.stringify(results,null,2));
 console.log(JSON.stringify(results));await browser.close();await new Promise(r=>server.httpServer.close(r));await rm(scratch,{recursive:true,force:true});
}
assert.ok(results.every(r=>!r.error),results.filter(r=>r.error).map(r=>`${r.engine}/${r.width}/${r.kind}: ${r.error}`).join('\n'));
