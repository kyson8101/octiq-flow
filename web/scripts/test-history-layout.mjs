// The run identity arrives after the chat's first paint, without old run rows.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const web=resolve(dirname(fileURLToPath(import.meta.url)),'..'),require=createRequire(join(web,'package.json'));
const {preview}=await import(pathToFileURL(require.resolve('vite')).href);
const {chromium}=await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href);
const baseline=process.env.HISTORY_LAYOUT_BASELINE==='1';
const server=await preview({root:web,build:{outDir:resolve(process.env.OCTIQ_TEST_DIST)},preview:{host:'127.0.0.1',port:0,strictPort:false}});let browser;
try{
 browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH,headless:true});
 for(const width of [1280,390]){
  const context=await browser.newContext({viewport:{width,height:844}});let socket,held=[],released=false,historyReads=0;const errors=[];
  const empty={summary:true,runs:[],tasks:[],attempts:[],gates:[],nativeDecisions:[],messages:[],notifications:[],reports:{},runRevisions:{},runCoordinators:['chat:layout'],workerParents:{}};
  if(baseline){empty.runs=[{id:'old',objective:'Closed work',coordinatorChatKey:'chat:layout',workspaceId:'p',rootPath:'/fixture',status:'closed',archivedAt:1,maxConcurrent:1,createdAt:1,updatedAt:1}];empty.runRevisions={old:'fixture:1'};}
  const row={id:'layout',projectId:'p',title:'Layout chat',createdAt:1,updatedAt:1,sessionId:'s',modelId:'claude:sonnet-4-6',access:'read'};
  await context.addInitScript(()=>{window.shifts=[];new PerformanceObserver(list=>{for(const entry of list.getEntries())if(!entry.hadRecentInput)window.shifts.push({at:entry.startTime,value:entry.value,nodes:(entry.sources??[]).map(s=>s.node?.className??s.node?.nodeName)});}).observe({type:'layout-shift',buffered:true});});
  await context.route('**/token',r=>r.fulfill({body:'fixture-token'}));
  await context.routeWebSocket(/\/ws\?/,ws=>{socket=ws;ws.onMessage(raw=>{
   const c=JSON.parse(String(raw));if(c.t!=='invoke')return;let result=[];
   if(c.cmd==='orchestration_summary'){
    if(c.args?.includeEnded)historyReads++;
    if(!released){held.push(c);return;}result=empty;
   }else if(c.cmd==='orchestration_run_detail')result={...empty,summary:false};
   else if(c.cmd==='chat_index_list')result=[row];
   else if(c.cmd==='list_workspaces')result=[{id:'p',name:'Fixture',primary_path:'/fixture',paths:['/fixture'],env:{}}];
   else if(c.cmd==='chat_page')result={before:null,context:[],events:[{seq:1,event:{type:'assistant',message:{id:'ready',content:[{type:'text',text:'Layout ready.'}]}}}]};
   else if(c.cmd==='chat_task')result=null;
   else if(c.cmd==='resolve_paths')result=c.args.paths.map(()=>null);
   else if(c.cmd==='usage_summary')result={claude:{available:false},codex:{available:false}};
   ws.send(JSON.stringify({t:'reply',id:c.id,ok:true,result}));
  });});
  const page=await context.newPage();page.setDefaultTimeout(90000);page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?token=fixture-token#/c/layout`);
  await page.locator('.msgs').getByText('Layout ready.',{exact:true}).waitFor();
  await page.waitForTimeout(1500);
  const composer=page.locator('.composer');const before=await composer.boundingBox(),at=await page.evaluate(()=>performance.now());
  assert.ok(held.length);released=true;for(const c of held)socket.send(JSON.stringify({t:'reply',id:c.id,ok:true,result:empty}));
  await page.waitForTimeout(2000);const after=await composer.boundingBox();
  assert.ok(before&&after);assert.ok(Math.abs(before.width-after.width)<1,'historical identity must not split a painted chat');
  assert.equal(await page.locator('.workflow-run-surface').isVisible(),false);assert.equal(historyReads,0,'hidden history is not requested');
  const cls=await page.evaluate(at=>window.shifts.filter(e=>e.at>=at).reduce((n,e)=>n+e.value,0),at);if(!baseline&&width===1280)assert.ok(cls<0.02,`historical membership CLS ${cls}`);
  if(width===1280)await page.getByRole('button',{name:'Show the task column',exact:true}).click();
  else await page.getByRole('button',{name:'Tasks',exact:true}).click();
  await page.locator('.workflow-run-surface').waitFor({state:'visible'});await page.waitForTimeout(200);if(!baseline)assert.ok(historyReads>0);
  assert.deepEqual(errors,[]);console.log(JSON.stringify({baseline,width,beforeWidth:before.width,afterWidth:after.width,cls,shifts:await page.evaluate(at=>window.shifts.filter(e=>e.at>=at),at),historyReads,userOpened:true,errors}));await context.close();
 }
}finally{await browser?.close();await new Promise(resolve=>server.httpServer.close(resolve));}
