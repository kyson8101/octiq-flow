// Real queue controls and composer, with deterministic transport responses.
// No agent process is started. Screenshots are written to an isolated temp dir.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.OCTIQOS_PLAYWRIGHT_MODULE ?? "@playwright/test");
const artifacts = await mkdtemp(join(tmpdir(), "octiq-message-queue-"));
const fixture = `
import React, {useRef, useState} from "react";
import { createRoot } from "react-dom/client";
import { MessageList } from "/src/components/MessageList.tsx";
import { Composer } from "/src/components/Composer.tsx";
import { MODELS } from "/src/lib/agentProviders.ts";
import { emptyChat, reduceChat } from "/src/lib/chat.ts";
import { MessageQueueActions, reclaimedMessage } from "/src/lib/messageQueue.ts";
import "lxgw-wenkai-screen-webfont/lxgwwenkaiscreen.css";
import "/src/styles.css";
const initial = {...emptyChat(), busy:true, messages:[
 {id:"active",turnId:"active",role:"user",streaming:false,takenUp:true,blocks:[{kind:"text",text:"Please review the message queue."}]},
 {id:"a",role:"assistant",streaming:false,blocks:[{kind:"text",text:"I’m checking how new messages are delivered while another reply is running."}]},
 {id:"u1",turnId:"u1",role:"user",streaming:false,delivery:"queued",blocks:[{kind:"text",text:"I will save for you"}]},
 {id:"u2",turnId:"u2",role:"user",streaming:false,delivery:"queued",blocks:[{kind:"text",text:"Check this screenshot too. 保留我已经输入的草稿。"}],attachments:[{path:"/tmp/queue-test.png",name:"queue-test.png",isImage:true}]}
]};
function Fixture() {
 const [state,setState] = useState(initial);
 const held=useRef(state); held.current=state;
 const [restored,setRestored]=useState([]);
 const actions=useRef(new MessageQueueActions());
 const patch=fn=>{held.current=fn(held.current); setState(held.current);};
 window.delivery=(id,status)=>patch(s=>reduceChat(s,{type:"octiq_user_turn_delivery",uuid:id,state:status}));
 window.snapshot=()=>held.current;
 window.calls ??= [];
 const act=(turnId,action)=>actions.current.run({chatId:"test",turnId,action,read:()=>held.current,patch,
   invoke:command=>{window.calls.push({command,turnId}); return new Promise(resolve=>{window.finish=resolve;});},
   refresh:async()=>{if(held.current.messages.find(m=>m.turnId===turnId)?.delivery==="queued") patch(s=>({...s,messages:s.messages.map(m=>m.turnId===turnId?{...m,delivery:"unknown"}:m)}));},
   reclaim:m=>setRestored([reclaimedMessage(m)])});
 return React.createElement("main",{style:{maxWidth:900,margin:"24px auto",padding:"0 16px"}},
  React.createElement(MessageList,{messages:state.messages,busy:state.busy,hostName:"Codex",onStartQueued:id=>act(id,"start"),onCancelQueued:id=>act(id,"cancel")}),
  React.createElement(Composer,{session:"queue-fixture",choice:MODELS.find(m=>m.agent==="codex"),onChoice:()=>{},access:"auto",onAccess:()=>{},onSend:()=>{},onStop:()=>{},busy:false,effort:"medium",onEffort:()=>{},lite:false,onLite:()=>{},putBack:restored,onPutBack:()=>setRestored([])})
 );
}
createRoot(document.getElementById("root")).render(React.createElement(Fixture));
`;
const server = await createServer({
  root: fileURLToPath(new URL("../web", import.meta.url)),
  configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)),
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  plugins: [{ name: "chat-preview-test-fixture",
    resolveId(id) { if (id === "chat-preview-test-fixture") return "\0chat-preview-test-fixture"; },
    load(id) { if (id === "\0chat-preview-test-fixture") return fixture; },
    configureServer(server) {
      server.middlewares.use("/__chat-preview-test", async (_req, res, next) => {
        try {
          res.setHeader("Content-Type", "text/html");
          res.end(await server.transformIndexHtml("/__chat-preview-test", '<html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="overflow:auto"><div id="root"></div><script type="module">import "chat-preview-test-fixture"</script></body></html>'));
        } catch (error) { next(error); }
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, channel: process.env.OCTIQOS_CHROME_EXECUTABLE ? undefined : "chrome", executablePath: process.env.OCTIQOS_CHROME_EXECUTABLE });
  for (const width of [1280, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, isMobile: width < 700, hasTouch: width < 700, reducedMotion: "reduce" });
    const errors=[]; page.on("pageerror", error=>errors.push(String(error)));
    await page.route(/\/file(?:\?|$)/, r=>r.fulfill({contentType:"image/png",body:Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jmWQAAAAASUVORK5CYII=","base64")}));
    await page.route("**/token", r=>r.fulfill({body:"mock"}));
    await page.routeWebSocket(/.*/, ws=>ws.onMessage(raw=>{
      const data=JSON.parse(String(raw));
      if(data.t==="invoke") ws.send(JSON.stringify({t:"reply",id:data.id,ok:true,result:[]}));
    }));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__chat-preview-test`);
    const start=page.getByRole("button",{name:"Send this queued message now",exact:true});
    const edit=page.getByRole("button",{name:"Take this queued message back to edit",exact:true});
    await start.first().waitFor();
    await page.evaluate(()=>document.fonts.ready);
    assert.equal(await start.count(),2);
    assert.equal(await edit.count(),2);
    await page.screenshot({path:join(artifacts,`queue-${width}.png`),fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    for (const button of await start.all()) assert.ok((await button.boundingBox()).height>=44);
    await start.first().click();
    assert.equal(await start.first().isDisabled(),true);
    assert.equal(await edit.first().isDisabled(),true);
    await page.evaluate(()=>{window.delivery("u1","dispatched");window.finish(true);});
    await page.getByText("Sent to agent",{exact:true}).waitFor();
    assert.equal(await start.count(),1);
    assert.deepEqual(await page.evaluate(()=>window.calls),[{command:"chat_start_queued",turnId:"u1"}]);
    await page.locator("textarea").fill("My existing draft");
    await edit.click();
    await page.evaluate(()=>window.finish(true));
    await page.waitForFunction(()=>document.querySelector("textarea").value.includes("Check this screenshot too"));
    assert.equal(await page.locator("textarea").inputValue(),"My existing draft\n\nCheck this screenshot too. 保留我已经输入的草稿。");
    assert.equal(await page.locator(".composer").getByText("queue-test.png",{exact:true}).count(),1);
    assert.equal(await start.count(),0);
    assert.equal(await edit.count(),0);
    assert.equal(await page.locator(".notice").count(),0);
    assert.deepEqual(errors,[]);
    await page.screenshot({path:join(artifacts,`edited-${width}.png`),fullPage:true});
    await page.close();
  }
  // Exercise the real App send/cancel/start wiring and replay through mocked RPCs.
  const page = await browser.newPage({viewport:{width:1280,height:900}});
  const appErrors=[]; page.on("pageerror", e=>appErrors.push(String(e)));
  const key="chat:queue-chat";
  const project={id:"qp",name:"Queue Project",primary_path:"/test/queue"};
  const conversation={id:"queue-chat",projectId:"qp",title:"Queue regression",modelId:"codex:astra",sessionId:"test-thread",access:"auto",createdAt:1,updatedAt:2,pinned:false};
  const events=[]; const waiting=new Set(); const calls=[];
  const record=event=>{const frame={seq:events.length+1,event}; events.push(frame); return frame;};
  record({type:"user",uuid:"active",octiq_user_turn:true,message:{content:[{type:"text",text:"Review the queue"}]}});
  record({type:"octiq_user_turn_delivery",uuid:"active",state:"dispatched"});
  record({type:"turn.started",octiq_user_turn_id:"active"});
  await page.route("**/token", r=>r.fulfill({body:"mock"}));
  await page.route("**/auth**", r=>r.fulfill({body:"ok"}));
  await page.routeWebSocket(/.*/, ws=>ws.onMessage(raw=>{
    const data=JSON.parse(String(raw)); if(data.t!=="invoke") return;
    calls.push(data); let result=[];
    const emit=event=>ws.send(JSON.stringify({t:"event",event:"chat-event",payload:{key,...record(event)}}));
    if(data.cmd==="list_workspaces") result=[project];
    if(data.cmd==="chat_index_list") result=[conversation];
    if(data.cmd==="chat_list") result=[key];
    if(data.cmd==="chat_page") result={events,context:[],before:null};
    if(data.cmd==="chat_since") result=events.filter(frame=>frame.seq>(data.args.after??0));
    if(data.cmd==="chat_queue_state") result={live:true,queuedTurnIds:[...waiting]};
    if(data.cmd==="git_status") result={branch:"test",files:[]};
    if(data.cmd==="chat_send") {
      waiting.add(data.args.turnId);
      emit({type:"user",uuid:data.args.turnId,octiq_user_turn:true,message:{content:[{type:"text",text:data.args.text}]}});
      emit({type:"octiq_user_turn_delivery",uuid:data.args.turnId,state:"queued"});
      result=null;
    }
    if(data.cmd==="chat_cancel_queued") {
      result=waiting.delete(data.args.turnId);
      if(result) emit({type:"octiq_user_turn_cancelled",uuid:data.args.turnId});
    }
    if(data.cmd==="chat_start_queued") {
      result=waiting.delete(data.args.turnId);
      if(result) emit({type:"octiq_user_turn_delivery",uuid:data.args.turnId,state:"dispatched"});
    }
    ws.send(JSON.stringify({t:"reply",id:data.id,ok:true,result}));
  }));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/#/p/queue-project/c/queue-chat`);
  const app=page.frameLocator('iframe[title="Left chat workspace"]');
  const input=app.locator("textarea");
  await input.waitFor();
  for(const text of ["First rapid follow-up","Second rapid follow-up"]) {
    await input.fill(text); await input.press("Enter");
  }
  const edit=app.getByRole("button",{name:"Take this queued message back to edit",exact:true});
  await edit.nth(1).waitFor();
  assert.equal(calls.filter(c=>c.cmd==="chat_send").length,2);
  await input.fill("Keep my newer draft");
  await edit.first().click();
  await page.waitForFunction(()=>document.querySelector("iframe").contentDocument.querySelector("textarea").value.includes("First rapid follow-up"));
  assert.equal(await input.inputValue(),"Keep my newer draft\n\nFirst rapid follow-up");
  const start=app.getByRole("button",{name:"Send this queued message now",exact:true});
  assert.equal(await start.count(),1);
  await start.click();
  await app.getByText("Sent to agent",{exact:true}).waitFor();
  const sent=calls.filter(c=>c.cmd==="chat_send");
  assert.equal(calls.find(c=>c.cmd==="chat_cancel_queued").args.turnId,sent[0].args.turnId);
  assert.equal(calls.find(c=>c.cmd==="chat_start_queued").args.turnId,sent[1].args.turnId);
  assert.equal(await app.locator(".notice").count(),0);
  await page.reload();
  await app.getByText("Second rapid follow-up",{exact:true}).waitFor();
  assert.equal(await start.count(),0);
  assert.equal(await app.getByText("First rapid follow-up",{exact:true}).count(),0);
  assert.deepEqual(appErrors,[]);
  await page.screenshot({path:join(artifacts,"app-queue.png"),fullPage:true});
  await page.close();
  console.log(`Queue interactions passed at desktop, 390px, and 320px; real App rapid send, Edit, Send now, and reload passed. Screenshots: ${artifacts}`);
} finally { await browser?.close(); await server.close(); }
