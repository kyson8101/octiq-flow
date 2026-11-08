// Regression derived from the independent f507888 review probe. Fixture socket only.
import {createRequire} from 'node:module';import {readFile,mkdir,writeFile,rm} from 'node:fs/promises';import {join,resolve,isAbsolute} from 'node:path';import {pathToFileURL,fileURLToPath} from 'node:url';import assert from 'node:assert/strict';
const web=resolve(process.env.OCTIQ_WEB_ROOT||fileURLToPath(new URL('..',import.meta.url))), require=createRequire(join(web,'package.json'));
const {createServer}=await import(pathToFileURL(require.resolve('vite')).href);
const module=process.env.PLAYWRIGHT_MODULE||'playwright';
const {chromium}=await import(isAbsolute(module)||module.startsWith('.')?pathToFileURL(resolve(module)).href:module);
const scratch=join(web,'.test-plan-detail.local');let server,browser;
try {
await mkdir(scratch,{recursive:true});
await writeFile(join(scratch,'entry.tsx'),`import React from 'react';import{createRoot}from'react-dom/client';import{PlanReview}from'/src/components/PlanReview.tsx';import{useOrchestrationSnapshot,detailedRun}from'/src/lib/useOrchestrationSnapshot.ts';import{orchestrationFeed}from'/src/lib/orchestrationFeed.ts';window.detailMerge=detailedRun;window.feed=orchestrationFeed;function Scene(){const s=useOrchestrationSnapshot();return s.runs[0]?<PlanReview run={s.runs[0]} tasks={s.tasks} drafting={false} surface="chat" onRequestChanges={()=>{}} folds startOpen/>:null}createRoot(document.getElementById('root')).render(<Scene/>);`);
await writeFile(join(scratch,'index.html'),'<html><head></head><body><div id="root"></div><script type="module" src="/.test-plan-detail.local/entry.tsx"></script></body></html>');
server=await createServer({root:web,cacheDir:join(scratch,'node_modules','.vite'),configFile:join(web,'vite.config.ts'),server:{host:'127.0.0.1',port:0,strictPort:false}});
server.middlewares.use('/review',async(req,res)=>{res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/review','<html><head></head><body><div id="root"></div><script type="module" src="/.test-plan-detail.local/entry.tsx"></script></body></html>'));});await server.listen();
const full=JSON.parse(await readFile(join(web,'src/lib/__fixtures__/host/auto_plan_held_access.json'),'utf8'));
delete full.runs[0].autoPlan;
full.runs[0].planApproval.revision=1;full.tasks[0].spec='OLD_SAFE_SPEC';
const runId=full.runs[0].id;
const small=JSON.parse(JSON.stringify(full));small.summary=true;small.revision='test:1';small.runRevisions={[runId]:'test:1'};small.tasks[0].spec='';delete small.tasks[0].workspaceChoice;delete small.tasks[0].workspaceProposal;
full.revision='test:1';full.runRevisions={[runId]:'test:1'};
let summary=small,detail=full,socket,hold=false,held=[],commands=[],errors=[];
browser=await chromium.launch({...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{channel:'chrome'}),headless:true});for(const width of [1280,390]){
summary=structuredClone(small);detail=structuredClone(full);hold=false;held=[];commands=[];errors=[];
const context=await browser.newContext({viewport:{width,height:840}});await context.route('**/token',r=>r.fulfill({body:'fixture-token'}));
await context.routeWebSocket(/\/ws\?/,ws=>{socket=ws;ws.onMessage(raw=>{const c=JSON.parse(String(raw));commands.push(c);if(c.cmd==='orchestration_run_detail'&&hold){held.push(c);return;}let result=[];if(c.cmd==='orchestration_summary')result=summary;else if(c.cmd==='orchestration_run_detail')result=detail;else if(c.cmd==='orchestration_auto_plan_get')result={chatKey:full.runs[0].coordinatorChatKey,enabled:false,includeFull:false};ws.send(JSON.stringify({t:'reply',id:c.id,ok:true,result}));});});
const page=await context.newPage();page.on('pageerror',e=>{errors.push(String(e));console.log('error',String(e));});await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/.test-plan-detail.local/index.html?token=fixture-token`,{waitUntil:'domcontentloaded'});
await page.locator('.plan-review').waitFor();
assert.ok((await page.locator('.plan-review').innerText()).includes('OLD_SAFE_SPEC'));
// Revise only the brief of the same held task. Hold the detail request; the summary finishes first.
hold=true;summary=structuredClone(small);summary.revision='test:2';summary.runRevisions={[runId]:'test:2'};summary.runs[0].planApproval.revision=2;summary.tasks[0].updatedAt++;detail=structuredClone(full);detail.revision='test:2';detail.runRevisions={[runId]:'test:2'};detail.runs[0].planApproval.revision=2;detail.tasks[0].spec='NEW_SCOPE_NOT_SHOWN';
socket.send(JSON.stringify({t:'event',event:'orchestration-changed',payload:{runId,revision:'test:2'}}));
await page.waitForFunction(()=>window.feed.getState().snapshot.runs[0].planApproval.revision===2);await page.waitForTimeout(1800);
assert.ok((await page.locator('body').innerText()).includes('Reading plan…'));
assert.equal(await page.getByRole('button',{name:/^Approve plan/}).count(),0);
assert.equal((await page.locator('body').innerText()).includes('OLD_SAFE_SPEC'),false);
assert.equal(commands.filter(c=>/approve/.test(c.cmd)).length,0);
assert.ok(held.length>0,'probe must hold the new detail');
hold=false;for(const c of held)socket.send(JSON.stringify({t:'reply',id:c.id,ok:true,result:detail}));
await page.locator('.plan-review').waitFor();
const show=page.getByRole('button',{name:'Show the tasks',exact:true});if(await show.count())await show.click();
await page.locator('.plan-task-spec').waitFor();
assert.ok((await page.locator('.plan-review').innerText()).includes('NEW_SCOPE_NOT_SHOWN'));
assert.equal((await page.locator('.plan-review').innerText()).includes('OLD_SAFE_SPEC'),false);
await page.waitForTimeout(1800);
await page.getByRole('button',{name:/^Approve plan/}).click();
await page.waitForTimeout(150);
const approvals=commands.filter(c=>c.cmd==='orchestration_plan_approve');
assert.equal(approvals.length,1);assert.equal(approvals[0].args.revision,2);
console.log(JSON.stringify({case:'summary-new-detail-old',width,heldDetailReads:held.length,readingUntilMatchingDetail:true,approvedRevision:approvals[0].args.revision,errors}));
// Directly exercise optional-field removal in the real merge function as well.
const mergeResult=await page.evaluate(({small,full,id})=>{const s=structuredClone(small),d=structuredClone(full);s.tasks[0].status='ready';delete s.tasks[0].failure;delete s.tasks[0].heldByReopen;d.tasks[0].failure={awaits:'person',because:'retries_used'};d.tasks[0].heldByReopen=true;return window.detailMerge(s,d,id).tasks[0];},{small,full,id:runId});assert.equal(mergeResult.failure,undefined);assert.equal(mergeResult.heldByReopen,undefined);assert.equal(mergeResult.status,'ready');assert.deepEqual(errors,[]);
await context.close();}
} finally {await browser?.close();await server?.close();await rm(scratch,{recursive:true,force:true});}
