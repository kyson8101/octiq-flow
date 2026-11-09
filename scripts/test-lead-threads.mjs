// Real App and isolated inline socket scenes, not host recordings.
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {browserPaths} from './browser-paths.mjs';
const {webRoot, require, moduleUrl} = browserPaths(import.meta.url);
const {createServer} = await import(moduleUrl(require.resolve('vite')));
const {chromium} = await import(moduleUrl(process.env.PLAYWRIGHT_MODULE || 'playwright'));
const artifacts = process.env.OCTIQ_EVIDENCE_DIR || await mkdtemp(join(tmpdir(), 'octiq-lead-threads-'));
await mkdir(artifacts, {recursive: true});
const now = Date.now();
const team = [{id:'head',name:'OCTIQ HEAD',role:'Lead'}, {id:'star',name:'STAR LEAD',role:'Lead'},
  {id:'fe',name:'OCTIQ FE',role:'Frontend',reportsTo:'head'}]
  .map(a=>({agent:'claude',model:'opus',effort:'high',access:'auto',createdAt:now,updatedAt:now,...a}));
const threads = team.slice(0,2).map(a=>({agentId:a.id,name:a.name,chatKey:`chat:lead-${a.id}`,cwd:'/repo',exists:true}));
const base = {projectId:'general',modelId:'claude:opus',access:'auto',sessionId:'session',pinned:false,cwd:'/repo',createdAt:now-100000,updatedAt:now-1000};
const initial = [{...base,id:'lead-head',leadOf:'head',title:'OCTIQ HEAD'}, {...base,id:'lead-star',leadOf:'star',title:'STAR LEAD',updatedAt:now-500},
  {...base,id:'old-request',title:'Earlier request',doneAt:now}, {...base,id:'orch-worker',title:'Worker conversation'}];
const run = {id:'run',coordinatorChatKey:'chat:lead-head',workspaceId:'general',rootPath:'/repo',objective:'Ship lead navigation',status:'running',maxConcurrent:2,createdAt:now,updatedAt:now,planApproval:{status:'approved',requestedAt:now,decidedAt:now}};
const task = {id:'task',runId:'run',title:'Implement sidebar',spec:'UI',dependsOn:[],status:'running',activeAttemptId:'attempt',assignee:{id:'fe',name:'OCTIQ FE'},createdAt:now,updatedAt:now};
const attempt = {id:'attempt',taskId:'task',runId:'run',number:1,workerChatKey:'chat:orch-worker',agent:'claude',access:'auto',status:'running',filesModified:[],cwd:'/repo',branch:'feature/sidebar',createdAt:now,updatedAt:now,execution:{state:'executing',retryCount:0,lastActivityAt:now}};
const snapshot = {runs:[run],tasks:[task],attempts:[attempt],gates:[],messages:[]};
const logs = new Map(initial.map(({id})=>[`chat:${id}`,[
  {seq:1,event:{type:'user',uuid:`u-${id}`,octiq_user_turn:true,message:{content:[{type:'text',text:`Read ${id}`}]}}},
  {seq:2,event:{type:'assistant',message:{id:`m-${id}`,role:'assistant',content:[{type:'text',text:`Conversation content: ${id}`}]}}},
  {seq:3,event:{type:'result',subtype:'success',result:'Done',is_error:false}},
]]));
let scheduling, chats, socket, heldThreads, heldHistory, failOpen, historyRead;
const calls=[], errors=[], results=[];
function answer({cmd,args={}}) {
  switch(cmd) {
    case 'list_workspaces': return [{id:'general',name:'OctiqFlow',primary_path:'/repo'}];
    case 'chat_index_list': return chats;
    case 'chat_index_entry': return chats.find(c=>c.id===args.id)??null;
    case 'chat_index_deleted': case 'permission_pending': case 'access_request_pending': case 'question_pending': case 'safety_block_pending':
    case 'orchestration_workspace_cleanup_request_pending': case 'provider_fallback_choices': case 'agent_team_list': case 'levels_list': case 'agent_levels': case 'codex_skills': return [];
    case 'team_list': return team;
    case 'team_head': return team[0];
    case 'team_home': return 'general';
    case 'team_leads': return [{chatKey:'chat:lead-head',leadId:'head',leadName:'OCTIQ HEAD',projectId:'general',crossProject:true,createdAt:now}];
    case 'lead_threads': return threads;
    case 'lead_thread_open': if(failOpen) throw Error('Lead thread could not be opened.'); return chats.find(c=>c.id===`lead-${args.agentId}`);
    case 'lead_history': return [{chatKey:'chat:old-request',title:'Earlier request',updatedAt:now-20000,done:true}];
    case 'scheduling_get': return scheduling;
    case 'scheduling_set': scheduling={...scheduling,...args.settings}; return scheduling;
    case 'chat_page': return {events:logs.get(args.key)??[],context:[],before:null};
    case 'chat_since': return (logs.get(args.key)??[]).filter(f=>f.seq>(args.after??0));
    case 'chat_list': return ['chat:orch-worker'];
    case 'chat_activity': return [{key:'chat:orch-worker',busy:true}];
    case 'chat_queue_state': return {live:false,queuedTurnIds:[]};
    case 'orchestration_summary': case 'orchestration_snapshot': case 'orchestration_run_detail': return snapshot;
    case 'agent_installs': return [{id:'claude',installed:true,path:'/mock/claude'}];
    case 'chat_task': return {chatId:args.chatId,projectId:'general'};
    case 'agent_policy_get': return {text:''};
    case 'agent_avatar_status': return {available:false,reason:'Inline scene'};
    case 'memory_usage': return {totalMb:0,procs:0,rows:[]};
    case 'usage_summary': return {};
    default: return null;
  }
}
const send=(event,payload)=>socket.send(JSON.stringify({t:'event',event,payload}));
const reply=(request,result)=>socket.send(JSON.stringify({t:'reply',id:request.id,ok:true,result}));
const orient=value=>{scheduling={...scheduling,orientation:value};send('scheduling-changed',scheduling);};
const server=await createServer({root:webRoot,server:{host:'127.0.0.1',port:0,strictPort:false}});
let browser;
try {
  await server.listen();
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  for(const width of [1280,390]) {
    scheduling={orientation:'agents',hostCap:3,live:{total:1},lanes:[]}; chats=structuredClone(initial); heldThreads=[];heldHistory=[];failOpen=false;
    const context=await browser.newContext({viewport:{width,height:960},reducedMotion:'reduce'});
    await context.addInitScript(()=>{localStorage.setItem('octiq.agentsMode','on');localStorage.setItem('octiq.v2.gitColumn','0');localStorage.setItem('octiq.v2.tasksColumn','0');localStorage.setItem('octiq.theme','dark');});
    await context.route('**/token',r=>r.fulfill({body:'mock-token'}));await context.route('**/auth',r=>r.fulfill({body:'ok'}));
    await context.routeWebSocket(/\/ws(?:\?|$)/,ws=>{socket=ws;ws.onMessage(raw=>{const request=JSON.parse(String(raw));if(request.t!=='invoke')return;calls.push(request);
      if(request.cmd==='lead_threads'&&heldThreads){heldThreads.push(request);return;}
      if(request.cmd==='lead_history'&&heldHistory){heldHistory.push(request);historyRead?.();historyRead=null;return;}
      try{reply(request,answer(request));}catch(error){ws.send(JSON.stringify({t:'reply',id:request.id,ok:false,error:error.message}));}
    });});
    const page=await context.newPage();page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(e.stack??String(e)));
    const url=`http://127.0.0.1:${server.httpServer.address().port}/#/p/general/c/old-request`;
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:120000});
    if(width===390)await page.getByRole('button',{name:'Show chats',exact:true}).click();
    await page.locator('.sidebar-leads[aria-busy="true"]').waitFor();
    assert.equal(await page.locator('.task-chat-content').count(),0,'request/worker rows stay hidden while leads load');
    const shellBefore=await page.locator('.sidebar').boundingBox();
    const release=heldThreads;heldThreads=null;release.forEach(r=>reply(r,threads));
    await page.locator('.lead-row').first().waitFor();
    const shellAfter=await page.locator('.sidebar').boundingBox();assert.equal(shellBefore.width,shellAfter.width);assert.equal(shellBefore.height,shellAfter.height);
    assert.equal(await page.locator('.lead-row').count(),2);assert.equal(await page.locator('.sidebar .chat-btn').count(),0);
    await page.locator('.lead-row').filter({hasText:'STAR LEAD'}).getByText('1 unread',{exact:true}).waitFor();
    orient('tasks');await page.locator('.task-chat-content').waitFor();assert.ok(page.url().endsWith('/c/old-request'));
    orient('agents');await page.locator('.lead-row').first().waitFor();assert.ok(page.url().endsWith('/c/old-request'));
    send('chat-stream-activity',{key:'chat:lead-head',seq:null,running:true,busy:true,turnId:'busy-1',lastActivityAt:now,work:true});
    await page.locator('.lead-row').filter({hasText:'OCTIQ HEAD'}).locator('[data-state="working"]').waitFor();
    send('permission-ask',{id:'ask',chatKey:'chat:lead-head',toolName:'Bash',toolInput:{command:'git status'},summary:'Inspect status',createdAt:now});
    await page.locator('.lead-row').first().filter({hasText:'OCTIQ HEAD'}).locator('[data-state="waiting"]').waitFor();
    await page.screenshot({path:join(artifacts,`lead-sidebar-${width}.png`),fullPage:true});
    const opens=calls.filter(c=>c.cmd==='lead_thread_open').length;
    await page.locator('.sidebar-new-chat').click();await page.waitForURL('**/c/lead-head');
    assert.equal(calls.filter(c=>c.cmd==='lead_thread_open').length,opens+1);
    assert.equal(calls.filter(c=>c.cmd==='lead_thread_open').at(-1).args.agentId,'head');
    const more=page.getByRole('button',{name:/^More actions/});if(await more.isVisible())await more.click();
    assert.equal(await page.getByRole('button',{name:'Complete this chat',exact:true}).count(),0);
    assert.equal(await page.getByRole('button',{name:'Delete this chat',exact:true}).count(),0);
    await page.getByRole('button',{name:'Open lead history',exact:true}).click();
    await page.getByRole('dialog',{name:'Lead history',exact:true}).waitFor();
    const pendingHistory=heldHistory;heldHistory=null;pendingHistory.forEach(r=>reply(r,answer(r)));
    await page.getByRole('button',{name:/Earlier request/}).waitFor();
    await page.screenshot({path:join(artifacts,`lead-history-${width}.png`),fullPage:true});
    await page.getByRole('button',{name:/Earlier request/}).click();await page.waitForURL('**/c/old-request');
    await page.getByRole('button',{name:'Back to thread',exact:true}).click();await page.waitForURL('**/c/lead-head');
    if(width===1280) {
      // More unmounts its action control; the pending panel belongs to App.
      await page.locator('.actionbar').evaluate(el=>{el.style.maxWidth='210px';});
      heldHistory=[];let requested=new Promise(done=>{historyRead=done;});
      await page.getByRole('button',{name:/^More actions/}).click();
      await page.getByRole('button',{name:'Open lead history',exact:true}).click();await requested;
      await page.getByRole('dialog',{name:'Lead history',exact:true}).getByText('Loading history…').waitFor();
      const first=[...heldHistory];await page.getByRole('button',{name:'Close lead history',exact:true}).click();
      heldHistory=[];requested=new Promise(done=>{historyRead=done;});
      await page.getByRole('button',{name:/^More actions/}).click();
      await page.getByRole('button',{name:'Open lead history',exact:true}).click();await requested;
      const second=[...heldHistory];heldHistory=null;
      first.forEach(request=>reply(request,[{chatKey:'chat:stale',title:'Stale history',updatedAt:now,done:false}]));
      await page.getByRole('dialog',{name:'Lead history',exact:true}).getByText('Loading history…').waitFor();
      second.forEach(request=>reply(request,answer(request)));
      await page.getByRole('button',{name:/Earlier request/}).waitFor();
      assert.equal(await page.getByText('Stale history',{exact:true}).count(),0);
      await page.getByRole('button',{name:'Close lead history',exact:true}).click();
      await page.locator('.actionbar').evaluate(el=>{el.style.maxWidth='';});
    }
    if(width===390)await page.getByRole('button',{name:'Show chats',exact:true}).click();
    failOpen=true;await page.locator('.lead-row').filter({hasText:'STAR LEAD'}).click();
    await page.getByRole('alert').filter({hasText:'Lead thread could not be opened.'}).first().waitFor();assert.ok(page.url().endsWith('/c/lead-head'));failOpen=false;
    await page.locator('.lead-row').filter({hasText:'STAR LEAD'}).click();await page.waitForURL('**/c/lead-star');
    if(width===390)await page.getByRole('button',{name:'Show chats',exact:true}).click();
    await page.locator('.sidebar-places').getByRole('button',{name:'Agents',exact:true}).click();
    const agent=page.locator('.dash-agent').filter({has:page.locator('.team-row-name',{hasText:'OCTIQ FE'})});
    await agent.waitFor();await agent.getByRole('button',{name:/Implement sidebar/}).first().click();
    await page.waitForURL('**/c/orch-worker');
    if(width===390) await page.getByRole('button',{name:'Tasks',exact:true}).click();
    else { const showTasks=page.getByRole('button',{name:/^Show the task column/}); if(await showTasks.isVisible()) await showTasks.click(); }
    const row=page.locator('[data-task-id="task"]');await row.waitFor();
    await row.getByRole('button',{name:/Open task chat:/}).first().click();
    await page.waitForURL('**/c/orch-worker');
    assert.equal(await page.locator('.sidebar .chat-btn').count(),0);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await context.close();results.push({width,leads:true,history:true,orientationLive:true,workerReachable:true});
  }
  // Agents mode OFF keeps today's list under either scheduling orientation.
  const context=await browser.newContext({viewport:{width:1280,height:960},reducedMotion:'reduce'});
  await context.addInitScript(()=>{localStorage.setItem('octiq.agentsMode','off');localStorage.setItem('octiq.v2.gitColumn','0');});
  await context.route('**/token',r=>r.fulfill({body:'mock-token'}));await context.route('**/auth',r=>r.fulfill({body:'ok'}));
  await context.routeWebSocket(/\/ws(?:\?|$)/,ws=>{socket=ws;ws.onMessage(raw=>{const r=JSON.parse(String(raw));if(r.t==='invoke')reply(r,answer(r));});});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/#/p/general/c/old-request`,{waitUntil:'domcontentloaded'});
  await page.locator('.task-chat-content').waitFor();assert.equal(await page.locator('.lead-row').count(),0);
  orient('tasks');await page.locator('.task-chat-content').waitFor();assert.equal(await page.locator('.lead-row').count(),0);
  await context.close();assert.deepEqual(errors,[]);
  await writeFile(join(artifacts,'results.json'),JSON.stringify({results,errors},null,2));
  console.log(JSON.stringify({artifacts,results,errors},null,2));
}finally{await browser?.close();await server.close();}
