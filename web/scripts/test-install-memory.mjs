// Disposable production-App scene. Synthetic install metadata, no live data.
// Real-time by default; INSTALL_MINUTES only shortens a diagnostic run.
import { createRequire } from 'node:module';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const web=resolve(dirname(fileURLToPath(import.meta.url)),'..'),require=createRequire(join(web,'package.json'));
const {preview}=await import(pathToFileURL(require.resolve('vite')).href);
const {chromium}=await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href);
const minutes=Number(process.env.INSTALL_MINUTES??20),changes=363,duration=minutes*60000;
const project={id:'memory',name:'Memory fixture',primary_path:'/fixture',paths:['/fixture'],env:{}};
const rows=Array.from({length:1500},(_,i)=>({id:`memory-${i}`,projectId:'memory',title:`Memory ${i}`,doneAt:i>=12?2e15:null,latestResponse:'Preview '+String(i).padStart(4,'0')+' '+ 'p'.repeat(980),createdAt:i+1,updatedAt:i+1,modelId:'claude:sonnet-4-6',access:'read',sessionId:`s${i}`}));
const empty={summary:true,runs:[],tasks:[],attempts:[],gates:[],nativeDecisions:[],messages:[],notifications:[],reports:{},revision:'fixture:1',runRevisions:{}};
const ledger=structuredClone(empty);
for(let i=0;i<300;i++){
 const id=`old-${i}`;ledger.runs.push({id,objective:`Old run ${i}`,coordinatorChatKey:`chat:history-${i}`,workspaceId:'memory',rootPath:'/fixture',status:i%3===0?'stopped':i%3===1?'closed':'completed',archivedAt:i%3===2?1:null,maxConcurrent:3,createdAt:1,updatedAt:1});ledger.runRevisions[id]='fixture:1';
 for(let j=0;j<8;j++){
  const taskId=`t-${i}-${j}`,workerChatKey=`chat:orch-${i}-${j}`;
  ledger.tasks.push({id:taskId,runId:id,title:`Task ${j}`,spec:'',status:'completed',dependsOn:[],activeAttemptId:`a-${i}-${j}`,createdAt:1,updatedAt:1});
  ledger.attempts.push({id:`a-${i}-${j}`,runId:id,taskId,workerChatKey,number:1,agent:'codex',access:'auto',status:'completed',cwd:'/fixture',branch:'fixture',isWorktree:true,filesModified:[],execution:{state:'completed',retryCount:0},createdAt:1,updatedAt:1});
  ledger.reports[workerChatKey]={objective:'',nextStep:'',steps:Array.from({length:8},(_,n)=>({title:`Checklist ${n} `+'c'.repeat(240),state:'done'})),reportedAt:1};
 }
}
const scope=(s,ids)=>({...s,runs:s.runs.filter(r=>ids.has(r.id)),tasks:s.tasks.filter(r=>ids.has(r.runId)),attempts:s.attempts.filter(r=>ids.has(r.runId)),runRevisions:Object.fromEntries(Object.entries(s.runRevisions).filter(([id])=>ids.has(id))),reports:Object.fromEntries(Object.entries(s.reports).filter(([key])=>s.attempts.some(a=>ids.has(a.runId)&&a.workerChatKey===key)))});
const parents=Object.fromEntries(ledger.attempts.map(a=>[a.workerChatKey.slice(5),`history-${a.runId.slice(4)}`]));
const results=[];
for(const label of (process.env.INSTALL_VARIANTS??'before,after').split(',')){
 const dist=process.env[label==='before'?'SCREEN_CONTROL_DIST':'OCTIQ_TEST_DIST'];if(!dist)continue;
 const server=await preview({root:web,build:{outDir:resolve(dist)},preview:{host:'127.0.0.1',port:0,strictPort:false}});
 try{await Promise.all([1280,390].map(async width=>{
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH,headless:true,args:['--enable-precise-memory-info','--js-flags=--expose-gc']});
  try{
   const context=await browser.newContext({viewport:{width,height:844}}),counters={bytesReceived:0,commands:{}};
   const entries=structuredClone(rows);let socket;
   await context.route('**/token',r=>r.fulfill({body:'fixture-token'}));
   const send=value=>{const raw=JSON.stringify(value);counters.bytesReceived+=Buffer.byteLength(raw);socket.send(raw);};
   await context.routeWebSocket(/\/ws\?/,ws=>{socket=ws;ws.onMessage(raw=>{
    const call=JSON.parse(String(raw));if(call.t!=='invoke')return;
    counters.commands[call.cmd]=(counters.commands[call.cmd]??0)+1;
    const a=call.args??{},id=String(a.key??'').replace(/^chat:/,'');let result=[];
    switch(call.cmd){
     case 'chat_subscribe':result={chatKeys:a.chatKeys};break;
     case 'list_workspaces':result=[project];break;
     case 'chat_index_list':result=entries;break;
     case 'chat_index_entry':result=entries.find(row=>row.id===a.id)??null;break;
     case 'orchestration_summary':{
      const ids=new Set(ledger.runs.filter(r=>(!a.runId||a.runId===r.id)&&(!a.coordinatorChatKey||a.coordinatorChatKey===r.coordinatorChatKey)&&(!a.workspaceId||a.workspaceId===r.workspaceId)&&(label==='before'||a.includeEnded||ledger.attempts.some(t=>t.runId===r.id&&a.heldChatKeys?.includes(t.workerChatKey)))).map(r=>r.id));
      result=scope(ledger,ids);if(label==='after'){result.workerParents=parents;result.runCoordinators=ledger.runs.map(r=>r.coordinatorChatKey);}break;
     }
     case 'orchestration_run_detail':result={...scope(ledger,new Set([a.runId])),summary:false};break;
     case 'orchestration_snapshot':result=ledger;break;
     case 'chat_page':result={events:[{seq:1,event:{type:'user',uuid:`u-${id}`,message:{content:[{type:'text',text:`Question ${id}.`}]} }},{seq:2,event:{type:'assistant',message:{id:`a-${id}`,content:[{type:'text',text:`Answer ${id}.`}]}}}],context:[],before:null};break;
     case 'chat_task':result=null;break;
     case 'resolve_paths':result=a.paths.map(()=>null);break;
     case 'usage_summary':result={claude:{available:false},codex:{available:false}};break;
    }
    send({t:'reply',id:call.id,ok:true,result});
   });});
   const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));page.setDefaultTimeout(60000);
   await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?token=fixture-token#/c/memory-0`);
   await page.locator('.msgs').getByText('Answer memory-0.',{exact:true}).waitFor();
   const cdp=await context.newCDPSession(page);await cdp.send('Performance.enable');
   const measure=async stage=>{await cdp.send('HeapProfiler.collectGarbage');const {metrics}=await cdp.send('Performance.getMetrics');const result={stage,heapUsed:metrics.find(m=>m.name==='JSHeapUsedSize').value,bytesReceived:counters.bytesReceived,chatIndexCalls:counters.commands.chat_index_list??0};console.log(JSON.stringify({label,width,...result}));return result;};
   const initial=await measure('open');
   for(let i=1;i<=18;i++){
    const id=`memory-${i%12}`;console.log('switch-start',label,width,i);await page.evaluate(id=>{location.hash='#/c/'+id;},id);
    await page.locator('.msgs').getByText(`Answer ${id}.`,{exact:true}).waitFor().catch(async e=>{console.log('navigation-failed',label,width,id,await page.locator('body').innerText(),counters);throw e;});
    entries[i%12]={...entries[i%12],readAt:i+2};
    send({t:'event',event:'chat-index-changed',payload:{id,gone:false,entry:entries[i%12]}});
    await page.waitForTimeout(350);
   }
   await page.waitForTimeout(1500);const switches=await measure('18-switches');
   if(process.env.INSTALL_SWITCHES_ONLY==='1'){
    assert.deepEqual(errors,[]);if(label==='after')assert.equal(switches.chatIndexCalls,1);
    results.push({label,width,scenario:'18-switches-only',initial,switches,indexBytes:Buffer.byteLength(JSON.stringify(rows)),commands:counters.commands,errors});return;
   }
   const started=Date.now();
   for(let i=0;i<changes;i++){
    const wait=started+i*duration/changes-Date.now();if(wait>0)await page.waitForTimeout(wait);
    const row=entries[100+i]={...entries[100+i],updatedAt:10000+i};
    send({t:'event',event:'chat-index-changed',payload:{id:row.id,gone:false,entry:row}});
    send({t:'event',event:'chat-task',payload:{chatId:`orch-historic-${i}`,report:{objective:'historical',nextStep:'',reportedAt:10000+i,steps:Array.from({length:50},(_,n)=>({title:`${i}-${n} `+'z'.repeat(500),state:'done'}))}}});
   }
   const wait=started+duration-Date.now();if(wait>0)await page.waitForTimeout(wait);
   await page.waitForTimeout(1000);const end=await measure('20-minute-scene');
   assert.deepEqual(errors,[]);if(label==='after')assert.equal(end.chatIndexCalls,1);
   results.push({label,width,minutes,events:changes,indexBytes:Buffer.byteLength(JSON.stringify(rows)),ledgerBytes:Buffer.byteLength(JSON.stringify(ledger)),initial,switches,end,elapsedMs:Date.now()-started,commands:counters.commands,errors});
  }finally{await browser.close();}
 }));}finally{await new Promise(resolve=>server.httpServer.close(resolve));}
}
if(process.env.INSTALL_RESULT)await writeFile(process.env.INSTALL_RESULT,JSON.stringify({results},null,2)+'\n');
console.log(JSON.stringify({results}));
