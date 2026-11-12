// Actual App, fixture socket, disposable browser; never reads a live profile.
// READING_BASELINE=1 records the old behaviour without restore assertions.
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {browserPaths} from '../../scripts/browser-paths.mjs';
const {webRoot: web, require, moduleUrl} = browserPaths(new URL('../../scripts/browser-paths.mjs', import.meta.url).href);
const {createServer} = await import(pathToFileURL(require.resolve('vite')).href);
const {chromium} = await import(moduleUrl(process.env.PLAYWRIGHT_MODULE || 'playwright'));
const baseline = process.env.READING_BASELINE === '1';
const output = process.env.READING_OUTPUT || join(tmpdir(), 'octiq-chat-reading');
const project = {id:'reading', name:'Reading fixture', primary_path:'/fixture', paths:['/fixture'], env:{}};
const rows = ['a','b',...Array.from({length:8},(_,i)=>`evict${i}`)].map((id,i)=>({id,projectId:project.id,title:`Chat ${id}`,createdAt:i+1,updatedAt:i+1,modelId:'claude:sonnet-4-6',access:'read'}));
const frames = n => [
  {seq:n*8+1,event:{type:'user',uuid:`u-${n}`,octiq_user_turn_id:`t-${n}`,message:{content:[{type:'text',text:`Question ${n}.`}]}}},
  {seq:n*8+2,event:{type:'assistant',message:{id:`a-${n}`,content:[{type:'text',text:`Working ${n}.`},{type:'tool_use',id:`c-${n}`,name:'Read',input:{path:`/fixture/file-${n}`}}]}}},
  {seq:n*8+3,event:{type:'user',message:{content:[{type:'tool_result',tool_use_id:`c-${n}`,content:`Tool evidence ${n}. `+'x'.repeat(4096)}]}}},
  {seq:n*8+4,event:{type:'item.completed',item:{id:`p1-${n}`,type:'agent_message',phase:'commentary',text:`First progress ${n}.`}}},
  {seq:n*8+5,event:{type:'item.completed',item:{id:`p2-${n}`,type:'agent_message',phase:'commentary',text:`Second progress ${n}.`}}},
  {seq:n*8+6,event:{type:'item.completed',item:{id:`p3-${n}`,type:'agent_message',phase:'commentary',text:`Latest progress ${n}.`}}},
  {seq:n*8+7,event:{type:'assistant',message:{id:`f-${n}`,content:[{type:'text',text:`Answer ${n}.\n\n`+('A paragraph for reading history. '.repeat(10)+'\n\n').repeat(3)}]}}},
  {seq:n*8+8,event:{type:'result',subtype:'success'}},
];
let server,browser,scratch;
try {
  await mkdir(output,{recursive:true}); scratch=await mkdtemp(join(tmpdir(),'octiq-reading-state-'));
  server=await createServer({root:web,cacheDir:join(scratch,'.vite'),server:{host:'127.0.0.1',port:0,strictPort:false}}); await server.listen();
  const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{channel:'chrome'})});
  const results=[];
  for(const width of [1280,390]) {
    const context=await browser.newContext({viewport:{width,height:844},...(width===390?{isMobile:true,hasTouch:true}:{})});
    const calls=[],errors=[]; let socket,appended=false,scene='reading';
    const empty={runs:[],tasks:[],attempts:[],gates:[],messages:[],notifications:[],reports:{}};
    const detail=()=>({...empty,runs:[{id:'r',objective:'Reading mission',coordinatorChatKey:'chat:a',workspaceId:project.id,rootPath:'/fixture',status:'running',maxConcurrent:1,createdAt:1,updatedAt:1,
      ...(scene==='plan'?{planApproval:{status:'pending',requestedAt:1,revision:1}}:{})}],tasks:[{id:'task',runId:'r',title:'Reading task',spec:'Full task brief. '.repeat(80),dependsOn:[],status:scene==='plan'?'planned':'running',heldByPlan:scene==='plan',createdAt:1,updatedAt:1}],runRevisions:{r:'fixture:1'}});
    await context.route('**/token',route=>route.fulfill({body:'fixture'}));
    await context.routeWebSocket(/\/ws\?/,ws=>{socket=ws;ws.onMessage(raw=>{
      const c=JSON.parse(String(raw));if(c.t!=='invoke')return;calls.push(c);const a=c.args??{};let result=[];
      switch(c.cmd){
        case 'chat_subscribe':result={chatKeys:a.chatKeys};break;
        case 'list_workspaces':result=[project];break;
        case 'chat_index_list':result=rows;break;
        case 'orchestration_summary':result={...(scene==='reading'?empty:detail()),summary:true};break;
        case 'orchestration_run_detail':result=detail();break;
        case 'chat_page': {
          const last=a.before==null?(appended?40:39):Math.floor((a.before-2)/8),first=Math.max(0,last-7);
          result={events:Array.from({length:last-first+1},(_,i)=>frames(first+i)).flat(),context:[],before:first?first*8+1:null};break;
        }
        case 'chat_since':result=appended&&a.key==='chat:a'&&a.after<328?frames(40):[];break;
        case 'chat_task':result=null;break;
        case 'resolve_paths':result=a.paths.map(()=>null);break;
        case 'usage_summary':result={sessions:[],totals:{}};break;
      }
      ws.send(JSON.stringify({t:'reply',id:c.id,ok:true,result}));
    });});
    const page=await context.newPage();page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(String(e)));
    await page.goto(`${origin}/?token=fixture#/c/a`);
    await page.locator('.msgs').getByText('Answer 39.',{exact:true}).waitFor();
    for(let i=0;i<3;i++) {
      const before=await page.locator('.msgs [data-map-turn]').first().getAttribute('data-map-turn');
      await page.locator('.msgs .history-more button').evaluate(el=>el.click());
      await page.waitForFunction(first=>document.querySelector('.msgs [data-map-turn]')?.dataset.mapTurn!==first,before);
      await page.waitForTimeout(180);
    }
    // The same folded turn and tool must survive a switch. The latest page
    // does not contain this turn: its loaded earlier page must survive too.
    const work=page.locator('.msg-assistant').filter({hasText:'Answer 25.'}).first();
    await work.locator('.turn-work-head').evaluate(el=>el.click());
    await work.locator('.tool-head').evaluate(el=>el.click());
    await work.locator('.agent-progress-log summary').evaluate(el=>el.click());
    const draft=page.locator('textarea').last();await draft.fill('Reading draft A');
    await page.evaluate(()=>{
      const el=document.querySelector('.msgs'),node=[...el.querySelectorAll('[data-map-turn]')].find(n=>n.dataset.mapTurn==='u-25');
      window.readingOriginal=document.querySelector('.msgs .msg-assistant');
      el.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:-100}));
      el.scrollTop+=node.getBoundingClientRect().top-el.getBoundingClientRect().top-70;
      el.dispatchEvent(new Event('scroll'));
    });
    await page.waitForTimeout(550);
    const sample=()=>page.evaluate(()=>{
      const el=document.querySelector('.msgs'),node=[...el.querySelectorAll('[data-map-turn]')].find(n=>n.dataset.mapTurn==='u-25');
      const work=[...el.querySelectorAll('.msg-assistant')].find(n=>n.textContent.includes('Answer 25.'));
      return {top:el.scrollTop,gap:el.scrollHeight-el.scrollTop-el.clientHeight,anchor:node?.getBoundingClientRect().top-el.getBoundingClientRect().top,
        first:el.querySelector('[data-map-turn]')?.dataset.mapTurn,turns:el.querySelectorAll('[data-map-turn]').length,
        workOpen:work?.querySelector('.turn-work-head')?.getAttribute('aria-expanded'),toolOpen:work?.querySelector('.tool')?.classList.contains('is-open')??false,
        progressOpen:work?.querySelector('.agent-progress-log')?.open??false,
        sameNode:document.querySelector('.msgs .msg-assistant')===window.readingOriginal};
    });
    const before=await sample();await page.screenshot({path:join(output,`${baseline?'before':'after'}-${width}-left.png`)});
    await page.evaluate(()=>{location.hash='#/c/b';});await page.locator('.msgs').getByText('Answer 39.',{exact:true}).waitFor();
    await page.waitForFunction(()=>document.querySelector('textarea')?.value!=='Reading draft A');
    appended=true;
    const start=calls.length;
    await page.evaluate(()=>{location.hash='#/c/a';});
    await page.waitForFunction(()=>document.querySelector('textarea')?.value==='Reading draft A');
    await page.waitForTimeout(600);
    const after=await sample();await page.screenshot({path:join(output,`${baseline?'before':'after'}-${width}-returned.png`)});
    const result={width,baseline,before,after,driftPx:after.anchor-before.anchor,draft:await draft.inputValue(),
      reads:calls.slice(start).filter(c=>['chat_page','chat_since'].includes(c.cmd)).map(c=>({cmd:c.cmd,...c.args})),errors};
    console.log(JSON.stringify(result));results.push(result);
    if(!baseline){
      assert.ok(Math.abs(result.driftPx)<=2,`reading anchor drift ${result.driftPx}`);
      assert.equal(after.first,before.first,'loaded visible history remains drawn');
      assert.equal(after.workOpen,'true');assert.equal(after.toolOpen,true);assert.equal(after.progressOpen,true,'native disclosure returns open');
      assert.equal(result.draft,'Reading draft A');
      assert.ok(!result.reads.some(c=>c.cmd==='chat_page'&&c.before!=null),'return does not reload earlier history');
      // A new bottom visit must resume following subsequent output.
      await page.locator('.msgs .jump').evaluate(el=>el.click());await page.waitForTimeout(500);
      await page.evaluate(()=>{location.hash='#/c/b';});await page.waitForTimeout(200);
      await page.evaluate(()=>{location.hash='#/c/a';});await page.waitForTimeout(500);
      assert.ok((await sample()).gap<3,'bottom visit remains pinned');
      socket.send(JSON.stringify({t:'event',event:'chat-event',payload:{key:'chat:a',seq:329,event:{type:'assistant',message:{id:'live',content:[{type:'text',text:'New live output.\n\n'+'More live words. '.repeat(300)}]}}}}));
      await page.locator('.msgs').getByText('New live output.',{exact:true}).waitFor();await page.waitForTimeout(400);
      assert.ok((await sample()).gap<3,'bottom follows new output');
      // Actual App plan CardFold and run/task tabs. Readable state is kept;
      // freshness/consent still belongs to the live RunDetail lease.
      scene='plan';
      await page.goto(`${origin}/?token=fixture#/c/a`);
      const planFold=page.locator('.chat-plans .card-fold-toggle');
      await planFold.waitFor(); await planFold.evaluate(el=>el.click());
      assert.equal(await planFold.getAttribute('aria-expanded'),'true');
      await page.evaluate(()=>{location.hash='#/c/b';});await page.waitForTimeout(250);
      await page.evaluate(()=>{location.hash='#/c/a';});await planFold.waitFor();await page.waitForTimeout(250);
      assert.equal(await planFold.getAttribute('aria-expanded'),'true','CardFold returns open');
      scene='running'; await page.goto(`${origin}/?token=fixture#/c/a`);
      const showRun=async()=>{
        const surface=page.locator('.workflow-run-surface');await surface.waitFor({state:'attached'});
        if(!await surface.isVisible()){
          const column=page.getByRole('button',{name:/^Show the task column/});
          if(await column.count())await column.click();else await page.locator('.chat-workflow-views button').filter({hasText:/^Tasks/}).click();
        }
        await page.locator('.orch-tabs').waitFor();
      };
      await showRun();
      await page.locator('.orch-tabs [role="tab"]').filter({hasText:'Tasks'}).evaluate(el=>el.click());
      const taskOpen=page.locator('.orch-task-expand');await taskOpen.evaluate(el=>el.click());
      await page.locator('.orch-task-tabs [role="tab"]').filter({hasText:'Details'}).evaluate(el=>el.click());
      await page.locator('.orch-tabs [role="tab"]').filter({hasText:'Log'}).evaluate(el=>el.click());
      await page.evaluate(()=>{location.hash='#/c/b';});await page.waitForTimeout(250);
      await page.evaluate(()=>{location.hash='#/c/a';});await showRun();await page.waitForTimeout(250);
      assert.match(await page.locator('.orch-tabs [role="tab"][aria-selected="true"]').innerText(),/Coordination log|Log/,'run tab returns');
      await page.locator('.orch-tabs [role="tab"]').filter({hasText:'Tasks'}).evaluate(el=>el.click());
      assert.equal(await taskOpen.getAttribute('aria-expanded'),'true','task disclosure returns');
      assert.equal(await page.locator('.orch-task-tabs [role="tab"][aria-selected="true"]').innerText(),'Details','task tab returns');
      if(width===390) await page.locator('.chat-workflow-views button').filter({hasText:/^Chat/}).click();
      // Force eviction and ensure old UI choices do not resurrect on a fresh
      // reducer window. Also proves that old chats have no retained DOM.
      for(let i=0;i<8;i++) {
        const id=`evict${i}`;await page.evaluate(id=>{location.hash='#/c/'+id;},id);
        const until=Date.now()+30000;while(!calls.some(c=>c.cmd==='chat_page'&&c.args.key==='chat:'+id)&&Date.now()<until)await page.waitForTimeout(50);
        assert.ok(calls.some(c=>c.cmd==='chat_page'&&c.args.key==='chat:'+id));
        await page.locator('.msgs').getByText('Answer 40.',{exact:true}).waitFor({state:'attached'});await page.waitForTimeout(100);
      }
      assert.equal(await page.locator('.msgs').count(),1);
      scene='reading';await page.evaluate(()=>{location.hash='#/c/a';});await page.locator('.msgs').getByText('Answer 40.',{exact:true}).waitFor({state:'attached'});await page.waitForTimeout(400);
      assert.equal(await page.locator('.msgs .msg-assistant').filter({hasText:'Answer 25.'}).count(),0,'evicted loaded history is released');
      result.cardFold=true;result.tabs=true;result.bottomFollow=true;result.eviction=true;
      console.log(JSON.stringify({width,cardFold:true,tabs:true,bottomFollow:true,eviction:true}));
    }
    assert.deepEqual(errors,[]);await context.close();
  }
  await writeFile(join(output,baseline?'before.json':'after.json'),JSON.stringify(results,null,2));
} finally {await browser?.close();await server?.close();if(scratch)await rm(scratch,{recursive:true,force:true});}
