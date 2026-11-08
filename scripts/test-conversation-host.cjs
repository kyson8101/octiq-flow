"use strict";
// Run only through web::tests::conversation_mcp_equivalence_and_rss. All data
// is generated in the Rust test binary's scratch profile, then copied for the
// legacy MCP. No code discovers a real profile or starts a provider.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {spawn,execFileSync} = require("node:child_process");
const readline = require("node:readline");
const [mode,root] = process.argv.slice(2);
if (!root || !path.isAbsolute(root)) throw Error("An explicit scratch profile is required");
// Host-written JSON uses sorted object keys (serde_json::Value).
const encoded = v => JSON.stringify(v, (_key,value) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(k=>[k,value[k]])) : value);
const write = (file,v) => fs.writeFileSync(file,encoded(v));
function prepare() {
  fs.mkdirSync(path.join(root,"chats"),{recursive:true});
  write(path.join(root,"workspaces.json"),{workspaces:[{id:"p1",name:"PandaHRMS"},{id:"p2",name:"OctiqFlow"}]});
  const chats=[];
  const add = (id,projectId,title,events,extra={}) => {
    chats.push({id,projectId,title,modelId:"codex:test-stub",createdAt:1700000000000,updatedAt:1700000000000+chats.length*1000,...extra});
    fs.writeFileSync(path.join(root,"chats",`chat_${id}.jsonl`),events.map(encoded).join("\n")+"\n");
  };
  add("corpus-current","p1","Dashboard plan",[{type:"user",message:{content:"Build the dashboard"}}]);
  add("corpus-related","p1","Refresh token migration",[
    {type:"user",message:{content:"Rotate refresh tokens after every successful exchange."}},
    {type:"assistant",message:{content:[{type:"text",text:"登录页面的刷新策略"},{type:"tool_use",name:"Read",input:{file_path:"/spec",detail:"line one\n  line two"}}]}},
    {type:"user",message:{content:"Base directory for this skill: /skills/sql\nprivate body\nARGUMENTS: inspect DB"}},
    {type:"user",isSynthetic:true,origin:{kind:"peer",handback:true,senderTaskId:"a1",body:"[Subagent hand-back] Model output. The report follows:\nReview complete"},message:{content:"synthetic frame"}},
    {type:"user",message:{content:[{type:"tool_result",tool_use_id:"r",content:"canonical tool result"}]},tool_use_result:{stdout:"canonical tool result"}},
    {type:"message_end",message:{role:"assistant",content:[{type:"text",text:"Pi confirmed the session rotation."}]}},
    {type:"item.completed",item:{type:"agent_message",text:"Codex final reply"}},
    {type:"item.completed",item:{type:"command_execution",command:"git status",aggregated_output:"clean tree"}},
    {type:"system",subtype:"compact_boundary"},
    {type:"assistant",message:{content:[{type:"text",text:"long marker "+"word ".repeat(1300)}]}},
  ]);
  add("corpus-other","p2","Launch copy review",[{type:"user",message:{content:"Review launch copy before release."}}]);
  add("corpus-deleted","p1","Deleted refresh tokens",[{type:"user",message:{content:"refresh tokens"}}],{deletedAt:1700000005000});
  const n=Number(process.env.OCTIQ_CONVERSATION_CORPUS_CHATS || 2);
  const rows=Number(process.env.OCTIQ_CONVERSATION_CORPUS_ROWS || 20);
  const payload="synthetic archive filler for memory measurement ".repeat(22).trim();
  for (let i=0;i<n;i++) {
    const id=`corpus-fill-${i}`;
    chats.push({id,projectId:i%2 ? "p1":"p2",title:`Archive ${i}`,createdAt:1700000000000,updatedAt:1700000020000+i*1000});
    const fd=fs.openSync(path.join(root,"chats",`chat_${id}.jsonl`),"w");
    for (let j=0;j<rows;j++) fs.writeSync(fd,JSON.stringify({type:"assistant",message:{content:[{type:"text",text:payload}]}})+"\n");
    fs.closeSync(fd);
  }
  write(path.join(root,"chats/index.json"),{chats});
  console.log(JSON.stringify({generated:true,chats:chats.length,rows:n*rows}));
}
function mcp(script,profile) {
  const env={...process.env,OCTIQ_ROOT:profile,OCTIQ_CHAT_KEY:`chat:${process.env.OCTIQ_CONVERSATION_CURRENT || "corpus-current"}`,OCTIQ_SESSION_KEY:`chat:${process.env.OCTIQ_CONVERSATION_CURRENT || "corpus-current"}`,OCTIQ_FRONT_DESK:"",OCTIQ_ORCHESTRATION_ATTEMPT:"",OCTIQ_LAUNCH_ID:""};
  const child=spawn(process.execPath,[script],{env,stdio:["pipe","pipe","pipe"]});
  const pending=new Map(); let id=0; let stderr="";
  child.stderr.on("data",b=>stderr+=b);
  readline.createInterface({input:child.stdout}).on("line",line=>{const m=JSON.parse(line); pending.get(m.id)?.resolve(m.result);pending.delete(m.id);});
  child.on("exit",code=>{for(const p of pending.values())p.reject(Error(`MCP exited ${code}: ${stderr}`));});
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});child.stdin.write(JSON.stringify({jsonrpc:"2.0",id:n,method,params})+"\n");});
  return {child,rpc,call:async(name,args)=>{
    const r=await rpc("tools/call",{name,arguments:args});
    assert.ok(!r.isError,JSON.stringify(r)); return r.content[0].text;
  },rss:()=>Number(execFileSync("ps",["-o","rss=","-p",String(child.pid)],{encoding:"utf8"}).trim())*1024,
  close:()=>{child.stdin.end();child.kill();}};
}
async function verify() {
  const legacyScript=process.env.OCTIQ_CONVERSATION_LEGACY;
  if (!legacyScript) throw Error("OCTIQ_CONVERSATION_LEGACY must name an exported baseline MCP script");
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),"octiq-conversations-legacy-copy-"));
  // Only this test-generated corpus is copied; it contains no real chats.
  fs.cpSync(root,scratch,{recursive:true});
  const old=mcp(legacyScript,scratch), current=mcp(path.join(__dirname,"mcp/octiq-ask.cjs"),path.join(scratch,"unreadable-profile"));
  const measurements={fixture:"synthetic scratch corpus; no real profile",node:process.version,queries:0,reads:0};
  try {
    await old.rpc("initialize"); await current.rpc("initialize");
    measurements.beforeSearch={legacyRss:old.rss(),hostMcpRss:current.rss()};
    for(const args of [
      {query:"refresh tokens"},{query:"refresh tokens",project:"all"},{query:"refresh tokens",project:"p1",limit:1},
      {query:"登录页面",project:"pandahrms"},{query:"Pi confirmed"},{query:"Review complete"},
      {query:"dashboard",includeCurrent:true},{query:"launch copy",project:"OctiqFlow"},
      {query:"refres"},{query:"refresh refresh tokens"},{query:"long marker"},{query:"synthetic archive",project:"all",limit:20},
    ]) {
      const expected=JSON.parse(await old.call("search_conversations",args));
      const actual=JSON.parse(await current.call("search_conversations",args));
      assert.deepEqual(actual,expected,JSON.stringify(args)); measurements.queries++;
    }
    for(const args of [
      {id:"corpus-related",limit:3},{id:"corpus-related",before:4,limit:10},
      {url:"https://example.org/#/p/pandahrms/c/corpus-related",includeToolActivity:true,maxChars:4000},
      {id:"corpus-related",before:8,includeToolActivity:true,maxChars:4000},{id:"corpus-related",maxChars:4000},{id:"corpus-current",limit:0},
    ]) {
      assert.equal(await current.call("read_conversation",args),await old.call("read_conversation",args),JSON.stringify(args)); measurements.reads++;
    }
    measurements.afterSearch={legacyRss:old.rss(),hostMcpRss:current.rss()};
    measurements.legacyCacheBytes=fs.statSync(path.join(scratch,"chats/search-index.json")).size;
    measurements.legacyIndexRecreatedByHost=fs.existsSync(path.join(root,"chats/search-index.json"));
    assert.equal(measurements.legacyIndexRecreatedByHost,false);
    measurements.savedRssBytes=measurements.afterSearch.legacyRss-measurements.afterSearch.hostMcpRss;
    console.log(JSON.stringify(measurements,null,2));
    if(process.env.OCTIQ_CONVERSATION_MEASUREMENT) fs.writeFileSync(process.env.OCTIQ_CONVERSATION_MEASUREMENT,JSON.stringify(measurements,null,2)+"\n");
  } finally {old.close();current.close();fs.rmSync(scratch,{recursive:true,force:true});}
}
async function real() {
  const crypto=require("node:crypto");
  const canonical = value => encoded(value);
  const hash=value=>crypto.createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
  const corpus=process.env.OCTIQ_CONVERSATION_CORPUS;
  const legacyScript=process.env.OCTIQ_CONVERSATION_LEGACY;
  if(!corpus || !legacyScript || !path.basename(corpus).startsWith("octiq-record-storage-")) throw Error("Explicit scratch corpus and exported legacy MCP required");
  const original=path.join(corpus,"original");
  const index=JSON.parse(fs.readFileSync(path.join(original,"index.json"),"utf8"));
  const projects=JSON.parse(fs.readFileSync(path.join(corpus,"workspaces.json"),"utf8")).workspaces;
  const active=index.chats.filter(m=>!m.deletedAt);
  const project=projects.find(p=>/octiq/i.test(p.name)) || projects[0];
  const largest=active.map(m=>({id:m.id,projectExists:projects.some(p=>p.id===m.projectId),bytes:fs.existsSync(path.join(original,`chat_${m.id}.jsonl`)) ? fs.statSync(path.join(original,`chat_${m.id}.jsonl`)).size : 0})).sort((a,b)=>b.bytes-a.bytes);
  const readTargets=[...new Map([...largest.slice(0,3),...largest.filter(m=>m.projectExists).slice(0,3)].map(m=>[m.id,m])).values()];
  const old=mcp(legacyScript,path.join(corpus,"baseline")), current=mcp(path.join(__dirname,"mcp/octiq-ask.cjs"),path.join(corpus,"unreadable-profile"));
  const report={fixture:"read-only snapshot; original legacy MCP vs compacted host",node:process.version,corpusRecords:fs.readdirSync(original).filter(f=>/^chat_.*\.jsonl$/.test(f)).length,queries:[],reads:[],largest:largest.slice(0,3),readTargets};
  const differences=[];
  const compare=(kind,args,expected,actual)=>{
    const equal=hash(expected)===hash(actual);
    const item={args,equal,expectedHash:hash(expected),actualHash:hash(actual)};
    if(kind==="queries") {item.expectedCount=expected.count;item.actualCount=actual.count;}
    report[kind].push(item);
    if(!equal) { const filename=`difference-${kind}-${report[kind].length}.json`; write(path.join(corpus,filename),{args,expected,actual}); differences.push(filename); }
  };
  try {
    await old.rpc("initialize"); await current.rpc("initialize");
    report.beforeSearch={legacyRss:old.rss(),hostMcpRss:current.rss()};
    for(const args of [{query:"memory",project:"all"},{query:"profile",project:"all"},{query:"内存",project:"all"},{query:"人物",project:"all"},{query:"memory",project:project.id},{query:"profile",project:project.name},{query:"内存",project:project.name},{query:"memory"}]) {
      compare("queries",args,JSON.parse(await old.call("search_conversations",args)),JSON.parse(await current.call("search_conversations",args)));
    }
    report.afterSearch={legacyRss:old.rss(),hostMcpRss:current.rss()};
    for(const {id} of readTargets) for(const args of [{id,limit:40},{id,limit:40,before:41},{id,limit:20,includeToolActivity:true,maxChars:20000}]) {
      const read = async client => { const r=await client.rpc("tools/call",{name:"read_conversation",arguments:args}); return {isError:r.isError===true,text:r.content[0].text}; };
      const expected=await read(old), actual=await read(current);
      compare("reads",args,expected,actual);
      report.reads.at(-1).refused = expected.isError;
    }
    report.afterReads={legacyRss:old.rss(),hostMcpRss:current.rss()};
    report.legacyCacheBytes=fs.statSync(path.join(corpus,"baseline/chats/search-index.json")).size;
    report.savedRssBytes=report.afterSearch.legacyRss-report.afterSearch.hostMcpRss;
    report.differenceFiles=differences;
    report.complete=differences.length===0;
    if(process.env.OCTIQ_CONVERSATION_MEASUREMENT) write(process.env.OCTIQ_CONVERSATION_MEASUREMENT,report);
    console.log(JSON.stringify(report,null,2));
    if(differences.length) throw Error(`${differences.length} equivalence mismatches; private bodies stay only in scratch difference files`);
  } finally {old.close();current.close();}
}
(mode === "prepare" ? Promise.resolve(prepare()) : mode === "real" ? real() : verify()).catch(e=>{console.error(e.message);process.exitCode=1;});
