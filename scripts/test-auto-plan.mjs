// Scratch page with real React views, reducer and host ledger fixtures.
// No live backend, paid calls, profile writes or lasting service.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserPaths } from "./browser-paths.mjs";
const { webRoot, require, moduleUrl } = browserPaths(import.meta.url);
const { createServer } = await import(moduleUrl(require.resolve("vite")));
const { chromium } = await import(moduleUrl(process.env.PLAYWRIGHT_MODULE || "playwright"));
const artifacts = process.env.OCTIQ_EVIDENCE_DIR || await mkdtemp(join(tmpdir(), "octiq-auto-plan-"));
const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatTaskBar } from "/src/components/ChatTaskBar.tsx";
import { ChatPlanCards } from "/src/components/ChatPlanCards.tsx";
import { MessageList } from "/src/components/MessageList.tsx";
import { chatPlans } from "/src/lib/chatPlans.ts";
import { emptyChat, reduceChat } from "/src/lib/chat.ts";
import { useAutoPlan, setAutoPlan } from "/src/lib/autoPlan.ts";
import held from "/src/lib/__fixtures__/host/auto_plan_held_access.json";
import "@fontsource-variable/inter";
import "/src/design-system.css";
import "/src/styles.css";
const scene = new URLSearchParams(location.search).get("scene") || "details";
const ledger = structuredClone(held);
// Component scene changes a copy: setting off, lead identity matching Details.
ledger.runs[0].coordinatorChatKey = "chat:lead";
if (scene !== "held") delete ledger.runs[0].autoPlan;
const event = { type: "octiq_plan_auto_approved", runId: "run-record", revision: 8,
  taskIds: ["a", "b", "c"], taskTitles: ["A complete task title", "Second full title", "Third complete title"], at: 500, enabledAt: 100 };
const state = reduceChat(reduceChat(emptyChat(), event), event);
function Read({chatKey, connected}) {
 const value = useAutoPlan(chatKey, connected);
 return <output>{JSON.stringify(value)}</output>;
}
function Reads() {
 const [key, setKey] = useState("chat:reads"), [connected, setConnected] = useState(true);
 window.__key = setKey; window.__connect = setConnected; window.__set = setAutoPlan;
 return <><Read chatKey={key} connected={connected}/><Read chatKey={key} connected={connected}/></>;
}
function Page() {
 const [plans, setPlans] = useState(chatPlans(ledger, "chat:lead"));
 window.__approved = () => setPlans([]);
 if (scene === "reads") return <Reads/>;
 return <main style={{maxWidth: 850, margin: "12px auto", padding: 12}}>
  <ChatTaskBar action chatId="lead" connected context={{canLead: !["worker", "desk", "seat"].includes(scene)}} />
  {["card", "held", "fail", "reject"].includes(scene) && <ChatPlanCards chatKey="chat:lead" plans={plans} drafting={false} />}
  <MessageList messages={state.messages} busy={false} conversationId="auto-plan-scratch" />
 </main>;
}
createRoot(document.getElementById("root")).render(<Page />);
`;
const bridge = `
const listeners = new Map();
window.__calls = [];
window.__gets = [];
let enabled = location.search.includes("held");
window.__emit = setting => { enabled = setting.enabled; for (const fn of listeners.get("orchestration-auto-plan") || []) fn(setting); };
export const bridge = {
 on: (name, fn) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return () => listeners.get(name).delete(fn); },
 invoke: async (command, args) => {
  window.__calls.push({command, args});
  if (command === "chat_task") return {chatId: "lead"};
  if (command === "orchestration_auto_plan_get") {
   if (location.search.includes("reads")) return new Promise((resolve,reject) => window.__gets.push({resolve,reject}));
   return {chatKey: args.chatKey, enabled};
  }
  if (command === "orchestration_plan_approve") {
   if (location.search.includes("reject")) throw new Error("The plan revision changed");
   window.__approved?.(); return {};
  }
  if (command === "orchestration_auto_plan_set") {
   if (window.__holdSave) await new Promise(resolve => { window.__releaseSave = resolve; });
   if (window.__failSave || location.search.includes("fail")) throw new Error("Scratch save refused");
   const setting = {chatKey: args.chatKey, enabled: args.enabled, enabledAt: 100}; window.__emit(setting); return setting;
  }
  return [];
 }
};`;
const server = await createServer({ root: webRoot, configFile: join(webRoot, "vite.config.ts"),
 server: {host:"127.0.0.1", port:0}, plugins:[{name:"auto-plan-scratch", enforce:"pre",
 resolveId(id, importer) { if(id === "/__auto-plan.tsx") return id; if(id.endsWith("/lib/bridge") || id.endsWith("/lib/bridge.ts") || (id === "./bridge" && importer?.includes("/src/lib/"))) return "\0scratch-auto-bridge"; },
 load(id) { if(id === "/__auto-plan.tsx") return fixture; if(id === "\0scratch-auto-bridge") return bridge; },
 configureServer(vite) { vite.middlewares.use(async(req,res,next) => {
  if(req.url?.split("?")[0] !== "/__auto-plan") return next();
  const html = await vite.transformIndexHtml("/__auto-plan", '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__auto-plan.tsx"></script></body></html>');
  res.setHeader("Content-Type","text/html"); res.end(html);
 }); }
 }]});
let browser;
const report = { artifacts, checks: [] };
try {
 await server.listen();
 const {port} = server.httpServer.address();
 browser = await chromium.launch({headless:true, ...(process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {})});
 for (const width of [1280, 390]) {
  const page = await browser.newPage({viewport:{width,height:950}, reducedMotion:"reduce"});
  page.setDefaultNavigationTimeout(120_000);
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  const go = scene => page.goto(`http://127.0.0.1:${port}/__auto-plan?scene=${scene}`);
  console.log(`checking ${width}px`);
  // Details must remember its opener even if the next control has no guard.
  await go("details");
  await page.getByRole("button",{name:"Task details",exact:true}).waitFor();
  assert.equal(await page.evaluate(() => {
   const probe = document.createElement("button"); document.body.append(probe);
   let landed = false; probe.onclick = () => { landed = true; };
   const press = () => new MouseEvent("click", {bubbles:true,cancelable:true,detail:1,clientX:78,clientY:78});
   document.querySelector('[aria-label="Task details"]').dispatchEvent(press());
   probe.dispatchEvent(press()); probe.remove();
   return landed;
  }), false);
  await go("details");
  await page.getByRole("button",{name:"Task details",exact:true}).click();
  const toggle = page.getByRole("switch",{name:"Auto-approve plans"});
  await toggle.waitFor();
  assert.equal(await toggle.getAttribute("aria-checked"),"false");
  // Ordinary foreign controls do not notePress: these exercise repeatsAnother
  // itself, rather than relying on the disclosure's document-level guard.
  assert.deepEqual(await page.evaluate(() => {
   const other = document.createElement("button"); document.body.append(other);
   const press = () => new MouseEvent("click", {bubbles:true,cancelable:true,detail:1,clientX:171,clientY:151});
   other.dispatchEvent(press());
   const control = document.querySelector('[role="switch"]');
   const dropped = [control.dispatchEvent(press()), control.dispatchEvent(press())];
   other.remove(); return dropped;
  }), [false,false]);
  assert.equal(await page.evaluate(() => window.__calls.filter(c=>c.command.endsWith("_set")).length),0);
  // A held key is dropped without issuing a request.
  await toggle.dispatchEvent("keydown",{key:"Enter",repeat:true});
  assert.equal(await page.evaluate(() => window.__calls.filter(c=>c.command.endsWith("_set")).length),0);
  await page.evaluate(()=>window.__holdSave=true);
  await toggle.focus(); await page.keyboard.press("Enter");
  await page.waitForFunction(()=>document.querySelector('[role="switch"]').getAttribute("aria-disabled")==="true");
  assert.equal(await toggle.evaluate(el=>document.activeElement===el && !el.disabled),true);
  // Keyboard and synthetic clicks cannot send another save while held.
  await page.keyboard.press("Enter");
  await toggle.dispatchEvent("click",{detail:0});
  assert.equal(await page.evaluate(() => window.__calls.filter(c=>c.command.endsWith("_set")).length),1);
  await page.evaluate(()=>{window.__holdSave=false; window.__releaseSave();});
  await page.waitForFunction(()=>document.querySelector('[role="switch"]').getAttribute("aria-checked")==="true");
  assert.equal(await toggle.evaluate(el=>document.activeElement===el),true);
  await page.evaluate(()=>window.__emit({chatKey:"chat:lead", enabled:false}));
  assert.equal(await toggle.getAttribute("aria-checked"),"false");
  await page.evaluate(()=>window.__failSave=true);
  await toggle.click(); await page.getByRole("alert").filter({hasText:"Scratch save refused"}).waitFor();
  await page.screenshot({path:join(artifacts,`details-${width}.png`)});
  for(const scene of ["worker","desk","seat"]) {
   await go(scene); await page.getByRole("button",{name:"Task details",exact:true}).click();
   assert.equal(await page.getByRole("switch").count(),0);
  }
  for(const scene of ["card","fail","reject"]) {
   await go(scene);
   await page.getByRole("checkbox",{name:"Auto-approve this chat's future plans"}).check();
   await page.getByRole("button",{name:"Approve plan",exact:true}).click();
   await page.waitForFunction(()=>window.__calls.some(c=>c.command==="orchestration_plan_approve"));
   if(scene === "reject") {
    await page.getByRole("alert").filter({hasText:"The plan revision changed"}).waitFor();
    assert.equal(await page.evaluate(()=>window.__calls.some(c=>c.command==="orchestration_auto_plan_set")),false);
   } else {
    await page.waitForFunction(()=>window.__calls.some(c=>c.command==="orchestration_auto_plan_set"));
    const order = await page.evaluate(()=>window.__calls.map(c=>c.command).filter(c=>["orchestration_plan_approve","orchestration_auto_plan_set"].includes(c)));
    assert.deepEqual(order,["orchestration_plan_approve","orchestration_auto_plan_set"]);
    assert.equal(await page.getByRole("button",{name:"Approve plan",exact:true}).count(),0);
    if(scene === "fail") await page.getByRole("alert").filter({hasText:"Could not save auto-approval: Scratch save refused"}).waitFor();
   }
  }
  // Reject both direct input and label-text repeats before React changes its
  // controlled draft. A later manual approval must not persist that press.
  for (const target of ["input", "span"]) {
   await go("card");
   const checkbox = page.getByRole("checkbox",{name:"Auto-approve this chat's future plans"});
   await checkbox.waitFor();
   assert.deepEqual(await page.evaluate(target => {
    const other = document.createElement("button"); document.body.append(other);
    const press = () => new MouseEvent("click", {bubbles:true,cancelable:true,detail:1,clientX:171,clientY:151});
    other.dispatchEvent(press());
    const control = document.querySelector('.auto-plan-future ' + target);
    const dropped = [control.dispatchEvent(press()), control.dispatchEvent(press())];
    other.remove(); return dropped;
   }, target), [false,false]);
   assert.equal(await checkbox.isChecked(),false);
   await page.getByRole("button",{name:"Approve plan",exact:true}).press("Enter");
   await page.waitForFunction(()=>!document.querySelector('.auto-plan-future'));
   assert.equal(await page.evaluate(()=>window.__calls.some(c=>c.command.endsWith("_set"))),false);
  }
  // Fresh label activation and keyboard choices still work.
  await go("card");
  const future = page.getByRole("checkbox",{name:"Auto-approve this chat's future plans"});
  await page.locator('.auto-plan-future span').click();
  assert.equal(await future.isChecked(),true);
  await page.locator('.auto-plan-future span').click();
  assert.equal(await future.isChecked(),false);
  await future.press("Space"); assert.equal(await future.isChecked(),true);
  await future.dispatchEvent("keydown",{key:" ",repeat:true}); assert.equal(await future.isChecked(),true);
  // Two real hook consumers share the setting. A read error cannot supersede
  // another successful read, but a host event or explicit change can.
  await go("reads");
  await page.waitForFunction(()=>window.__gets.length===2);
  await page.evaluate(()=>window.__gets[0].reject(new Error("first read failed")));
  await page.waitForFunction(()=>[...document.querySelectorAll("output")].every(el=>el.textContent.includes("first read failed")));
  await page.evaluate(()=>window.__gets[1].resolve({chatKey:"chat:reads",enabled:true}));
  const expectSetting = async (key, enabled) => {
   await page.waitForFunction(({key,enabled})=>[...document.querySelectorAll("output")].every(el=>{
    const value=JSON.parse(el.textContent); return value.setting?.chatKey===key && value.setting.enabled===enabled && !value.error;
   }), {key,enabled});
  };
  await expectSetting("chat:reads",true);
  await page.evaluate(()=>window.__key("chat:late-error"));
  await page.waitForFunction(()=>window.__gets.length===4);
  await page.evaluate(()=>window.__gets[2].resolve({chatKey:"chat:late-error",enabled:false}));
  await expectSetting("chat:late-error",false);
  await page.evaluate(()=>window.__gets[3].reject(new Error("late read failed")));
  await expectSetting("chat:late-error",false);
  await page.evaluate(()=>window.__key("chat:event"));
  await page.waitForFunction(()=>window.__gets.length===6);
  await page.evaluate(()=>{window.__emit({chatKey:"chat:event",enabled:true}); window.__gets[4].resolve({chatKey:"chat:event",enabled:false}); window.__gets[5].reject(new Error("old read failed"));});
  await expectSetting("chat:event",true);
  await page.evaluate(()=>window.__key("chat:press"));
  await page.waitForFunction(()=>window.__gets.length===8);
  await page.evaluate(()=>window.__set("chat:press",true));
  await page.evaluate(()=>{window.__gets[6].resolve({chatKey:"chat:press",enabled:false}); window.__gets[7].reject(new Error("old read failed"));});
  await expectSetting("chat:press",true);
  await page.evaluate(()=>window.__connect(false));
  await page.evaluate(()=>window.__connect(true));
  await page.waitForFunction(()=>window.__gets.length===10);
  await page.evaluate(()=>{window.__gets[8].resolve({chatKey:"chat:press",enabled:false}); window.__gets[9].resolve({chatKey:"chat:press",enabled:false});});
  await expectSetting("chat:press",false);
  await go("held");
  await page.getByText("Not auto-approved: 1 task runs at Full access",{exact:true}).waitFor();
  assert.equal(await page.getByRole("checkbox").count(),0);
  assert.equal(await page.getByText("Plan auto-approved · revision 8 · 3 tasks",{exact:true}).count(),1);
  assert.equal(await page.getByText("A complete task title",{exact:true}).count(),0);
  await page.getByRole("button",{name:"Show the task titles",exact:true}).click();
  await page.getByText("A complete task title",{exact:true}).waitFor();
  assert.equal(await page.locator(".conversation-map-point").count(),0);
  assert.equal(await page.locator(".auto-plan-approved .msg-actions").count(),0);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:join(artifacts,`card-${width}.png`)});
  assert.deepEqual(errors,[]);
  report.checks.push({width,setting:true,bus:true,heldKey:true,eligibility:true,approvalOrder:true,saveFailureRetained:true,approvalFailure:true,held:true,recordOnce:true,wholeTitles:true,noMap:true,noOverflow:true,
   detailsOpener:true,switchForeignRepeat:true,checkboxForeignRepeat:true,labelForeignRepeat:true,repeatNeverPersists:true,labelActivation:true,checkboxKeyboard:true,focusDuringSave:true,focusAfterSave:true,busyGuard:true,
   siblingReadRecovery:true,lateReadError:true,newerEvent:true,newerChange:true,reconnect:true});
  await page.close();
 }
 await writeFile(join(artifacts,"report.json"),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));
} finally { await browser?.close(); await server.close(); }
