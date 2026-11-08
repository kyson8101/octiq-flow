// Real App, synthetic durable records, no live server or agent calls.
// Optional OCTIQ_TEST_DIST=/absolute/path/to/isolated/dist uses a production build.
// PLAYWRIGHT_EXECUTABLE_PATH can select a disposable Brave process.
// Derived from the independent H1-b reviewer probe; native and isReplay envelopes.
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
const modern=process.env.LEGACY_BACKEND!=='1';
const rows=Array.from({length:30},(_,i)=>({id:`memory-${i}`,projectId:project.id,title:`Memory ${i}`,createdAt:i+1,updatedAt:i+1,modelId:'claude:sonnet-4-6',access:'read',sessionId:`session-${i}`}));
const fixtureLedger=()=>({runs:[{id:'fixture-run',workspaceId:'memory',rootPath:'/fixture',maxConcurrent:2,title:'Archived fixture',objective:'Fixture',status:'completed',coordinatorChatKey:'chat:memory-1',createdAt:1,updatedAt:1}],tasks:[{id:'fixture-task',runId:'fixture-run',title:'Fixture task',spec:'Full task detail',status:'completed',kind:'work',dependsOn:[],createdAt:1,updatedAt:1}],attempts:[{id:'fixture-attempt',runId:'fixture-run',taskId:'fixture-task',workerChatKey:'chat:memory-2',number:1,agent:'claude',access:'read',cwd:'/fixture',branch:'fixture',isWorktree:false,filesModified:[],status:'completed',createdAt:1,updatedAt:1,finishedAt:1}],gates:[],messages:[],notifications:[],reports:{},briefRuns:[]});
let hostEcho;
const frames=id=>[
 {seq:1,event:{type:'system',subtype:'init',session_id:`session-${id}`,cwd:'/fixture'}},
 {seq:2,event:{type:'user',uuid:`user-${id}`,message:{content:[{type:'text',text:`Question ${id}.`}]}}},
 {seq:3,event:{type:'assistant',message:{id:`reply-${id}`,content:[{type:'text',text:`Answer ${id}.`},{type:'tool_use',id:`tool-${id}`,name:'Read',input:{path:'/fixture/file.txt'}}]}}},
 {seq:4,event:{type:'user',message:{content:[{type:'tool_result',tool_use_id:`tool-${id}`,content:'x'.repeat(256*1024)}]}}},
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
 for(const replay of [false,true]) for(const width of [1280,390]){
 hostEcho=undefined;
  const context=await browser.newContext({viewport:{width,height:840}});let socket;const reads=new Map();let pendingSends=[];let selected=new Set(),commands=[],subscriptions=[],detailReads=0,connections=[];
  await context.route('**/token',route=>route.fulfill({body:'fixture-token'}));
  await context.routeWebSocket(/\/ws\?/,ws=>{socket=ws;const connection=[];connections.push(connection);ws.onMessage(raw=>{const call=JSON.parse(String(raw));if(call.t!=='invoke')return;commands.push(call.cmd);connection.push(call.cmd);const a=call.args??{},id=String(a.key??'').replace(/^chat:/,'');let result=[]; if(call.cmd==='chat_send'){pendingSends.push({ws,call});return;}
   if(!modern&&['chat_subscribe','orchestration_summary','orchestration_run_detail'].includes(call.cmd)){ws.send(JSON.stringify({t:'reply',id:call.id,ok:false,error:`'${call.cmd}' is not available on this backend`}));return;}
   switch(call.cmd){
    case 'list_workspaces':result=[project];break;
    case 'chat_index_list':result=rows;break;
    case 'chat_list':result=['chat:memory-0'];break;
    case 'chat_subscribe':selected=new Set(a.chatKeys);subscriptions.push([...selected]);result={chatKeys:[...selected]};break;
    case 'orchestration_summary':result={...fixtureLedger(),tasks:fixtureLedger().tasks.map(t=>({...t,spec:''})),summary:true,revision:'fixture:1',runRevisions:{'fixture-run':'fixture:1'}};break;
    case 'orchestration_run_detail':detailReads++;result=fixtureLedger();break;
    case 'orchestration_snapshot':result=fixtureLedger();break;
    case 'chat_page':if(modern)assert.ok(selected.has(a.key),'only subscribed panes may replay');reads.set(id,(reads.get(id)??0)+1);result=a.before===null?(/5$/.test(id)?{events:frames(id),context:[],before:null}:{events:frames(id).slice(2),context:frames(id).slice(0,1),before:3}):{events:frames(id).slice(0,2),context:[],before:null};break;
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
  const prompt='LOCAL_PENDING_WORDS_MUST_SURVIVE';
  const box=page.locator('textarea').first();
  await box.fill(prompt); await box.press('Enter');
  await page.waitForTimeout(400);
  pendingSends[0].ws.send(JSON.stringify({t:'reply',id:pendingSends[0].call.id,ok:true,result:null}));await page.waitForTimeout(150);
  await page.evaluate(()=>{location.hash='#/c/memory-1';});
  await page.locator('.msgs').getByText('Answer memory-1.',{exact:true}).waitFor();await page.waitForTimeout(300);
  const before=await page.evaluate(prompt=>{const root=document.getElementById('root'),holder=root[Object.keys(root).find(k=>k.startsWith('__reactContainer$'))],todo=[holder.stateNode?.current??holder];while(todo.length){const f=todo.pop();if(typeof f.type==='function'){let n=0;for(let h=f.memoizedState;h?.next;h=h.next)n++;if(n>200){const vals=[];for(let h=f.memoizedState;h;h=h.next)vals.push(h.memoizedState);return vals.filter(v=>v&&typeof v==='object'&&!Array.isArray(v)&&v['memory-0']?.messages).map(v=>JSON.stringify(v['memory-0'].messages).includes(prompt));}}if(f.child)todo.push(f.child);if(f.sibling)todo.push(f.sibling);}return [];},prompt);
  assert.ok(before.some(Boolean),'released prompt must remain local until its echo');
  hostEcho={type:'user',...(replay?{isReplay:true,parent_tool_use_id:null}:{}),uuid:'claude-native-echo',octiq_user_turn_id:pendingSends[0].call.args.turnId,message:{content:[{type:'text',text:prompt}]}};
  await page.evaluate(()=>{location.hash='#/c/memory-0';}); await page.waitForTimeout(1500);await page.getByRole('button',{name:'Load earlier messages',exact:true}).click();await page.waitForTimeout(300);
  const visibleCopies=await page.locator('.msgs').getByText(prompt,{exact:true}).count();
  const reopened=await page.evaluate(inspect);
  const confirmed=reopened.stateMessages.find(row=>row.id==='memory-0').messages.filter(m=>m.turnId===pendingSends[0].call.args.turnId);
  assert.equal(visibleCopies,1,'one visible confirmed prompt after reopen and Load earlier');
  assert.equal(confirmed.length,1,'one stable send identity');
  assert.equal(confirmed[0].echo,'claude-native-echo');
  assert.equal(confirmed[0].delivery,'dispatched');
  assert.equal((await page.locator('.msgs').innerText()).includes('Delivery unconfirmed'),false);
  assert.equal(await page.getByRole('button',{name:'Restore to composer',exact:true}).count(),0);
  await page.evaluate(()=>{location.hash='#/c/memory-1';});
  await page.locator('.msgs').getByText('Answer memory-1.',{exact:true}).waitFor();
  await page.waitForTimeout(300);
  const released=await page.evaluate(inspect);
  const locals=released.stateMessages.find(row=>row.id==='memory-0')?.messages.filter(m=>m.role==='user'&&!m.echo&&!m.takenUp)??[];
  assert.equal(locals.length,0,'release must not retain a confirmed prompt as local');
  assert.equal(pendingSends.length,1,'no resend');assert.deepEqual(errors,[]);
  results.push({case:'confirmed-echo-release-reopen-history',width,replay,visibleCopies,confirmed:confirmed.length,retainedLocals:locals.length,pendingSends:pendingSends.length,errors});
  await context.close();

 }
 console.log(JSON.stringify(results));
}finally{try{await browser?.close();}finally{try{if(server?.close)await server.close();else if(server)await new Promise(resolve=>server.httpServer.close(resolve));}finally{if(cacheDir)await rm(cacheDir,{recursive:true,force:true});}}}
