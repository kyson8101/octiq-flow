// Real App + MessageList layout through Vite; no live backend, agents or profile.
// PLAYWRIGHT_MODULE can point to an isolated Playwright installation.
// PLAYWRIGHT_CHANNEL=chrome uses installed Chrome. For before/after evidence:
// OCTIQ_PREPEND_BASELINE=<sha> OCTIQ_CAPTURE_ONLY=1 node scripts/test-chat-prepend.mjs
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { browserPaths } from "./browser-paths.mjs";
const { webRoot, require, moduleUrl } = browserPaths(import.meta.url);
const { createServer, normalizePath } = await import(moduleUrl(require.resolve("vite")));
const { chromium } = await import(moduleUrl(process.env.PLAYWRIGHT_MODULE || "playwright"));
const artifacts = process.env.OCTIQ_EVIDENCE_DIR || await mkdtemp(join(tmpdir(), "octiq-chat-prepend-"));
const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {MessageList} from '/src/components/MessageList.tsx';
import {emptyChat,reduceChat} from '/src/lib/chat.ts';
import {ChatHistory} from '/src/lib/chatHistory.ts';
import {CatchUp} from '/src/lib/catchUp.ts';
import {loadEarlierChat} from '/src/lib/loadChat.ts';
import capture from '/src/lib/__fixtures__/antigravity-three-turns.jsonl?raw';
import '@fontsource-variable/inter';
import '/src/design-system.css'; import '/src/styles.css';
const scene = new URLSearchParams(location.search).get('scene');
window.__expiryScene=scene==='app-server-expiry';
// The captured reply supplies realistic prose; repeat the turns with distinct
// canonical IDs so the harness exercises the actual history replay too.
const captured = capture.trim().split('\\n').map(JSON.parse).reduce(reduceChat,emptyChat());
const prose = captured.messages.flatMap(m=>m.blocks).filter(b=>b.kind==='text').map(b=>b.text).join('\\n\\n');
const frames = Array.from({length:36},(_,i)=>[
 {type:'user',uuid:'prompt-'+i,message:{role:'user',content:[{type:'text',text:'Question '+i}]}},
 {type:'assistant',uuid:'answer-'+i,message:{id:'answer-'+i,role:'assistant',content:[{type:'text',text:('Answer '+i+'\\n\\n'+prose+'\\n\\n').repeat(2)+(i%6===5?'\\n\\n/test/earlier-'+i+'.png':'')}]}}
]).flat().map((event,i)=>({seq:i+1,event}));
window.__appFrames=frames;window.__appServer=scene.startsWith('app-server');
const initial = scene==='server' ? frames.slice(-12) : frames;
const history = new ChatHistory(); history.set('prepend',initial,initial[0].seq);
const catchUp = new CatchUp();
let state = initial.reduce((s,f)=>reduceChat(s,f.event),emptyChat());
window.__calls=[];
window.__media=[];
window.__commands=[];
function Page(){
 const [chat,setChat]=React.useState(state),[loading,setLoading]=React.useState(false),[hasEarlier,setEarlier]=React.useState(scene==='server');
 const [error,setError]=React.useState<string|undefined>();
 const [id,setId]=React.useState('prepend'),[head,setHead]=React.useState(0);
 window.__switch=setId;
 window.__head=setHead;
 window.__append=()=>setChat(s=>({...s,messages:[...s.messages,{id:'stream-user',role:'user',streaming:false,blocks:[{kind:'text',text:'New prompt'}]},{id:'stream-answer',role:'assistant',streaming:true,blocks:[{kind:'text',text:'New answer. '.repeat(100)}]}]}));
 window.__grow=()=>setChat(s=>({...s,messages:s.messages.map(m=>m.id==='stream-answer'?{...m,blocks:[{kind:'text',text:'New answer. '.repeat(200)}]}:m)}));
 const load=async()=>{setLoading(true);setError(undefined);window.__calls.push('chat_page');
  if(window.__failEarlier){await new Promise(r=>setTimeout(r,150));setError('Scratch page failed');setLoading(false);return;}
  await loadEarlierChat({id:'prepend',key:'chat:prepend',catchUp,history,getState:()=>state,
   // Model App's render queue: the RPC can finish before messages commit.
   publish:s=>{state=s;setTimeout(()=>setChat(s),80)},request:async()=>[],cancelled:()=>false,
   requestPage:async before=>{await new Promise(r=>setTimeout(r,150));return window.__emptyEarlier
    ? {events:[],context:[{seq:1,event:{type:'system',subtype:'init',session_id:'scratch'}}],before:null}
    : {events:frames.filter(f=>f.seq<before),context:[],before:null}}});
  setEarlier(false);setLoading(false);
 };
 return <div style={{display:'flex',height:'100dvh',flexDirection:'column'}}><MessageList messages={chat.messages} busy={false} conversationId={id} head={head?<div style={{height:head,flexShrink:0}}>Conversation context</div>:undefined} hasEarlier={hasEarlier} loadingEarlier={loading} earlierError={error} onLoadEarlier={load}/></div>;
}
const root=createRoot(document.getElementById('root'));
window.__unmount=()=>root.unmount();
if(scene.startsWith('app-')){
 const {default:App}=await import('/src/App.tsx');
 const {ConfirmProvider}=await import('/src/components/Confirm.tsx');
 const {OpenFileProvider}=await import('/src/components/OpenFile.tsx');
 root.render(<ConfirmProvider><OpenFileProvider><App/></OpenFileProvider></ConfirmProvider>);
}else root.render(<Page/>);
`;
// Supply a deferred conversation head through the real App's MessageList prop.
// Only the expiry scene uses it; App still owns history loading and rendering.
const deferredHead = `
import React from 'react';
import {flushSync} from 'react-dom';
export function PrependHead({children}) {
 const [height,setHeight]=React.useState(0);
 window.__head=height=>flushSync(()=>setHeight(height));
 return <div style={{height,flexShrink:0}}>{children}</div>;
}`;
const bridge = `
export const bridge={state:'open',on:()=>()=>{},onState:fn=>{fn('open');return()=>{};},invoke:async(cmd,args)=>{
 window.__commands.push(cmd);
 if(cmd==='list_workspaces')return [{id:'pa',name:'Prepend QA',primary_path:'/test'}];
 if(cmd==='chat_index_list')return [{id:'prepend',projectId:'pa',title:'Prepend QA chat',modelId:'claude-sonnet',sessionId:null,access:'full',createdAt:1,updatedAt:2,pinned:false}];
 if(cmd==='chat_queue_state')return {live:false,queuedTurnIds:[]};
 if(cmd==='git_status')return {branch:'test',files:[]};
 if(cmd==='orchestration_snapshot')return {runs:[],tasks:[],attempts:[],gates:[],messages:[],xpAwards:[]};
 if(cmd==='chat_page'){
  const frames=window.__appFrames;
  if(args.before!=null){window.__calls.push('chat_page');await new Promise(r=>setTimeout(r,150));return {events:frames.filter(f=>f.seq<args.before),context:[],before:null};}
  const events=window.__appServer?frames.slice(-12):frames;
  return {events,context:[],before:window.__appServer?events[0].seq:null};
 }
 if(cmd==='resolve_paths')return args.paths.map(p=>p.startsWith('/test/')?p:null);
 return [];
},fetchFile:async path=>{
 window.__media.push({path,at:performance.now()});
 await new Promise(r=>setTimeout(r,220));
 return new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420"><rect width="640" height="420" fill="steelblue"/></svg>'],{type:'image/svg+xml'});
}};`;
const server = await createServer({root:webRoot,configFile:join(webRoot,"vite.config.ts"),server:{host:"127.0.0.1",port:0,strictPort:false},plugins:[{
 name:"chat-prepend-fixture",enforce:"pre",
 resolveId(id,importer){if(id==="/__prepend.tsx"||id==="/__prepend-head.tsx")return id;if(/\/lib\/bridge(?:\.ts)?$/.test(id)||(id==="./bridge"&&importer?.includes("/src/lib/")))return "\0prepend-bridge";},
 load(id){
  if(id==="/__prepend.tsx")return fixture;if(id==="/__prepend-head.tsx")return deferredHead;if(id==="\0prepend-bridge")return bridge;
  // Reproduce the exact pre-fix revision without modifying the worktree.
  if(process.env.OCTIQ_PREPEND_BASELINE) for(const file of ['src/App.tsx','src/components/MessageList.tsx','src/lib/chatPlace.ts','src/styles.css']){
   if(id===normalizePath(join(webRoot,file)))return execFileSync('git',['show',process.env.OCTIQ_PREPEND_BASELINE+':web/'+file],{cwd:webRoot,encoding:'utf8'});
  }
 },
 transform(code,id){
  if(id!==normalizePath(join(webRoot,'src/App.tsx')))return;
  assert(code.includes('head={transcriptHead}'),'App must pass the real transcript head');
  return "import {PrependHead} from '/__prepend-head.tsx';\n"+code.replace('head={transcriptHead}','head={window.__expiryScene ? <PrependHead>{transcriptHead}</PrependHead> : transcriptHead}');
 },
 configureServer(vite){vite.middlewares.use(async(req,res,next)=>{if(req.url?.split("?")[0]!=="/__prepend")return next();res.setHeader("Content-Type","text/html");res.end(await vite.transformIndexHtml("/__prepend",'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__prepend.tsx"></script></body></html>'));});}
}]});
let browser;
const report={artifacts,checks:[],regressions:[],expiry:[]};
try {
 await server.listen();
 browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
 report.browser=browser.version();
 const scenes=process.env.OCTIQ_PREPEND_APP_ONLY?['app-window','app-server']:['window','server','app-window','app-server'];
 for(const width of (process.env.OCTIQ_PREPEND_REGRESSIONS_ONLY||process.env.OCTIQ_PREPEND_EXPIRY_ONLY?[]:[1280,390])) for(const scene of scenes) for(const trigger of ['button','scroll']){
  const page=await browser.newPage({viewport:{width,height:844},isMobile:width===390,hasTouch:width===390});
  page.setDefaultNavigationTimeout(120000);
  const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.stack);});
  await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/__prepend?scene='+scene+'#/p/prepend-qa/c/prepend');
  try{await page.locator('[data-map-turn]').first().waitFor();}catch(error){console.error(await page.locator('body').innerText(),await page.evaluate(()=>window.__commands));throw error;}
  await page.evaluate(()=>document.fonts.ready);
  await page.waitForTimeout(500);
  // A real reading gesture leaves bottom-stick, then expires before aiming
  // at the button. Otherwise an initial preview can pin the setup back down.
  await page.locator('.msgs').evaluate(el=>{el.dispatchEvent(new Event('wheel'));el.scrollTop=400;});
  await page.waitForTimeout(1000);
  // Aim at the load row, without firing auto-load until the trace starts.
  await page.locator('.msgs').evaluate(el=>{el.scrollTop=0;});
  await page.waitForTimeout(500);
  await page.evaluate(()=>{
   const el=document.querySelector('.msgs'),anchor=el.querySelector('[data-map-turn]');
   window.__anchor=anchor;window.__trace=[];window.__rawRaf=[];window.__start=performance.now();
   window.__first=anchor.dataset.mapTurn;
   window.__snapshot=()=>({ms:performance.now()-window.__start,scrollTop:el.scrollTop,top:anchor.getBoundingClientRect().top,first:el.querySelector('[data-map-turn]')?.dataset.mapTurn,loadRowHeight:el.querySelector('.history-more')?.getBoundingClientRect().height??null});
   window.__record=()=>{const sample=window.__snapshot();window.__rawRaf.push(sample);window.__trace.push({...sample});};
   window.__record();window.__sampling=true;
   // rAF runs before ResizeObserver. Keep the untouched raw sample as well as
   // the position after layout callbacks, which is what reaches that paint.
   // Registered after MessageList's observer, so its correction runs first.
   window.__layoutWatch=new ResizeObserver(()=>{if(window.__sampling)window.__trace[window.__trace.length-1]=window.__snapshot();});
   window.__layoutWatch.observe(el.querySelector('.msgs-inner'));
   const frame=()=>{window.__record();if(window.__sampling)requestAnimationFrame(frame);};requestAnimationFrame(frame);
  });
  if(trigger==='button') await page.getByRole('button',{name:'Load earlier messages',exact:true}).click();
  else await page.locator('.msgs').evaluate(el=>{el.dispatchEvent(new Event('wheel'));el.scrollTop=1;});
  await page.waitForFunction(()=>document.querySelector('[data-map-turn]')?.dataset.mapTurn!==window.__first);
  await page.waitForTimeout(1100);
  const result=await page.evaluate(()=>{window.__sampling=false;window.__layoutWatch.disconnect();return {trace:window.__trace,rawRaf:window.__rawRaf,calls:window.__calls,media:window.__media,connected:window.__anchor.isConnected};});
  const base=result.trace[0].top;
  const drift=Math.max(...result.trace.map(f=>Math.abs(f.top-base)));
  const rawRafDrift=Math.max(...result.rawRaf.map(f=>Math.abs(f.top-base)));
  assert.deepEqual([...new Set(result.trace.map(f=>f.loadRowHeight).filter(h=>h!==null))],[68]);
  const check={width,scene,trigger,drift,rawRafDrift,...result,errors};report.checks.push(check);
  console.log(JSON.stringify({width,scene,trigger,drift,rawRafDrift,initial:result.trace[0],last:result.trace.at(-1),calls:result.calls,media:result.media.length,errors}));
  await page.close();
 }
 // A quiet hold must actually expire, rather than leave native anchoring off
 // until the next ResizeObserver (which would already have missed this growth).
 for(const width of [1280,390]) for(const delayedTimer of (process.env.OCTIQ_CAPTURE_ONLY?[false]:[false,true])){
  const page=await browser.newPage({viewport:{width,height:844},isMobile:width===390,hasTouch:width===390});
  page.setDefaultNavigationTimeout(120000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/__prepend?scene=app-server-expiry#/p/prepend-qa/c/prepend');
  await page.locator('[data-map-turn]').first().waitFor();await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(800);
  await page.locator('.msgs').evaluate(el=>{el.dispatchEvent(new Event('wheel'));el.scrollTop=400;});await page.waitForTimeout(600);
  await page.locator('.msgs').evaluate(el=>el.scrollTop=0);await page.waitForTimeout(500);
  await page.getByRole('button',{name:'Load earlier messages',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-map-turn]')?.dataset.mapTurn==='prompt-0');
  await page.waitForTimeout(1000);
  const snap=()=>page.locator('.msgs').evaluate(el=>({scrollTop:el.scrollTop,y:el.querySelector('[data-map-turn="prompt-30"]').getBoundingClientRect().top,style:getComputedStyle(el).overflowAnchor}));
  const held=await snap();
  let before,after;
  if(!delayedTimer){
   await page.waitForTimeout(6500);before=await snap();
   await page.evaluate(()=>window.__head(200));await page.waitForTimeout(300);after=await snap();
  }else{
   before=held;
   // A blocked rendering update can run layout/RO past the deadline before
   // the timeout gets a task. Record after MessageList's RO, before paint.
   after=await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>{
    const el=document.querySelector('.msgs');
    const observer=new ResizeObserver(()=>{
     observer.disconnect();resolve({scrollTop:el.scrollTop,y:el.querySelector('[data-map-turn="prompt-30"]').getBoundingClientRect().top,style:getComputedStyle(el).overflowAnchor});
    });observer.observe(el.querySelector('.msgs-inner'));
    const until=performance.now()+6500;while(performance.now()<until){}
    window.__head(200);
   })));
  }
  const result={width,scene:'app-server',delayedTimer,held,before,after,drift:Math.abs(after.y-before.y),errors};
  report.expiry.push(result);console.log('EXPIRY '+JSON.stringify(result));await page.close();
 }
 if(!process.env.OCTIQ_CAPTURE_ONLY&&!process.env.OCTIQ_PREPEND_APP_ONLY&&!process.env.OCTIQ_PREPEND_EXPIRY_ONLY) for(const width of [1280,390]){
  const page=await browser.newPage({viewport:{width,height:844},isMobile:width===390,hasTouch:width===390,reducedMotion:'reduce'});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const go=async scene=>{
   await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/__prepend?scene='+scene);
   await page.locator('[data-map-turn]').first().waitFor();await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(800);
  };
  const reading=async top=>{
   await page.locator('.msgs').evaluate((el,top)=>{el.dispatchEvent(new Event('wheel'));el.scrollTop=top;},top);
   await page.waitForTimeout(600);
  };
  const position=()=>page.locator('.msgs').evaluate(el=>({top:el.scrollTop,bottom:el.scrollHeight-el.clientHeight-el.scrollTop}));
  const anchoring=()=>page.locator('.msgs').evaluate(el=>getComputedStyle(el).overflowAnchor);
  await go('window');await reading(500);
  const left=await position();
  const anchor=await page.locator('.msgs').evaluate(scroller=>{
   const nodes=[...scroller.querySelectorAll('[data-map-turn]')];
   const el=nodes.filter(node=>node.getBoundingClientRect().top<=scroller.getBoundingClientRect().top).at(-1)||nodes[0];
   return {id:el.dataset.mapTurn,top:el.getBoundingClientRect().top};
  });
  await page.evaluate(()=>window.__switch('other'));
  await page.waitForFunction(()=>{const el=document.querySelector('.msgs');return el.scrollHeight-el.clientHeight-el.scrollTop<2;});
  assert.equal(await anchoring(),'auto','chat switch must release the old hold');
  await page.evaluate(()=>window.__switch('prepend'));
  await page.waitForFunction(anchor=>Math.abs(document.querySelector('[data-map-turn="'+anchor.id+'"]').getBoundingClientRect().top-anchor.top)<2,anchor);
  await page.evaluate(()=>window.__head(160));
  await page.waitForFunction(anchor=>Math.abs(document.querySelector('[data-map-turn="'+anchor.id+'"]').getBoundingClientRect().top-anchor.top)<2,anchor);
  await page.waitForTimeout(400);
  const held=await page.locator('[data-map-turn="'+anchor.id+'"]').evaluate(el=>el.getBoundingClientRect().top);
  assert.equal(await anchoring(),'none','saved place must own anchoring during its hold');
  assert(Math.abs(held-anchor.top)<2,'open-chat place must survive deferred head layout: '+JSON.stringify({width,anchor,held,position:await position(),saved:await page.evaluate(()=>localStorage.getItem('octiq.v2.chatPlaces'))}));
  // A map jump supersedes that restore; later layout must not rewind it.
  // The map is intentionally hidden in the phone layout.
  if(width>=620){
  await page.locator('.conversation-map-point').nth(3).click();
  await page.waitForTimeout(150);
  const mapped=await position();assert(Math.abs(mapped.top-left.top)>100);
  const mappedHeld=await page.locator('[data-map-turn]').nth(3).evaluate(el=>el.getBoundingClientRect().top);
  await page.evaluate(()=>window.__head(260));await page.waitForTimeout(200);
  const mappedAfter=await page.locator('[data-map-turn]').nth(3).evaluate(el=>el.getBoundingClientRect().top);
  assert(Math.abs(mappedAfter-mappedHeld)<2,'map jump must end the old hold');
  assert.equal(await anchoring(),'auto','map jump must release anchoring');
  }
  await page.getByRole('button',{name:'Jump to the end',exact:true}).click();
  assert.equal(await anchoring(),'auto','jump to end must release anchoring');
  await page.waitForFunction(()=>{const el=document.querySelector('.msgs');return el.scrollHeight-el.clientHeight-el.scrollTop<2;});
  await page.waitForTimeout(500);
  await page.evaluate(()=>window.__append());await page.waitForTimeout(300);
  await page.waitForFunction(()=>{const el=document.querySelector('.msgs');return el.scrollHeight-el.clientHeight-el.scrollTop<2;});
  assert((await position()).bottom<2,'append must stick at bottom: '+JSON.stringify(await position()));
  await page.evaluate(()=>window.__grow());await page.waitForTimeout(300);
  await page.waitForFunction(()=>{const el=document.querySelector('.msgs');return el.scrollHeight-el.clientHeight-el.scrollTop<2;});
  assert((await position()).bottom<2,'stream growth must stick at bottom');
  // Touch/momentum scroll events continue after touchend without another
  // touchmove. They must cancel the hold, and never be treated as corrections.
  await go('window');await reading(400);
  await page.locator('.msgs').evaluate(el=>el.scrollTop=0);await page.waitForTimeout(500);
  await page.getByRole('button',{name:'Load earlier messages',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-map-turn]')?.dataset.mapTurn==='prompt-24');
  await page.locator('.msgs').evaluate(el=>{el.dispatchEvent(new Event('touchstart'));el.scrollTop+=90;});
  assert.equal(await anchoring(),'auto','touch input must release anchoring');
  for(let i=1;i<=4;i++){
   await page.waitForTimeout(120);
   const step=await page.locator('.msgs').evaluate(el=>{const before=el.scrollTop;el.scrollTop+=20;return el.scrollTop-before;});
   assert.equal(step,20,'momentum input must remain free to move');
  }
  await page.waitForTimeout(800);
  const momentumAfter=await page.locator('[data-map-turn="prompt-30"]').evaluate(el=>el.getBoundingClientRect().top);
  await page.evaluate(()=>{window.__append();window.__grow();});await page.waitForTimeout(500);
  const streamingAfter=await page.locator('[data-map-turn="prompt-30"]').evaluate(el=>el.getBoundingClientRect().top);
  assert(Math.abs(streamingAfter-momentumAfter)<2,'streaming must not repin a reader after momentum');
  assert((await position()).bottom>1000,'momentum must leave bottom-stick off');
  // Keep reading while the server page is in flight; capture the latest view.
  await go('server');await reading(400);
  await page.locator('.msgs').evaluate(el=>el.scrollTop=0);await page.waitForTimeout(500);
  await page.evaluate(()=>{
   const el=document.querySelector('.msgs');window.__during=el.querySelector('[data-map-turn]');
   el.querySelector('.history-more button').click();el.dispatchEvent(new Event('touchstart'));el.scrollTop=400;
  });
  await page.waitForTimeout(40);
  const during=await page.evaluate(()=>window.__during.getBoundingClientRect().top);
  await page.waitForFunction(()=>document.querySelector('[data-map-turn]')?.dataset.mapTurn==='prompt-0');
  await page.waitForTimeout(1000);
  const after=await page.evaluate(()=>window.__during.getBoundingClientRect().top);
  assert(Math.abs(after-during)<2,'fetch must preserve the latest reading position');
  await go('server');await reading(400);
  await page.locator('.msgs').evaluate(el=>el.scrollTop=0);await page.waitForTimeout(500);
  await page.evaluate(()=>window.__failEarlier=true);
  await page.getByRole('button',{name:'Load earlier messages',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Could not load earlier messages'}).waitFor();
  assert.equal(await anchoring(),'auto','page error must release anchoring');
  assert(await page.getByRole('button',{name:'Load earlier messages',exact:true}).isEnabled(),'failed page must release the pending row');
  await page.evaluate(()=>window.__failEarlier=false);
  await page.getByRole('button',{name:'Load earlier messages',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-map-turn]')?.dataset.mapTurn==='prompt-0');
  await go('server');await reading(400);
  await page.locator('.msgs').evaluate(el=>el.scrollTop=0);await page.waitForTimeout(500);
  const emptyAnchor=await page.locator('[data-map-turn]').first().evaluate(el=>el.getBoundingClientRect().top);
  await page.evaluate(()=>window.__emptyEarlier=true);
  await page.getByRole('button',{name:'Load earlier messages',exact:true}).click();
  await page.getByText('Start of conversation',{exact:true}).waitFor();await page.waitForTimeout(400);
  assert(Math.abs(await page.locator('[data-map-turn]').first().evaluate(el=>el.getBoundingClientRect().top)-emptyAnchor)<2,'context-only page must settle without a jump');
  // Keep a reference to the detached scroller: cleanup must clear its hold as
  // well as the timer, rather than wait for another layout that cannot arrive.
  const detached=await page.locator('.msgs').elementHandle();
  assert.equal(await anchoring(),'none');
  await page.evaluate(()=>window.__unmount());
  assert.equal(await detached.evaluate(el=>el.style.overflowAnchor),'','unmount must remove the anchoring override');
  await detached.dispose();
  assert.deepEqual(errors,[]);
  report.regressions.push({width,openPlace:true,deferredHead:true,mapJump:width>=620,streamStick:true,momentum:true,readDuringFetch:true,errorRetry:true,contextOnly:true,holdCleanup:true,errors});
  console.log('PASS regressions '+width+'px');await page.close();
 }
 await writeFile(join(artifacts,'frames.json'),JSON.stringify(report,null,2));
 if(!process.env.OCTIQ_CAPTURE_ONLY) for(const check of report.expiry){assert.deepEqual(check.errors,[]);assert.equal(check.before.style,check.delayedTimer?'none':'auto');assert.equal(check.after.style,'auto');assert(check.drift<=2,'late head growth must stay anchored: '+JSON.stringify(check));}
 if(!process.env.OCTIQ_CAPTURE_ONLY) for(const check of report.checks){assert.deepEqual(check.errors,[]);assert(check.connected);assert(check.drift<=2,JSON.stringify({width:check.width,scene:check.scene,trigger:check.trigger,drift:check.drift}));assert.equal(check.calls.length,check.scene.endsWith('server')?1:0);}
 console.log('Evidence: '+join(artifacts,'frames.json'));
} finally {await writeFile(join(artifacts,'frames.json'),JSON.stringify(report,null,2));await browser?.close();await server.close();}
