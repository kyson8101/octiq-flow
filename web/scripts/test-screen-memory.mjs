// Real production App in a disposable browser; fixture command socket only.
// SCREEN_CONTROL_DIST enables exact-source before/after. SCREEN_LEDGER_DIR may
// contain read-only full.json, brief.json and Rust-projected summary.json.
// No live profile, agent, deployment or token is used by this harness.
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const web=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(join(web,'package.json'));
const {preview}=await import(pathToFileURL(require.resolve('vite')).href);
const {chromium}=await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href);
const turns=1044, textBytes=163840, project={id:'memory',name:'Memory fixture',primary_path:'/fixture',paths:['/fixture'],env:{}};
const frames=(id,turn)=>[
 {seq:turn*3+1,event:{type:'user',uuid:`u-${turn}`,message:{content:[{type:'text',text:`Question ${id} ${turn}.`}]}}},
 {seq:turn*3+2,event:{type:'assistant',message:{id:`a-${turn}`,content:[{type:'text',text:`Answer ${id} ${turn}.`},{type:'tool_use',id:`c-${turn}`,name:'Read',input:{path:'/fixture/file'}}]}}},
 {seq:turn*3+3,event:{type:'user',message:{content:[{type:'tool_result',tool_use_id:`c-${turn}`,content:'x'.repeat(textBytes)}]}}},
];
const frameBytes=Buffer.byteLength(JSON.stringify(frames('memory-0',0)));
const empty={runs:[],tasks:[],attempts:[],gates:[],messages:[],notifications:[],reports:{}};
let full=empty,brief=empty,summary={...empty,summary:true};
if(process.env.SCREEN_LEDGER_DIR){
 [full,brief,summary]=await Promise.all(['full','brief','summary'].map(async name=>JSON.parse(await readFile(join(process.env.SCREEN_LEDGER_DIR,name+'.json'),'utf8'))));
}
const scope=(s,id)=>({...s,runs:s.runs.filter(r=>r.id===id),tasks:s.tasks.filter(t=>t.runId===id),attempts:s.attempts.filter(a=>a.runId===id),gates:s.gates.filter(g=>g.runId===id),nativeDecisions:(s.nativeDecisions??[]).filter(d=>d.runId===id),messages:s.messages.filter(m=>m.runId===id),notifications:(s.notifications??[]).filter(n=>n.runId===id),services:(s.services??[]).filter(i=>i.runId===id),bridges:(s.bridges??[]).filter(i=>i.runId===id),peerAsks:(s.peerAsks??[]).filter(i=>i.runId===id)});
const rows=Array.from({length:12},(_,i)=>({id:`memory-${i}`,projectId:'memory',title:`Memory ${i}`,createdAt:i+1,updatedAt:i+1,modelId:'claude:sonnet-4-6',access:'read',sessionId:`s${i}`}));
const results=[];
for(const [label,dist] of [['before',process.env.SCREEN_CONTROL_DIST],['after',process.env.OCTIQ_TEST_DIST]]){
 if(!dist)continue;
 const server=await preview({root:web,build:{outDir:resolve(dist)},preview:{host:'127.0.0.1',port:0,strictPort:false}});
 let browser;
 try{
  browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH,headless:true,args:['--enable-precise-memory-info','--js-flags=--expose-gc']});
  for(const width of (process.env.SCREEN_WIDTHS??"1280,390").split(",").map(Number)){
   const context=await browser.newContext({viewport:{width,height:844}});
   const counters={receivedBytes:0,commands:{},replyBytes:{},heavyFrames:0,activityFrames:0,recordFrames:0};
   let socket,selected=null,firstInvoke;
   const send = value => { const raw=JSON.stringify(value);counters.receivedBytes+=Buffer.byteLength(raw);socket.send(raw); };
   await context.route('**/token',route=>route.fulfill({body:'fixture-token'}));
   await context.routeWebSocket(/\/ws\?/,ws=>{socket=ws;ws.onMessage(raw=>{
    const call=JSON.parse(String(raw));if(call.t!=='invoke')return;
    firstInvoke??=call.cmd;counters.commands[call.cmd]=(counters.commands[call.cmd]??0)+1;
    const a=call.args??{},id=String(a.key??'').replace(/^chat:/,'');let result=[];
    switch(call.cmd){
     case 'chat_subscribe':selected=new Set(a.chatKeys);result={chatKeys:[...selected]};break;
     case 'list_workspaces':result=[project];break;
     case 'chat_index_list':result=rows;break;
     case 'orchestration_snapshot':result=a.runId?scope(full,a.runId):brief;break;
     case 'orchestration_summary':result=a.runId?scope(summary,a.runId):summary;break;
     case 'orchestration_run_detail':result=scope(full,a.runId);break;
     case 'chat_page':{
      const last=a.before==null?turns-1:Math.floor((a.before-2)/3);
      const first=Math.max(0,last-2);result={events:[],context:[],before:first?first*3+1:null};
      for(let n=first;n<=last;n++)result.events.push(...frames(id,n));
      counters.recordFrames+=result.events.length;break;
     }
     case 'chat_since':
      if(id==='memory-0'&&a.after===600*3){result=[];for(let n=600;n<turns;n++)result.push(...frames(id,n));counters.recordFrames+=result.length;}
      else result=[];
      break;
     case 'chat_task':result=null;break;
     case 'resolve_paths':result=a.paths.map(()=>null);break;
     case 'usage_summary':result={sessions:[],totals:{}};break;
    }
    const reply=JSON.stringify({t:'reply',id:call.id,ok:true,result});counters.replyBytes[call.cmd]=(counters.replyBytes[call.cmd]??0)+Buffer.byteLength(reply);counters.receivedBytes+=Buffer.byteLength(reply);ws.send(reply);
   });});
   // Seed exactly the old count-capped v1 cache. Both clients see the same
   // durable 171 MB record. Its first 600 turns fit in one old IDB row;
   // a legacy catch-up downloads the remaining 444 turns whole. The new cache
   // upgrades without deserializing it and reads only the recent page.
   await context.addInitScript(({turns,textBytes})=>{
    if(!/^https?:$/.test(location.protocol))return;
    window.__seeded=new Promise((resolve,reject)=>{
     const opened=indexedDB.open('octiq.chat-cache',1);
     opened.onupgradeneeded=()=>{const table=opened.result.createObjectStore('checkpoints',{keyPath:'id'});table.createIndex('updatedAt','updatedAt');};
     opened.onerror=()=>reject(opened.error);
     opened.onsuccess=()=>{
      const db=opened.result,tx=db.transaction('checkpoints','readwrite');
      const messages=Array.from({length:600},(_,n)=>[{id:`u-${n}`,role:'user',streaming:false,echo:`u-${n}`,blocks:[{kind:'text',text:`Question memory-0 ${n}.`}]},{id:`a-${n}`,role:'assistant',streaming:false,blocks:[{kind:'text',text:`Answer memory-0 ${n}.`},{kind:'tool',id:`c-${n}`,name:'Read',args:{path:'/fixture/file'},argsJson:JSON.stringify({path:'/fixture/file'}),state:'done',result:'x'.repeat(textBytes)}]}]).flat();
      tx.objectStore('checkpoints').put({id:'memory-0',seq:600*3,updatedAt:1,state:{messages,agents:[],background:[],busy:false,notices:[]}});
      tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error??new Error('seed aborted'));
     };
    });
   },{turns,textBytes});
   const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));page.setDefaultTimeout(120000);
   try{
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?token=fixture-token`,{waitUntil:'domcontentloaded',timeout:180000});
    console.log('seed-start',label,width);
    await page.evaluate(()=>Promise.race([window.__seeded,new Promise((_,reject)=>setTimeout(()=>reject(new Error('seed did not complete')),60000))]));
    console.log('seed-done',label,width);
    await page.evaluate(()=>{location.hash='#/c/memory-0';});
    await page.locator('.msgs').getByText(`Answer memory-0 ${turns-1}.`,{exact:true}).waitFor();
    const cdp=await context.newCDPSession(page);await cdp.send('Performance.enable');
    const measure=async stage=>{
     await cdp.send('HeapProfiler.collectGarbage');
     const metrics=await cdp.send('Performance.getMetrics');
     return{stage,...Object.fromEntries(metrics.metrics.filter(m=>['JSHeapUsedSize','JSHeapTotalSize','Nodes','Documents'].includes(m.name)).map(m=>[m.name,m.value]))};
    };
    console.log('large-record-drawn',label,width);
    const initial=await measure('large-record-open');
    console.log('initial-gc',label,width,initial.JSHeapUsedSize);
    // Navigation and repeated broad status invalidations exercised the old
    // closure retention. Background tool bodies exercise wire subscriptions.
    for(let i=1;i<=18;i++){
     const id=`memory-${i%12}`;await page.evaluate(id=>{location.hash='#/c/'+id;},id);
     await page.locator('.msgs').getByText(`Answer ${id} ${turns-1}.`,{exact:true}).waitFor();
     for(let n=0;n<8;n++){
      const key=`chat:hidden-${n}`;
      if(selected!==null&&!selected.has(key)){counters.activityFrames++;send({t:'event',event:'chat-stream-activity',payload:{key,seq:i,running:true,busy:true,turnId:`t${n}`,lastActivityAt:1,work:true}});}
      else{for(const f of frames(`hidden-${n}`,i)){counters.heavyFrames++;send({t:'event',event:'chat-event',payload:{key,seq:f.seq,event:f.event}});}}
     }
     send({t:'event',event:'orchestration-changed',payload:{runId:summary.runs[0]?.id,change:'fixture',revision:`fixture:${i}`}});
     await page.waitForTimeout(150);
    }
    await page.waitForTimeout(2000);const end=await measure('after-18-switches');
    const comparisonCounters=structuredClone(counters);
    let paging=null;
    if(label==='after'&&process.env.SCREEN_SKIP_PAGING!=='1'){
     for(let n=0;n<45;n++){
      if(await page.getByRole('button',{name:'Return to latest messages',exact:true}).count())break;
      await page.getByRole('button',{name:'Load earlier messages',exact:true}).click();
      await page.getByRole('button',{name:'Load earlier messages',exact:true}).waitFor();
     }
     await page.getByRole('button',{name:'Return to latest messages',exact:true}).waitFor();
     const past=await measure('bounded-older-window');
     await page.getByRole('button',{name:'Return to latest messages',exact:true}).click();
     await page.locator('.msgs').getByText(`Answer memory-6 ${turns-1}.`,{exact:true}).waitFor();
     paging={past,returnedToLatest:true};
    }
    assert.deepEqual(errors,[]);
    if(label==='after'){assert.equal(firstInvoke,'chat_subscribe');assert.equal(counters.heavyFrames,0);assert.equal(counters.commands.orchestration_snapshot??0,0);assert.equal(counters.commands.chat_since??0,0);}
    const result={label,width,recordBytesApprox:frameBytes*turns,ledgerWireBytes:{full:Buffer.byteLength(JSON.stringify(full)),brief:Buffer.byteLength(JSON.stringify(brief)),summary:Buffer.byteLength(JSON.stringify(summary))},initial,end,counters:comparisonCounters,paging,errors};
    results.push(result);console.log(JSON.stringify(result));await cdp.detach();
   }finally{await context.close();}
  }
 }finally{await browser?.close();await new Promise(resolve=>server.httpServer.close(resolve));}
}
console.log(JSON.stringify({results}));
