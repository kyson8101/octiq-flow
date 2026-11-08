// Visible-panel historical membership, release, held-card candidates and races.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const web=resolve(dirname(fileURLToPath(import.meta.url)),'..'),require=createRequire(join(web,'package.json'));
const {createServer}=await import(pathToFileURL(require.resolve('vite')).href);
const {chromium}=await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href);
const scratch=join(web,'.test-run-history.local');let server,browser;
try{
 await mkdir(scratch,{recursive:true});
 await writeFile(join(scratch,'index.html'),'<html><body><div id="root"></div><script type="module" src="/.test-run-history.local/entry.tsx"></script></body></html>');
 await writeFile(join(scratch,'entry.tsx'),`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{OrchestrationPanel}from'/src/components/OrchestrationPanel.tsx';import{RunDetailOnScreen,useOrchestrationFeed}from'/src/lib/useOrchestrationSnapshot.ts';import{orchestrationFeed}from'/src/lib/orchestrationFeed.ts';window.feed=orchestrationFeed;function Scene(){useOrchestrationFeed();const[shown,setShown]=useState(true);window.show=setShown;return <RunDetailOnScreen.Provider value={shown}><OrchestrationPanel project={null} coordinatorKey="chat:main" embedded allowManualRun={location.search.includes("manual=1")} onOpenChat={()=>{}} onClose={()=>{}}/></RunDetailOnScreen.Provider>}createRoot(document.getElementById('root')).render(<Scene/>);`);
 server=await createServer({root:web,configFile:join(web,'vite.config.ts'),cacheDir:join(scratch,'node_modules/.vite'),server:{host:'127.0.0.1',port:0,strictPort:false}});await server.listen();
 const base={summary:true,runs:[],tasks:[],attempts:[],gates:[],nativeDecisions:[],messages:[],notifications:[],reports:{},revision:'fixture:1',runRevisions:{active:'fixture:1',old:'fixture:1'},workerParents:{'orch-old':'main'},runCoordinators:['chat:main']};
 const active={id:'active',objective:'Current work',coordinatorChatKey:'chat:main',workspaceId:'p',rootPath:'/fixture',status:'running',maxConcurrent:2,createdAt:2,updatedAt:2};
 const old={...active,id:'old',objective:'Historical work',status:'closed',archivedAt:1,createdAt:1,updatedAt:1};
 const task={id:'t-old',runId:'old',title:'Old task',spec:'',dependsOn:[],status:'completed',activeAttemptId:'a-old',createdAt:1,updatedAt:1};
 const attempt={id:'a-old',taskId:'t-old',runId:'old',number:1,workerChatKey:'chat:orch-old',agent:'codex',access:'auto',status:'completed',cwd:'/fixture',branch:'fixture',isWorktree:true,filesModified:[],createdAt:1,updatedAt:1};
 const global={...base,runs:[]},history={...base,runs:[old],tasks:[task],attempts:[attempt]};
 browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH,headless:true});
 for(const [width,manual] of [[1280,false],[390,false],[1280,true],[390,true]]){
  const context=await browser.newContext({viewport:{width,height:844}});let socket,historyReads=0,held=[],hold=false,candidates=false,failHistory=false;const errors=[];
  await context.route('**/token',r=>r.fulfill({body:'fixture-token'}));
  await context.routeWebSocket(/\/ws\?/,ws=>{socket=ws;ws.onMessage(raw=>{
   const c=JSON.parse(String(raw));if(c.t!=='invoke')return;
   let result=[];
   if(c.cmd==='orchestration_summary'){
    if(c.args?.includeEnded){historyReads++;if(hold){held.push(c);return;}if(failHistory){ws.send(JSON.stringify({t:'reply',id:c.id,ok:false,error:'history offline'}));return;}result=history;}
    else {candidates=!!c.args?.heldChatKeys?.includes('chat:orch-old');result=candidates?history:global;}
   }else if(c.cmd==='orchestration_run_detail')result={...base,summary:false,runs:[c.args.runId==='old'?old:active],tasks:c.args.runId==='old'?[{...task,spec:'Historical detail retained only on screen.'}]:[],attempts:c.args.runId==='old'?[attempt]:[]};
   ws.send(JSON.stringify({t:'reply',id:c.id,ok:true,result}));
  });});
  const page=await context.newPage();page.setDefaultTimeout(90000);page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/.test-run-history.local/index.html?token=fixture-token&manual=${manual?1:0}`);
  await page.getByRole('button',{name:/Archived/}).first().waitFor();
  assert.equal(await page.evaluate(()=>window.feed.getState().snapshot.runs.length),0);
  await page.getByRole('button',{name:/Archived/}).first().click();
  await page.getByText('Historical work',{exact:true}).first().waitFor();
  const historicalHeading=page.locator('.orch-run-accordion-toggle').filter({hasText:'Historical work'});if(await historicalHeading.count()&&await historicalHeading.first().getAttribute('aria-expanded')!=='true')await historicalHeading.first().click();
  await page.waitForFunction(()=>window.feed.getState().details.has('old'));
  await page.evaluate(()=>window.show(false));
  await page.waitForFunction(()=>window.feed.getState().details.size===0);
  await page.getByText('Historical work',{exact:true}).waitFor({state:'hidden'});
  const before=historyReads;socket.send(JSON.stringify({t:'event',event:'orchestration-changed',payload:{runId:'old'}}));await page.waitForTimeout(1400);assert.equal(historyReads,before);
  hold=true;await page.evaluate(()=>window.show(true));await page.waitForFunction(()=>window.feed.getState().snapshot!==null);await page.waitForTimeout(300);assert.ok(held.length);
  await page.evaluate(()=>window.show(false));for(const c of held)socket.send(JSON.stringify({t:'reply',id:c.id,ok:true,result:history}));await page.waitForTimeout(100);
  assert.equal(await page.getByText('Historical work',{exact:true}).count(),0);
  await page.evaluate(()=>window.feed.holdChats(['chat:orch-old']));await page.waitForFunction(()=>window.feed.getState().snapshot.runs.length===1);assert.equal(candidates,true);
  await page.evaluate(()=>window.feed.holdChats([]));await page.waitForFunction(()=>window.feed.getState().snapshot.runs.length===0);
  held=[];hold=true;await page.evaluate(()=>window.show(true));await page.waitForTimeout(500);assert.ok(held.length);
  socket.send(JSON.stringify({t:'event',event:'orchestration-changed',payload:{runId:'old'}}));
  hold=false;const invalidatedRead=historyReads;for(const c of held)socket.send(JSON.stringify({t:'reply',id:c.id,ok:true,result:history}));
  await page.waitForFunction(()=>document.querySelector('.orch-tool[title*="archived"]'));
  await page.waitForTimeout(1300);assert.ok(historyReads>invalidatedRead);
  const refreshed=historyReads;socket.send(JSON.stringify({t:'event',event:'orchestration-changed',payload:{runId:'old'}}));
  await page.waitForTimeout(1500);assert.ok(historyReads>refreshed,'a dirty-read retry must not leave its timer permanently set');
  await page.evaluate(()=>window.show(false));await page.waitForTimeout(50);failHistory=true;await page.evaluate(()=>window.show(true));
  await page.getByText('Error: history offline',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);console.log(JSON.stringify({width,manual,historyReads,released:true,lateReplyIgnored:true,heldCandidate:true,inFlightRefresh:true,readFailureShown:true,errors}));await context.close();
 }
}finally{await browser?.close();await server?.close();await rm(scratch,{recursive:true,force:true});}
