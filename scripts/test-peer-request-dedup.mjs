// Real OctiqFlow server/socket and a deterministic Codex app-server stand-in.
// No model calls. An ordinary approved check must block equivalent peer work.
// node scripts/test-peer-request-dedup.mjs [octiq-server] [evidence-dir]
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binary = process.argv[2] || path.join(root, "src-tauri/target/debug/octiq-server");
const evidence = process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), "octiq-bookkeeping-evidence-"));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-bookkeeping-"));
const taskHome = path.join(fixture, "home"), bin = path.join(fixture, "bin"), repo = path.join(fixture, "repo");
for (const dir of [taskHome, bin, repo, evidence]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# Isolated Codex fixture\n");
for (const args of [["init", "-q", "-b", "develop"], ["add", "README.md"], ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]]) execFileSync("git", args, { cwd: repo });
const wireLog = path.join(evidence, "wire.jsonl");
function cli() {
 const fs=require('node:fs'),readline=require('node:readline');
 const log=v=>fs.appendFileSync(process.env.BOOKKEEPING_WIRE,JSON.stringify(v)+'\n');
 if(process.argv.includes('--version')){ console.log('stub 1');return; }
 if(process.argv.includes('exec')) {log({helperSpawn:true,argv:process.argv.slice(2)}); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Read-only answer'}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));return;}
 const out=v=>process.stdout.write(JSON.stringify(v)+'\n');
 log({fixtureHook:{chatKey:process.env.OCTIQ_CHAT_KEY,capability:process.env.OCTIQ_CHAT_CAPABILITY}});
 readline.createInterface({input:process.stdin}).on('line',line=>{let m=JSON.parse(line); log({received:m});
 if(m.method==='initialize') out({id:m.id,result:{userAgent:'fixture'}});
 if(m.method==='thread/start'||m.method==='thread/resume') out({id:m.id,result:{thread:{id:'fixture-thread'}}});
 if(m.method==='turn/start'){out({id:m.id,result:{turn:{id:'fixture-turn'}}});out({method:'turn/started',params:{threadId:'fixture-thread',turn:{id:'fixture-turn'}}});out({method:'turn/completed',params:{threadId:'fixture-thread',turn:{id:'fixture-turn',status:'completed'}}});}
 });
}
fs.writeFileSync(path.join(bin, "codex"), `#!${process.execPath}\n(${cli.toString()})();\n`, { mode: 0o755 });
const shell = path.join(bin, "fixture-shell");
fs.writeFileSync(shell, "#!/bin/sh\nif [ \"$1\" = '-lc' ]; then shift; exec /bin/sh -c \"$@\"; fi\nif [ \"$1\" = '-l' ]; then shift; fi\nexec /bin/sh \"$@\"\n", { mode: 0o755 });
const port = 19000 + Math.floor(Math.random() * 1000), token = "isolated-bookkeeping";
const env = { ...process.env, HOME: taskHome, SHELL: shell, PATH: `${bin}:${process.env.PATH}`, BOOKKEEPING_WIRE: wireLog, OCTIQ_WEB_PORT: String(port), OCTIQ_WEB_TOKEN: token, OCTIQ_CHAT_IDLE_MINS: "0" };
const server = spawn(binary, [], { env, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "", ws, workerKey, sequence = 0;
server.stdout.on("data", data => { serverLog += data; }); server.stderr.on("data", data => { serverLog += data; });
const events = [], replies = new Map();
const wait = async (label, test, ms = 15000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { const value = await test(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(`Timed out: ${label}`);
};
const invoke = (cmd, args = {}) => new Promise((resolve, reject) => {
  const id = ++sequence; replies.set(id, { resolve, reject }); ws.send(JSON.stringify({ t: "invoke", id, cmd, args }));
});
const wire = () => fs.existsSync(wireLog) ? fs.readFileSync(wireLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
try {
 await wait('server',async()=>{try{return(await fetch(`http://127.0.0.1:${port}/healthz`)).ok}catch{return false}});
 ws=new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
 ws.onmessage=({data})=>{const f=JSON.parse(data);if(f.t==='event')events.push(f);else if(f.t==='reply'){const p=replies.get(f.id);if(p){replies.delete(f.id);f.ok?p.resolve(f.result):p.reject(new Error(f.error));}}};
 const project=await invoke('add_workspace',{name:'Review fixture',primaryPath:repo});const coordinator='chat:fixture-coordinator';
 // Open an ordinary run before registering the lead: its initial tasks do not need a plan card.
 const team=await invoke('agent_team_save',{team:{name:'Fixture team',projectId:project.id}});
 const draft=(name,reportsTo)=>({name,role:'Fixture',agent:'codex',model:'gpt-6.1-sol',access:'auto',projectId:project.id,reportsTo,teamId:team.id});
 const lead=await invoke('team_save',{agent:draft('Fixture Lead',null)});
 const workerAgent=await invoke('team_save',{agent:draft('Fixture Worker',lead.id)});
 const qa=await invoke('team_save',{agent:draft('Fixture QA',lead.id)});
 await invoke('team_brief',{chatKey:coordinator,projectId:project.id,leadId:lead.id,task:'Fixture'});
 const run=await invoke('orchestration_run_create',{actorChatKey:coordinator,objective:'Review peer guard',workspaceId:project.id,rootPath:repo,maxConcurrent:1,workspaceMode:'worktree'});
 const task=await invoke('orchestration_task_create',{actorChatKey:coordinator,runId:run.id,title:'Worker',spec:'Read fixture',assignee:workerAgent.id});
 const qaTask=await invoke('orchestration_task_create',{actorChatKey:coordinator,runId:run.id,title:'Check fixture',spec:'Review fixture\n\nExpected output\nReport',assignee:qa.id,kind:'check'});
 const snap0=await invoke('orchestration_snapshot',{runId:run.id});
 console.log('INITIAL',JSON.stringify(snap0.runs[0].planApproval));
 if(snap0.runs[0].planApproval?.status==='pending'){
  await new Promise(r=>setTimeout(r,2100));let p=snap0.runs[0].planApproval;
  await invoke('orchestration_plan_approve',{actorChatKey:coordinator,runId:run.id,taskIds:snap0.tasks.map(t=>t.id),revision:p.revision,surface:'chat',shownMs:2100,updatedMs:2100});
 }
 const worker=await invoke('orchestration_worker_start',{actorChatKey:coordinator,taskId:task.id,agent:'codex',model:'gpt-6.1-sol',access:'auto'});workerKey=worker.workerChatKey;
 const hook=await wait('capability',()=>wire().find(x=>x.fixtureHook?.chatKey===workerKey)?.fixtureHook);
 await wait('turn done',()=>events.some(e=>e.payload?.key===workerKey&&e.payload.event?.type==='turn.completed'));
 const post=async(action,args)=>{const r=await fetch(`http://127.0.0.1:${port}/hook/orchestration`,{method:'POST',headers:{'content-type':'application/json','x-octiq-chat-capability':hook.capability},body:JSON.stringify({chatKey:workerKey,action,args})});return{status:r.status,body:await r.json()}};
 const before=await invoke('orchestration_snapshot',{runId:run.id});
 const duplicate=await post('peer_request',{peer:qa.id,title:'Check fixture',request:'Review fixture',output:'Report'});
 const after=await invoke('orchestration_snapshot',{runId:run.id});
 const peerAsk=await post('peer_ask',{teammateId:qa.id,question:'Read fixture?'});
 const result={qaTaskId:qaTask.id,beforePlan:before.runs[0].planApproval,duplicate,afterPlan:after.runs[0].planApproval,qaApproved:before.tasks.find(t=>t.id===qaTask.id).approved,beforeTaskCount:before.tasks.length,afterTaskCount:after.tasks.length,peerAsk,helperSpawnCount:wire().filter(x=>x.helperSpawn).length,permissionCards:(await invoke('permission_pending')).length};
 fs.writeFileSync(path.join(evidence,'peer-probe.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
 assert.equal(before.runs[0].planApproval.status, "approved");
 assert.equal(before.runs[0].planApproval.revision, 3);
 assert.equal(before.tasks.length, 2);
 assert.equal(duplicate.status, 400);
 assert(JSON.stringify(duplicate.body).includes(qaTask.id), "refusal must identify existing ordinary check");
 assert.deepEqual(after.runs[0].planApproval, before.runs[0].planApproval);
 assert.equal(after.tasks.length, 2);
 assert.equal(peerAsk.status, 200, "read-only peer advice remains allowed");
 assert.equal(result.helperSpawnCount, 1);
 assert.equal(result.permissionCards, 0);
 console.log("PASS: approved revision 3 unchanged, tasks remain at 2; read-only advice still allowed");
} finally {
  fs.writeFileSync(path.join(evidence, "server.log"), serverLog);
  fs.writeFileSync(path.join(evidence, "events.json"), JSON.stringify(events, null, 2));
  if (ws) { try { if (workerKey) await invoke("chat_stop", { key: workerKey }); } catch {} ws.close(); }
  server.kill("SIGTERM");
  await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once("exit", resolve); });
  fs.rmSync(fixture, { recursive: true, force: true });
}
