// Real decision components and action bar, mocked bridge. Produces a review
// sheet at both widths in both themes, and checks names, targets and answers.
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {browserPaths} from './browser-paths.mjs';
const {webRoot,require,moduleUrl}=browserPaths(import.meta.url);
const {createServer}=await import(moduleUrl(require.resolve('vite')));
const {chromium}=await import(moduleUrl(process.env.PLAYWRIGHT_MODULE||'playwright'));
const output=process.env.OCTIQ_EVIDENCE_DIR||'/tmp/octiq-icon-actions';
await mkdir(output,{recursive:true});
const entry=`
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ActionIcon,ACTION_NAMES} from '/src/components/ActionIcon';
import {ActionBar} from '/src/components/ActionBar';
import {PermissionAsk} from '/src/components/PermissionAsk';
import {AccessRequestCard} from '/src/components/AccessRequestCard';
import {SafetyBlock} from '/src/components/SafetyBlock';
import {HandoverCards} from '/src/components/HandoverCards';
import {handover} from '/src/lib/handover.fixture';
import {ChatRunDecisionCards} from '/src/components/ChatRunDecisionCards';
import failureCard from '/src/lib/__fixtures__/host/failure_awaits_person.json';
import failedReviewCard from '/src/lib/__fixtures__/host/failure_check_retries_used.json';
import gateCard from '/src/lib/__fixtures__/host/failure_escalated.json';
import {PlanReview,PlanRejectConfirmation} from '/src/components/PlanReview';
import {WorkspaceCleanupCard} from '/src/components/WorkspaceCleanupCard';
import {cleanupAsked} from '/src/lib/__fixtures__/workspaceCleanup';
import {ConfirmDialog} from '/src/components/Confirm';
import {CompleteChatConfirm} from '/src/components/CompleteChat';
import {confirmContent} from '/src/lib/chatComplete';
import {ChatQuestionsContext} from '/src/components/InlineQuestions';
import {MessageList} from '/src/components/MessageList';
import {GateAnswer,ReopenQuestion,StartButton,OrchestrationPanel} from '/src/components/OrchestrationPanel';
import {ChoiceCard} from '/src/components/ProviderFallback';
import {applyTheme} from '/src/lib/themeStore';
import pending from '/src/lib/__fixtures__/host/workspace_choice_pending.json';

import '@fontsource-variable/inter';
import '/src/design-system.css';
import '/src/styles.css';
window.calls=[];
window.iconInvoke=async(cmd,args)=>{window.calls.push({cmd,args}); if(['orchestration_snapshot','orchestration_summary','orchestration_run_detail'].includes(cmd))return merged;return null;};
const noop=()=>{};
const record=(cmd)=>(...args)=>window.calls.push({cmd,args});
const theme=new URL(location.href).searchParams.get('theme')||'dark';applyTheme(theme);
const phone=innerWidth<860;
const run=pending.runs[0], tasks=pending.tasks;
// A minimal scene with the same completed-task fields as the panel's render
// fixture. It is isolated from captured failure/retry evidence.
const merged={runs:[{id:'icons-run',objective:'Review merged work',coordinatorChatKey:'chat:icons',workspaceId:'icons',rootPath:'/repo',status:'completed',maxConcurrent:2,createdAt:1,updatedAt:2}],tasks:[{id:'icons-task',runId:'icons-run',title:'Implement icons',spec:'',dependsOn:[],status:'completed',activeAttemptId:'icons-attempt',createdAt:1,updatedAt:2}],attempts:[{id:'icons-attempt',runId:'icons-run',taskId:'icons-task',number:1,workerChatKey:'chat:icons-worker',agent:'codex',access:'auto',status:'completed',cwd:'/repo-task',branch:'feature/icons',isWorktree:true,filesModified:[],createdAt:1,updatedAt:2}],gates:[],messages:[]};
merged.tasks[0].workspace={plan:{mode:'worktree',cwd:'/repo-task',checkoutRoot:'/repo-task',repositoryRoot:'/repo',branch:'feature/icons',baseBranch:'develop',baseSha:'a'.repeat(40),managed:true,isRepo:true,warnings:[],initialStatus:''},state:'retained',abandoned:false,validationPaths:[],delivery:{headSha:'b'.repeat(40),dirty:false,hasCommits:true,pushed:true,merged:true,checkedAt:Date.now(),notes:[]}};
const claude={id:'claude',chatKey:'chat:c1',provider:'claude',kind:'high-risk-action',title:"Claude's auto mode blocked an action",summary:'Production Deploy',detail:'The auto mode classifier refused this action.',action:'eas update --branch production'};
const external={id:'external',chatKey:'chat:c1',kind:'external-data',title:'Codex blocked external data sharing',summary:'This would send the project brief to an external service.',detail:'The reviewer requires approval for this transfer.'};
const outage={...claude,id:'outage',kind:'outage',title:'The safety classifier is unavailable',actions:['git push origin feature/icons'],commands:[{action:'git push origin feature/icons',count:1,tool:'Bash',words:'git push',rule:'Bash(git push:*)'}],allow:{project:'/work/.claude/settings.local.json',user:'~/.claude/settings.json'}};
const access={id:'access',chatKey:'chat:c1',agent:'claude',current:'read',requested:'edits',reason:'Write the fix in the current project.',takes:'now',wait:true,answerWithinSecs:180};
const gate={id:'gate',runId:run.id,taskId:tasks[0].id,question:'How should this task continue?',status:'open',createdAt:1,options:['Start it again','Leave it']};
const question={id:'question',chatKey:'chat:c1',question:'Which database?',options:[{label:'Postgres'},{label:'SQLite'}],recommended:1};
const source={agent:'claude',model:'opus',effort:'high',access:'manual'};
const suggestion={agent:'codex',model:'gpt-6.1-sol',effort:'high',access:'manual'};
const scenes=[];
function scene(id,title,node){scenes.push(<section key={id} data-scene={id}><h2>{title}</h2>{node}</section>);}
function Bar(){const names=['tasks','git','focus','new','details','agents','pinned','width','run','refresh','history','back','copy','complete','delete'];const labels=['Tasks','Git','Focus','New task','Details','Agents','Pinned','Full width','Run','Reload','History','Back to thread','Copy ID','Complete','Delete'];return <ActionBar scrolls={phone} actions={names.map((name,i)=>({id:name,keep:100-i,node:<button className='icon-btn' aria-label={labels[i]} title={labels[i]} onClick={record(name)} data-icon-action><ActionIcon name={name}/>{i===0&&<span>3</span>}</button>}))}/>;}
function Gate({door='person'}){const [value,setValue]=useState('Keep the task here');return <GateAnswer gate={gate} door={door} mine={!phone} busy={false} value={value} onChange={setValue} onResolve={record('gate')}/>;}
scene('bar','Action bar · start',<Bar/>);scene('bar-end','Action bar · scrolled to end on phone',<Bar/>);
scene('permission','Tool permission · Allow once / Always / Deny',<PermissionAsk ask={{id:'permission',provider:'codex',toolName:'Bash',toolInput:{command:'pnpm test'}}} onAnswered={noop}/>);
scene('permission-once','Host change · Allow / Deny',<PermissionAsk ask={{id:'once',provider:'codex',once:true,toolName:'mcp__octiq__agent_register',toolInput:{},change:'Register Nova as frontend developer.'}} onAnswered={noop}/>);
scene('permission-held','Long command · visible reason and held answers',<PermissionAsk ask={{id:'held',provider:'codex',toolName:'Bash',toolInput:{command:Array.from({length:14},(_,i)=>'echo step '+i).join('\\n')}}} onAnswered={noop}/>);
scene('access','Access request',<AccessRequestCard request={access} onAnswer={async(...args)=>record('access')(...args)}/>);
scene('codex','Codex safety decision',<SafetyBlock block={external} onContinue={record('continue')} onAnswered={noop}/>);
scene('claude','Claude auto-mode refusal',<SafetyBlock block={claude} onContinue={record('continue')} onAnswered={noop}/>);
scene('claude-open','Claude refusal · details open',<SafetyBlock block={{...claude,id:'claude-open'}} startOpen onContinue={record('continue')} onAnswered={noop}/>);
scene('claude-rules','Claude refusal · lasting permission choices',<SafetyBlock block={{...claude,id:'claude-rules',action:'git push origin feature/icons',rules:['Bash(git push:*)'],uncovered:[],allow:{project:'/work/.claude/settings.local.json',user:'~/.claude/settings.json'}}} startOpen onContinue={record('continue')} onAnswered={noop}/>);
scene('outage','Classifier outage · retry and lasting permissions',<SafetyBlock block={outage} startOpen onContinue={record('continue')} onAnswered={noop}/>);
scene('handover','Handover · keep / hand over',<HandoverCards outgoing={[handover()]} onDecide={record('handover')}/>);
scene('route','Route · cancel / open chat',<HandoverCards outgoing={[handover({id:'route',kind:'route',route:{discuss:true,message:'Please review the current changes.',attachments:[],unreadable:[]}})]} onDecide={record('route')}/>);
scene('plan','Plan approval',<PlanReview run={run} tasks={tasks} drafting={false} onRequestChanges={noop}/>);
for(const [id,snapshot] of [['retry-card',failureCard],['failed-review-card',failedReviewCard],['gate-card',gateCard]])scene(id,id,<ChatRunDecisionCards snapshot={snapshot} chatKey={snapshot.runs[0].coordinatorChatKey} onOpenChat={noop}/>);
scene('plan-reject','Plan rejection',<PlanRejectConfirmation reason='Please revise the task scope.' busy={false} disabled={false} rejecting={false} onReason={noop} onConfirm={record('reject')} onCancel={noop}/>);
scene('question','Question · Send answer',<ChatQuestionsContext.Provider value={{questions:[question],onDone:noop}}><MessageList messages={[{id:'question-turn',role:'assistant',streaming:false,blocks:[{kind:'tool',id:'tool-question',name:'mcp__octiq__ask_user',argsJson:'{}',args:{question:question.question,options:question.options,recommended:1},state:'running'}]}]} conversationId='c1' busy={false}/></ChatQuestionsContext.Provider>);
scene('gate','Gate · Answer',<Gate/>);scene('gate-main','Gate · Send to main chat',<Gate door='chat'/>);
scene('reopen','Review fixes · Reopen task',<ReopenQuestion task={tasks[0]} busy={false} onCancel={noop} onReopen={record('reopen')}/>);
scene('cleanup','Worktree cleanup · irreversible words retained',<WorkspaceCleanupCard card={cleanupAsked} onAnswer={async(...args)=>record('cleanup')(...args)}/>);
scene('provider','Provider fallback',<ChoiceCard choice={{id:'choice',key:'chat:c1',label:'Continue the existing task',source,preferred:suggestion,options:[{agent:'codex',installed:true,limited:false,suggestion}]}} onDone={noop}/>);
scene('complete','Complete chat confirmation',<CompleteChatConfirm content={confirmContent(undefined)} onConfirm={record('complete')} onCancel={noop}/>);
scene('confirm','General confirmation',<ConfirmDialog options={{title:'Confirm this answer?',confirmLabel:'Confirm',decision:true}} onAnswer={record('confirm')}/>);
scene('stop','Stop worker confirmation · words retained',<ConfirmDialog options={{title:'Stop this worker?',body:'This stops the active attempt.',confirmLabel:'Stop worker',cancelLabel:'Keep it running',danger:true}} onAnswer={record('stop')}/>);
scene('delete','Delete confirmation · words retained',<ConfirmDialog options={{title:'Delete this saved project?',body:'This removes the project record.',confirmLabel:'Delete',danger:true}} onAnswer={record('delete')}/>);
scene('delivery','Merged worktree · cleanup then Confirm removal',<div style={{height:600,display:'flex'}}><OrchestrationPanel embedded initialSnapshot={merged} project={{id:merged.runs[0].workspaceId,name:'Review fixture'}} coordinatorKey={merged.runs[0].coordinatorChatKey} onOpenChat={noop} onClose={noop}/></div>);
scene('legend','Fixed action glyphs',<div className='icon-legend'>{ACTION_NAMES.map(name=><span key={name}><ActionIcon name={name}/>{name}</span>)}</div>);
createRoot(document.getElementById('root')).render(<main className='icon-scenes'><h1>Icon actions · {theme} · {innerWidth}px</h1>{scenes}</main>);
`;
const ts=require('typescript');
const parsed=ts.createSourceFile('icon-actions.tsx',entry,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
assert.deepEqual(parsed.parseDiagnostics.map(item=>ts.flattenDiagnosticMessageText(item.messageText,' ')),[]);
const server=await createServer({root:webRoot,configFile:join(webRoot,'vite.config.ts'),server:{host:'127.0.0.1',port:0},plugins:[{
 name:'icon-actions-scenes',enforce:'pre',resolveId(id){if(id==='/__icon-actions.tsx')return id;if(id.endsWith('/lib/bridge')||id.endsWith('/lib/bridge.ts')||id==='./bridge')return '\0icon-bridge';},
 load(id){if(id==='/__icon-actions.tsx')return entry;if(id==='\0icon-bridge')return 'export const bridge={invoke:(...args)=>window.iconInvoke(...args),on:()=>()=>{},onState:()=>()=>{},state:()=>"open"};';},
 configureServer(vite){vite.middlewares.use(async(req,res,next)=>{if(req.url?.split('?')[0]!=='/__icon-actions')return next();res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/__icon-actions',`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{margin:0;overflow:auto!important}.icon-scenes{max-width:1000px;margin:auto;padding:16px}.icon-scenes>h1{font-size:20px}.icon-scenes>section{border-bottom:1px solid var(--border);padding:18px 0;min-width:0}.icon-scenes>section>h2{font-size:13px;color:var(--fg-2);margin:0 0 14px}.icon-scenes .ask-scrim{position:static;display:block;padding:0;background:transparent;backdrop-filter:none}.icon-scenes .ask{margin:0;width:100%;max-width:none;box-shadow:none}.icon-scenes .plan-review-foot{position:static}.icon-scenes .provider-choice{margin:0}.icon-scenes .handover-card{margin:0}.icon-scenes .actionbar{z-index:0}.icon-legend{display:flex;gap:16px;flex-wrap:wrap}.icon-legend>span{display:flex;align-items:center;gap:8px;min-width:140px;font-size:12px}@media(max-width:600px){.icon-scenes{padding:12px}}
</style></head><body><div id="root"></div><script type="module" src="/__icon-actions.tsx"></script></body></html>`));});}
}]});
let browser;const errors=[],report={output,scenes:[],answers:[]};
try{
 await server.listen();browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
 for(const theme of ['light','dark'])for(const width of [1280,390]){
  const context=await browser.newContext({viewport:{width,height:900},hasTouch:width===390,reducedMotion:'reduce'});const page=await context.newPage();page.on('pageerror',e=>{errors.push(e.message);console.error(e.stack);});page.on('console',m=>{if(m.type()==='error')console.error(m.text());});
  await page.goto(server.resolvedUrls.local[0]+'__icon-actions?theme='+theme);await page.locator('[data-scene="legend"]').waitFor();await page.evaluate(()=>document.fonts.ready);
  if(width===390)await page.locator('[data-scene="bar-end"] .actionbar-row').evaluate(e=>e.scrollLeft=e.scrollWidth);
  // Open the actual worktree removal question without accepting it.
  const delivery=page.locator('[data-scene="delivery"]');
  const clean=delivery.getByRole('button',{name:'Clean up worktree',exact:true});
  const accordion=delivery.locator('.orch-run-accordion-toggle').first();
  if(await accordion.count() && await accordion.getAttribute('aria-expanded')==='false')await accordion.click();
  for(const group of await delivery.locator('button.run-group-head[aria-expanded="false"]').all())if(await group.isVisible())await group.click();
  if(!(await clean.first().isVisible()))await delivery.locator('.orch-task-expand').first().click();
  await clean.first().click();
  await delivery.getByRole('button',{name:'Confirm removal',exact:true}).waitFor();
  // Fill review fixes so its action can be assessed in its enabled state.
  await page.locator('[data-scene="reopen"] textarea').fill('Address the review findings.');
  const facts=await page.locator('button[data-icon-action],button:has(>svg.action-icon)').evaluateAll(list=>list.filter(e=>e.getBoundingClientRect().width&&e.getBoundingClientRect().height).map(e=>({name:e.getAttribute('aria-label'),title:e.title,w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height,icon:e.querySelector('svg')?.getBoundingClientRect().width,words:e.textContent.trim(),scene:e.closest('[data-scene]')?.getAttribute('data-scene')})));
  for(const f of facts){assert(f.name,JSON.stringify(f));assert(f.title,JSON.stringify(f));assert(f.w>=(width===390?44:28)&&f.h>=(width===390?44:28),JSON.stringify(f));assert.equal(f.icon,16,JSON.stringify(f));if(!f.words)assert.equal(Math.round(f.w),width===390?44:28,JSON.stringify(f));}
  assert.equal(await page.locator('[data-scene="permission"] .ask-card-actions button').count(),3);
  // Pointer tooltips explain the scope; the accessible name stays short.
  assert.equal(await page.locator('[data-scene="permission"]').getByRole('button',{name:'Always',exact:true}).getAttribute('title'),'Stop asking about this program for the rest of this chat');
  assert.equal(await page.locator('[data-scene="outage"]').getByRole('button',{name:'Always allow in this project',exact:true}).getAttribute('title'),'Adds Bash(git push:*) to /work/.claude/settings.local.json, then retries. In a task worktree the rule goes when the worktree does.');
  for(const scene of ['outage','claude-rules'])assert.equal(await page.locator('[data-scene="'+scene+'"]').getByRole('button',{name:'Always allow everywhere',exact:true}).locator('svg').getAttribute('data-action-icon'),'alwaysEverywhere');
  assert.equal(await page.locator('[data-scene="stop"]').getByRole('button',{name:'Stop worker',exact:true}).locator('svg').getAttribute('data-action-icon'),'stop');
  for(const [name,icon] of [['Deny','deny'],['Always','always'],['Allow once','allow']])assert.equal(await page.locator('[data-scene="permission"]').getByRole('button',{name,exact:true}).locator('svg').getAttribute('data-action-icon'),icon);
  assert(await page.locator('[data-scene="permission-held"] [aria-disabled="true"]').count()>=2);
  assert.equal((await page.locator('[data-scene="delete"]').getByRole('button',{name:'Delete',exact:true}).textContent()).trim(),'Delete');
  assert.equal(await page.locator('[data-scene="bar"] .topbar-action-label').count(),0);
  await page.screenshot({path:join(output,`sheet-${width}-${theme}.png`),fullPage:true});
  // Each card is also saved separately for an unscaled inspection.
  for(const section of await page.locator('[data-scene]').all()){const id=await section.getAttribute('data-scene');if(id!=='legend')await section.screenshot({path:join(output,`${id}-${width}-${theme}.png`)});}
  report.scenes.push({width,theme,buttons:facts});
  // Exact named buttons still invoke their existing contract.
  await page.locator('[data-scene="permission"]').getByRole('button',{name:'Allow once',exact:true}).click();
  await page.locator('[data-scene="handover"]').getByRole('button',{name:'Keep it here',exact:true}).click();
  const calls=await page.evaluate(()=>window.calls);assert(calls.some(c=>c.cmd==='permission_decide'&&c.args.decision==='allow'),JSON.stringify(calls));assert(calls.some(c=>c.cmd==='handover'));
  report.answers.push({width,theme,calls});await context.close();
 }
 assert.deepEqual(errors,[]);await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,sheets:report.scenes.map(({width,theme,buttons})=>({width,theme,buttons:buttons.length})),errors},null,2));
}finally{await browser?.close();await server.close();}
