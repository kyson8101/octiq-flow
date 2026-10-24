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
function Page() {
 const [plans, setPlans] = useState(chatPlans(ledger, "chat:lead"));
 window.__approved = () => setPlans([]);
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
let enabled = location.search.includes("held");
window.__emit = setting => { enabled = setting.enabled; for (const fn of listeners.get("orchestration-auto-plan") || []) fn(setting); };
export const bridge = {
 on: (name, fn) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return () => listeners.get(name).delete(fn); },
 invoke: async (command, args) => {
  window.__calls.push({command, args});
  if (command === "chat_task") return {chatId: "lead"};
  if (command === "orchestration_auto_plan_get") return {chatKey: args.chatKey, enabled};
  if (command === "orchestration_plan_approve") {
   if (location.search.includes("reject")) throw new Error("The plan revision changed");
   window.__approved?.(); return {};
  }
  if (command === "orchestration_auto_plan_set") {
   await new Promise(resolve => setTimeout(resolve, 150));
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
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  const go = scene => page.goto(`http://127.0.0.1:${port}/__auto-plan?scene=${scene}`);
  console.log(`checking ${width}px`);
  await go("details");
  await page.getByRole("button",{name:"Task details",exact:true}).click();
  const toggle = page.getByRole("switch",{name:"Auto-approve plans"});
  await toggle.waitFor();
  assert.equal(await toggle.getAttribute("aria-checked"),"false");
  // A held key is dropped without issuing a request.
  await toggle.dispatchEvent("keydown",{key:"Enter",repeat:true});
  assert.equal(await page.evaluate(() => window.__calls.filter(c=>c.command.endsWith("_set")).length),0);
  await toggle.click(); assert.equal(await toggle.isDisabled(),true);
  await page.waitForFunction(()=>document.querySelector('[role="switch"]').getAttribute("aria-checked")==="true");
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
  report.checks.push({width,setting:true,bus:true,heldKey:true,eligibility:true,approvalOrder:true,saveFailureRetained:true,approvalFailure:true,held:true,recordOnce:true,wholeTitles:true,noMap:true,noOverflow:true});
  await page.close();
 }
 await writeFile(join(artifacts,"report.json"),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));
} finally { await browser?.close(); await server.close(); }
