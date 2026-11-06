// Real App, synthetic durable records, no live server or agent calls.
// Optional OCTIQ_TEST_DIST=/absolute/path/to/isolated/dist uses a production build.
// PLAYWRIGHT_EXECUTABLE_PATH can select a disposable Brave process.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node web/scripts/test-chat-retention.mjs
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
const rows=Array.from({length:30},(_,i)=>({id:`memory-${i}`,projectId:project.id,title:`Memory ${i}`,createdAt:i+1,updatedAt:i+1,modelId:'claude:sonnet-4-6',access:'read',sessionId:`session-${i}`}));
const frames=id=>[
 {seq:1,event:{type:'system',subtype:'init',session_id:`session-${id}`,cwd:'/fixture'}},
 {seq:2,event:{type:'user',uuid:`user-${id}`,message:{content:[{type:'text',text:`Question ${id}.`}]}}},
 {seq:3,event:{type:'assistant',message:{id:`reply-${id}`,content:[{type:'text',text:`Answer ${id}.`},{type:'tool_use',id:`tool-${id}`,name:'Read',input:{path:'/fixture/file.txt'}}]}}},
 {seq:4,event:{type:'user',message:{content:[{type:'tool_result',tool_use_id:`tool-${id}`,content:'x'.repeat(256*1024)}]}}},
];
function inspect(){
 const root=document.getElementById('root');const holder=root[Object.keys(root).find(key=>key.startsWith('__reactContainer$'))];
 const todo=[holder.stateNode?.current??holder];let app;
 while(todo.length){const fiber=todo.pop();if(typeof fiber.type==='function'){let count=0;for(let hook=fiber.memoizedState;hook?.next;hook=hook.next)count++;if(count>200){app=fiber;break;}}if(fiber.child)todo.push(fiber.child);if(fiber.sibling)todo.push(fiber.sibling);}
 if(!app)throw new Error('App fiber missing');const values=[];for(let hook=app.memoizedState;hook;hook=hook.next)values.push(hook.memoizedState);
 const chats=values.find(value=>value&&!Array.isArray(value)&&typeof value==='object'&&Object.values(value).some(state=>state&&typeof state.busy==='boolean'&&Array.isArray(state.messages)))??{};
 const conversations=values.find(value=>Array.isArray(value)&&value.length&&value.every(row=>row&&typeof row.projectId==='string'&&Array.isArray(row.messages)))??[];
 const history=values.find(value=>value?.current?.windows instanceof Map && typeof value.current.hasEarlier==='function')?.current;
 const tools=state=>state.messages.reduce((n,message)=>n+message.blocks.filter(block=>block.kind==='tool').length,0);
 return {full:Object.entries(chats).filter(([,state])=>tools(state)>0).map(([id])=>id),rowCopies:conversations.filter(row=>row.messages.some(message=>message.blocks.some(block=>block.kind==='tool'))).map(row=>row.id),backgroundChars:Object.entries(chats).filter(([id])=>id!==(location.hash.match(/\/c\/([^/]+)/)?.[1]??'')).map(([id,state])=>[id,JSON.stringify(state.messages).length]),windows:history?[...history.windows.values()]:[],weakSaveMarker:values.some(value=>value?.current instanceof WeakMap)};
}
let server,browser,cacheDir;
try{
 cacheDir=await mkdtemp(join(tmpdir(),'octiq-chat-memory-vite-'));
 server=process.env.OCTIQ_TEST_DIST?await preview({root:web,build:{outDir:process.env.OCTIQ_TEST_DIST},preview:{host:'127.0.0.1',port:0,strictPort:false}}):await createServer({cacheDir:join(cacheDir,'node_modules','.vite'),root:web,configFile:join(web,'vite.config.ts'),server:{host:'127.0.0.1',port:0,strictPort:false}});if(!process.env.OCTIQ_TEST_DIST)await server.listen();
 browser=await chromium.launch({...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{channel:process.env.PLAYWRIGHT_CHANNEL||'chrome'}),headless:true});
 const results=[];
 for(const width of [1280,390]){
  const context=await browser.newContext({viewport:{width,height:840}});let socket;const reads=new Map();
  await context.route('**/token',route=>route.fulfill({body:'fixture-token'}));
  await context.routeWebSocket(/\/ws\?/,ws=>{socket=ws;ws.onMessage(raw=>{const call=JSON.parse(String(raw));if(call.t!=='invoke')return;const a=call.args??{},id=String(a.key??'').replace(/^chat:/,'');let result=[];
   switch(call.cmd){
    case 'list_workspaces':result=[project];break;
    case 'chat_index_list':result=rows;break;
    case 'orchestration_snapshot':result={runs:[{id:'fixture-run',workspaceId:'memory',rootPath:'/fixture',maxConcurrent:2,title:'Archived fixture',objective:'Fixture',status:'completed',coordinatorChatKey:'chat:memory-1',createdAt:1,updatedAt:1,archivedAt:1}],tasks:[{id:'fixture-task',runId:'fixture-run',title:'Fixture task',spec:'',status:'completed',kind:'work',dependsOn:[],createdAt:1,updatedAt:1}],attempts:[{id:'fixture-attempt',runId:'fixture-run',taskId:'fixture-task',workerChatKey:'chat:memory-2',number:1,agent:'claude',access:'read',cwd:'/fixture',branch:'fixture',isWorktree:false,filesModified:[],status:'completed',createdAt:1,updatedAt:1,finishedAt:1}],gates:[],messages:[],notifications:[],reports:{},briefRuns:[]};break;
    case 'chat_page':reads.set(id,(reads.get(id)??0)+1);result=a.before===null?(/5$/.test(id)?{events:frames(id),context:[],before:null}:{events:frames(id).slice(2),context:frames(id).slice(0,1),before:3}):{events:frames(id).slice(0,2),context:[],before:null};break;
    case 'chat_since':result=frames(id).filter(frame=>frame.seq>a.after);break;
    case 'resolve_paths':result=a.paths.map(()=>null);break;
    case 'chat_task':result=null;break;
    case 'usage_summary':result={sessions:[],totals:{}};break;
   }
   ws.send(JSON.stringify({t:'reply',id:call.id,ok:true,result}));
  });});
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>{errors.push(String(error));console.error('pageerror',String(error));});
  page.setDefaultTimeout(30000);page.setDefaultNavigationTimeout(120000);
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?token=fixture-token#/c/memory-0`,{waitUntil:'domcontentloaded'});
  const count=Number(process.env.MEMORY_CHAT_COUNT||(width===1280?30:8));console.log('loaded',width);
  for(let i=0;i<count;i++){
   if(i%10===0)console.log('opening',width,i);await page.evaluate(id=>{location.hash='#/c/'+id;},`memory-${i}`);
   await page.locator('.msgs').getByText(`Answer memory-${i}.`,{exact:true}).waitFor();
   await page.waitForTimeout(i%10===5?900:50);
   const state=await page.evaluate(inspect);assert.deepEqual(state.full,[`memory-${i}`]);assert.ok(state.rowCopies.length<=1);if(i%10===5)assert.deepEqual(state.rowCopies,[`memory-${i}`],'full checkpoints must exercise sidebar transcript copies');assert.ok(state.windows.every(window=>Object.keys(window).join() ==='before'));assert.ok(state.weakSaveMarker);assert.ok(state.backgroundChars.every(([,bytes])=>bytes<2000),JSON.stringify(state));
  }
  console.log('opened all',width);
  // All incoming background transcripts are previews, including their tools.
  for(let i=0;i<20;i++)for(const frame of frames('background-'+i).slice(2))socket.send(JSON.stringify({t:'event',event:'chat-event',payload:{key:'chat:background-'+i,seq:frame.seq,event:frame.event}}));
  await page.waitForTimeout(500);
  const state=await page.evaluate(inspect);assert.equal(state.full.length,1);assert.ok(state.backgroundChars.every(([,bytes])=>bytes<2000),JSON.stringify(state));
  if(count>5){
   await page.evaluate(()=>{location.hash='#/c/memory-5';});await page.locator('.msgs').getByText('Answer memory-5.',{exact:true}).waitFor();
   assert.equal(reads.get('memory-5'),1,'complete released chat should restore its disk checkpoint');
  }
  await page.evaluate(()=>{location.hash='#/c/memory-0';});await page.locator('.msgs').getByText('Answer memory-0.',{exact:true}).waitFor();assert.equal(reads.get('memory-0'),2,'released chat must replay on return');
  console.log('reopened',width);await page.getByRole('button',{name:/Load earlier messages/}).click();await page.locator('.msgs').getByText('Question memory-0.',{exact:true}).waitFor();
  // The split keeps exactly two full transcripts; all previous chats go.
  await page.evaluate(()=>{location.hash='#/c/memory-1/beside/memory-2';});
  let split;
  for(let attempt=0;attempt<50;attempt++){split=await page.evaluate(inspect);if(split.full.length===2)break;await page.waitForTimeout(100);}
  assert.deepEqual(split.full.sort(),['memory-1','memory-2']);
  assert.ok(split.rowCopies.length<=2);
  assert.deepEqual(errors,[]);results.push({width,opened:count,background:20,fullTranscripts:state.full.length,splitTranscripts:split.full.length,reopenAndEarlier:'pass'});await context.close();
 }
 console.log(JSON.stringify(results));
}finally{try{await browser?.close();}finally{try{if(server?.close)await server.close();else if(server)await new Promise(resolve=>server.httpServer.close(resolve));}finally{if(cacheDir)await rm(cacheDir,{recursive:true,force:true});}}}
