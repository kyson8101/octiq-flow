"use strict";
// The MCP is transport only. Every profile access is poisoned, including the
// retired legacy cache: a fallback or cache recreation must fail this test.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-conversation-transport-"));
  const preload = path.join(root, "poison.cjs");
  fs.writeFileSync(preload, `const fs = require('fs');
for (const name of ['readFileSync','readFile','writeFileSync','writeFile','createReadStream','createWriteStream','renameSync','rename','openSync','open','statSync','lstatSync','existsSync','readdirSync']) {
  const original = fs[name]; fs[name] = function (...args) {
    if (String(args[0]).includes('search-index.json') || String(args[0]).startsWith(process.env.OCTIQ_ROOT)) throw Error('MCP touched profile: ' + args[0]);
    return original.apply(this,args);
  };
}`);
  let calls = [];
  const server = http.createServer((req,res) => {
    let body = ""; req.on("data", b => body += b); req.on("end", () => {
      const call = JSON.parse(body); calls.push(call);
      assert.equal(req.url,"/hook/conversations"); assert.equal(req.headers["x-octiq-chat-capability"],"test-capability");
      res.setHeader("content-type","application/json");
      if (call.args.query === "refused") { res.writeHead(401); res.end(JSON.stringify({error:"Capability expired",outcome:{origin:"octiqflow",reasonClass:"scope-refused",severity:"error"}})); }
      else res.end(JSON.stringify({result:call.action === "search" ? JSON.stringify({query:call.args.query,count:0,matches:[]}) : "Conversation: test\nquoted historical data"}));
    });
  });
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  const child = spawn(process.execPath,["--require",preload,path.join(__dirname,"octiq-ask.cjs")],{env:{...process.env,OCTIQ_CHAT_KEY:"chat:current",OCTIQ_SESSION_KEY:"room:seat",OCTIQ_FRONT_DESK:"",OCTIQ_ORCHESTRATION_ATTEMPT:"test-worker",OCTIQ_ROOT:path.join(root,"profile"),OCTIQ_HOOK_PORT:String(server.address().port),OCTIQ_CHAT_CAPABILITY:"test-capability"},stdio:["pipe","pipe","inherit"]});
  const pending = new Map(); let id = 0;
  readline.createInterface({input:child.stdout}).on("line",line => { const m=JSON.parse(line); pending.get(m.id)?.(m.result); pending.delete(m.id); });
  const rpc = (method,params={}) => new Promise(resolve => { const n=++id; pending.set(n,resolve); child.stdin.write(JSON.stringify({jsonrpc:"2.0",id:n,method,params})+"\n"); });
  try {
    const list = await rpc("tools/list");
    for (const t of list.tools) assert.ok((t.description || "").length <= 4096,t.name);
    for (const name of ["search_conversations","read_conversation"]) assert.ok(list.tools.some(t=>t.name===name));
    const search = await rpc("tools/call",{name:"search_conversations",arguments:{query:"tokens",project:"all",limit:3}});
    assert.equal(JSON.parse(search.content[0].text).query,"tokens");
    const read = await rpc("tools/call",{name:"read_conversation",arguments:{id:"related",before:5,includeToolActivity:true,maxChars:4000}});
    assert.match(read.content[0].text,/Conversation: test/);
    assert.deepEqual(calls.map(c=>c.action),["search","read"]);
    for (const c of calls) { assert.equal(c.chatKey,"chat:current"); assert.equal(c.sessionKey,"room:seat"); }
    assert.deepEqual(calls[1].args,{id:"related",before:5,includeToolActivity:true,maxChars:4000});
    const refusal=await rpc("tools/call",{name:"search_conversations",arguments:{query:"refused"}});
    assert.equal(refusal.isError,true); assert.equal(refusal._meta["octiq/outcome"].reasonClass,"scope-refused");
    assert.ok(!fs.existsSync(path.join(root,"profile")));
  } finally { child.stdin.end(); child.kill(); await new Promise(resolve=>server.close(resolve)); fs.rmSync(root,{recursive:true,force:true}); }
  console.log("Conversation MCP transport: passed (zero profile/index access, bounded descriptions, worker/seat claims and refusals)");
}
main().catch(e=>{console.error(e);process.exitCode=1;});
