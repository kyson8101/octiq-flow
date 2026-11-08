// Real App, synthetic durable records, no live server or agent calls.
// Optional OCTIQ_TEST_DIST=/absolute/path/to/isolated/dist uses a production build.
// PLAYWRIGHT_EXECUTABLE_PATH can select a disposable Brave process.
// Derived from the independent H1-d review; legacy queue state with unstamped live echoes.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node web/scripts/test-confirmed-echo-retention.mjs
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const web=resolve(process.env.OCTIQ_WEB_ROOT||fileURLToPath(new URL('..',import.meta.url)));
const require=createRequire(join(web,'package.json'));
const {createServer,preview}=await import(pathToFileURL(require.resolve('vite')).href);
const moduleUrl=spec=>isAbsolute(spec)||spec.startsWith('.')?pathToFileURL(resolve(spec)).href:spec;
const {chromium}=await import(moduleUrl(process.env.PLAYWRIGHT_MODULE||'playwright'));
const project={id:'memory',name:'Memory fixture',primary_path:'/fixture',paths:['/fixture'],env:{}};
const modern=false;
const rows=Array.from({length:30},(_,i)=>({id:`memory-${i}`,projectId:project.id,title:`Memory ${i}`,createdAt:i+1,updatedAt:i+1,modelId:'claude:sonnet-4-6',access:'read',sessionId:`session-${i}`}));
const fixtureLedger=()=>({runs:[{id:'fixture-run',workspaceId:'memory',rootPath:'/fixture',maxConcurrent:2,title:'Archived fixture',objective:'Fixture',status:'completed',coordinatorChatKey:'chat:memory-1',createdAt:1,updatedAt:1}],tasks:[{id:'fixture-task',runId:'fixture-run',title:'Fixture task',spec:'Full task detail',status:'completed',kind:'work',dependsOn:[],createdAt:1,updatedAt:1}],attempts:[{id:'fixture-attempt',runId:'fixture-run',taskId:'fixture-task',workerChatKey:'chat:memory-2',number:1,agent:'claude',access:'read',cwd:'/fixture',branch:'fixture',isWorktree:false,filesModified:[],status:'completed',createdAt:1,updatedAt:1,finishedAt:1}],gates:[],messages:[],notifications:[],reports:{},briefRuns:[]});
let hostEcho;
const frames=id=>[
 {seq:1,event:{type:'system',subtype:'init',session_id:`session-${id}`,cwd:'/fixture'}},
 {seq:2,event:{type:'user',uuid:`user-${id}`,message:{content:[{type:'text',text:`Question ${id}.`}]}}},
 {seq:3,event:{type:'assistant',message:{id:`reply-${id}`,content:[{type:'text',text:`Answer ${id}.`},{type:'tool_use',id:`tool-${id}`,name:'Read',input:{path:'/fixture/file.txt'}}]}}},
 {seq:4,event:{type:'user',message:{content:[{type:'tool_result',tool_use_id:`tool-${id}`,content:'x'.repeat(256*1024)}]}}},
 {seq:5,event:{type:'result',subtype:'success',is_error:false}},
 ...(id==='memory-0' && hostEcho ? [{seq:5,event:hostEcho}] : []),
];
function inspect(){
 const root=document.getElementById('root');const holder=root[Object.keys(root).find(key=>key.startsWith('__reactContainer$'))];
 const todo=[holder.stateNode?.current??holder];let app;
 while(todo.length){const fiber=todo.pop();if(typeof fiber.type==='function'){let count=0;for(let hook=fiber.memoizedState;hook?.next;hook=hook.next)count++;if(count>200){app=fiber;break;}}if(fiber.child)todo.push(fiber.child);if(fiber.sibling)todo.push(fiber.sibling);}
 if(!app)throw new Error('App fiber missing');const values=[];for(let hook=app.memoizedState;hook;hook=hook.next)values.push(hook.memoizedState);
 const chats=values.find(value=>value&&!Array.isArray(value)&&typeof value==='object'&&Object.values(value).some(state=>state&&typeof state.busy==='boolean'&&Array.isArray(state.messages)))??{};
 const conversations=values.find(value=>Array.isArray(value)&&value.length&&value.every(row=>row&&typeof row.projectId==='string'&&Array.isArray(row.messages)))??[];
 const feed=values.find(value=>value?.snapshot?.runs&&value?.details instanceof Map);
 const history=values.find(value=>value?.current?.windows instanceof Map && typeof value.current.hasEarlier==='function')?.current;
 const tools=state=>state.messages.reduce((n,message)=>n+message.blocks.filter(block=>block.kind==='tool').length,0);
 return {stateMessages:Object.entries(chats).map(([id,s])=>({id,messages:s.messages.map(m=>({id:m.id,role:m.role,turnId:m.turnId,echo:m.echo,takenUp:m.takenUp,delivery:m.delivery,text:m.blocks.filter(b=>b.kind==='text').map(b=>b.text)}))})),detailIds:feed?[...feed.details.keys()]:[],full:Object.entries(chats).filter(([,state])=>tools(state)>0).map(([id])=>id),rowCopies:conversations.filter(row=>row.messages.some(message=>message.blocks.some(block=>block.kind==='tool'))).map(row=>row.id),backgroundChars:Object.entries(chats).filter(([id])=>id!==(location.hash.match(/\/c\/([^/]+)/)?.[1]??'')).map(([id,state])=>[id,JSON.stringify(state.messages).length]),windows:history?[...history.windows.values()]:[],weakSaveMarker:values.some(value=>value?.current instanceof WeakMap)};
}
let server,browser,cacheDir;
try{
 cacheDir=await mkdtemp(join(tmpdir(),'octiq-chat-memory-vite-'));
 server=process.env.OCTIQ_TEST_DIST?await preview({root:web,build:{outDir:process.env.OCTIQ_TEST_DIST},preview:{host:'127.0.0.1',port:0,strictPort:false}}):await createServer({cacheDir:join(cacheDir,'node_modules','.vite'),root:web,configFile:join(web,'vite.config.ts'),server:{host:'127.0.0.1',port:0,strictPort:false}});if(!process.env.OCTIQ_TEST_DIST)await server.listen();
 browser=await chromium.launch({...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{channel:process.env.PLAYWRIGHT_CHANNEL||'chrome'}),headless:true});
 const results=[];
 for(const replay of [false,true]) for(const width of [1280,390]) for(const scenario of ['normal-before-rpc','normal-after-rpc']){
 hostEcho=undefined;
  const context=await browser.newContext({viewport:{width,height:840}});let socket;const reads=new Map();let pendingSends=[];let selected=new Set(),commands=[],subscriptions=[],detailReads=0,connections=[];
  await context.route('**/token',route=>route.fulfill({body:'fixture-token'}));
  await context.routeWebSocket(/\/ws\?/,ws=>{socket=ws;const connection=[];connections.push(connection);ws.onMessage(raw=>{const call=JSON.parse(String(raw));if(call.t!=='invoke')return;commands.push(call.cmd);connection.push(call.cmd);const a=call.args??{},id=String(a.key??'').replace(/^chat:/,'');let result=[]; if(call.cmd==='chat_send'){pendingSends.push({ws,call});return;}
   if(!modern&&['chat_subscribe','orchestration_summary','orchestration_run_detail','chat_page'].includes(call.cmd)){ws.send(JSON.stringify({t:'reply',id:call.id,ok:false,error:`'${call.cmd}' is not available on this backend`}));return;}
   switch(call.cmd){
    case 'list_workspaces':result=[project];break;
    case 'chat_index_list':result=rows;break;
    case 'chat_list':result=['chat:memory-0'];break;
    case 'chat_subscribe':selected=new Set(a.chatKeys);subscriptions.push([...selected]);result={chatKeys:[...selected]};break;
    case 'orchestration_summary':result={...fixtureLedger(),tasks:fixtureLedger().tasks.map(t=>({...t,spec:''})),summary:true,revision:'fixture:1',runRevisions:{'fixture-run':'fixture:1'}};break;
    case 'orchestration_run_detail':detailReads++;result=fixtureLedger();break;
    case 'orchestration_snapshot':result=fixtureLedger();break;
    case 'chat_page':if(modern)assert.ok(selected.has(a.key),'only subscribed panes may replay');reads.set(id,(reads.get(id)??0)+1);result={events:frames(id),context:[],before:null};break;
    case 'chat_since':result=frames(id).filter(frame=>frame.seq>a.after);break;
    case 'resolve_paths':result=a.paths.map(()=>null);break;
    case 'chat_task':result=null;break;case 'chat_queue_state':result={live:true,queuedTurnIds:[]};break;
    case 'usage_summary':result={sessions:[],totals:{}};break;
   }
   ws.send(JSON.stringify({t:'reply',id:call.id,ok:true,result}));
  });});
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>{errors.push(String(error));console.error('pageerror',String(error));});
  page.setDefaultTimeout(30000);page.setDefaultNavigationTimeout(120000);
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?token=fixture-token#/c/memory-0`,{waitUntil:'domcontentloaded'});
  await page.locator('.msgs').getByText('Answer memory-0.',{exact:true}).waitFor();
  const prompt='continue';const box=page.locator('textarea').first();
  await box.fill(prompt);await box.press('Enter');
  while(!pendingSends.length)await page.waitForTimeout(5);
  const reply=send=>send.ws.send(JSON.stringify({t:'reply',id:send.call.id,ok:true,result:null}));
  if(scenario!=='normal-before-rpc'){for(const send of pendingSends)reply(send);await page.waitForTimeout(100);}
  const host=(uuid,seq)=>socket.send(JSON.stringify({t:'event',event:'chat-event',payload:{key:'chat:memory-0',seq,event:{type:'user',uuid,...(replay?{isReplay:true,parent_tool_use_id:null}:{}),message:{content:[{type:'text',text:prompt}]}}}}));
  const preEcho=await page.evaluate(inspect);
  host('legacy-native-1',6);
  if(scenario==='normal-before-rpc'){await page.waitForTimeout(60);reply(pendingSends[0]);}
  await page.waitForTimeout(1000);
  const active=await page.evaluate(inspect);const users=active.stateMessages.find(s=>s.id==='memory-0').messages.filter(m=>m.role==='user'&&m.text.includes(prompt));
  const locals=users.filter(m=>!m.echo&&!m.takenUp);
  const legacyNormalPass=users.length===1&&users[0].echo==='legacy-native-1'&&users[0].delivery==='dispatched';
  const restore=await page.getByRole('button',{name:'Restore to composer',exact:true}).count();
  await page.evaluate(()=>{location.hash='#/c/memory-1';});await page.locator('.msgs').getByText('Answer memory-1.',{exact:true}).waitFor();await page.waitForTimeout(150);
  const released=await page.evaluate(inspect);const kept=released.stateMessages.find(s=>s.id==='memory-0')?.messages.filter(m=>m.role==='user'&&!m.echo&&!m.takenUp)??[];
  assert.deepEqual(errors,[]);
  assert.equal(legacyNormalPass,true,'one confirmed copy in either RPC/echo order');
  assert.equal(locals.length,0,'live echo acknowledges the current local send');
  assert.equal(restore,0,'confirmed prompt has no Restore action');
  assert.equal(kept.length,0,'release retains no acknowledged local prompt');
  assert.equal(pendingSends.length,1,'never resend to reconcile');
  if(scenario==='normal-after-rpc') assert.equal(preEcho.stateMessages.find(s=>s.id==='memory-0').messages.find(m=>m.turnId===pendingSends[0].call.args.turnId).delivery,'unknown','real post-RPC syncQueue ran before echo');
  results.push({case:scenario,width,replay,sends:pendingSends.length,local:locals.length,retainedAfterRelease:kept.length,legacyNormalPass,restore,preEcho:preEcho.stateMessages.find(s=>s.id==='memory-0')?.messages.filter(m=>m.turnId===pendingSends[0].call.args.turnId),users,errors});
  await context.close();

 }
 console.log(JSON.stringify(results));
}finally{try{await browser?.close();}finally{try{if(server?.close)await server.close();else if(server)await new Promise(resolve=>server.httpServer.close(resolve));}finally{if(cacheDir)await rm(cacheDir,{recursive:true,force:true});}}}
