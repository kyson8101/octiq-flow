// Real task panel with a synthetic ledger; never opens or changes live chats.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer, transformWithEsbuild } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const artifacts = await mkdtemp(join(tmpdir(), "octiq-sandbox-ui-"));
const env = { id: "octiq-sb-demo", chatKey: "chat:demo", enabled: true, locked: true, cwd: "/test",
  state: "ready", checkedAt: Date.now(), error: null, urls: { App: "http://127.0.0.1:49001/" },
  sourceRevision: "abcdef123", sourceDirty: false, fixtureVersion: "tomei-v1" };
const fixture = `
import React, {useState} from "react";
import {createRoot} from "react-dom/client";
import {WorkLocation} from "/src/components/WorkLocation.tsx";
import {SandboxSettings} from "/src/components/SandboxSettings.tsx";
import {SandboxStatus} from "/src/components/SandboxStatus.tsx";
import "/src/design-system.css";
import "/src/styles.css";
function Fixture() {
 const [selected, setSelected] = useState(false);
 const [busy, setBusy] = useState(false);
 return <main style={{maxWidth: 800, padding: 16}}>
  <WorkLocation projects={[]} projectId={null} onProject={()=>{}} branch="" onBranch={()=>{}}
    newWorktree={false} onNewWorktree={()=>{}} useSandbox={selected} onUseSandbox={setSelected}/>
  <p data-testid="choice">{selected ? "Sandbox selected" : "Sandbox off"}</p>
  <SandboxSettings/>
  <button onClick={()=>setBusy(v=>!v)}>Toggle active turn</button>
  <SandboxStatus environment={${JSON.stringify(env)}} running={busy} onRefresh={async()=>{}}/>
 </main>;
}
createRoot(document.getElementById("root")).render(<Fixture/>);
`;
const server = await createServer({
  root: fileURLToPath(new URL("../web", import.meta.url)),
  configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)),
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  plugins: [{
    name: "task-panel-fixture",
    resolveId(id) { if (id === "task-panel-fixture") return "\0task-panel-fixture.tsx"; },
    async load(id) {
      if (id === "\0task-panel-fixture.tsx") return (await transformWithEsbuild(fixture, "fixture.tsx", { loader: "tsx", jsx: "automatic" })).code;
    },
    configureServer(server) {
      server.middlewares.use("/__task-panel-test", async (_req, res, next) => {
        try {
          res.setHeader("Content-Type", "text/html");
          res.end(await server.transformIndexHtml("/__task-panel-test", '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"/></head><body><div id="root"></div><script type="module">import "task-panel-fixture"</script></body></html>'));
        } catch (error) { next(error); }
      });
    },
  }],
});
let browser;
const errors = [];
try {
 await server.listen();
 browser = await chromium.launch({headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined});
 for (const mobile of [false, true]) {
  const context = await browser.newContext({viewport: mobile ? {width:390,height:844} : {width:1280,height:900}});
  let enabled = false;
  const calls = [];
  await context.route("**/token", route=>route.fulfill({body:"mock-token"}));
  await context.routeWebSocket(/.*/, socket => socket.onMessage(raw=>{
   const r=JSON.parse(String(raw)); calls.push(r);
   if (r.cmd === "sandbox_configure") enabled=r.args.enabled;
   socket.send(JSON.stringify({t:"reply", id:r.id, ok:true, result: {defaultEnabled:enabled,environments:{}}}));
  }));
  const page=await context.newPage(); page.on("pageerror",error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__task-panel-test`);
  await page.getByRole("checkbox",{name:"Use sandbox",exact:true}).check();
  assert.equal(await page.getByTestId("choice").textContent(),"Sandbox selected");
  const toggle=page.getByRole("switch",{name:"Use sandbox for new chats"});
  await toggle.click();
  await page.waitForFunction(()=>document.querySelector('[role="switch"]').getAttribute("aria-checked")==="true");
  assert.equal(enabled,true);
  await page.locator(".sandbox-status summary").click();
  await page.getByRole("button",{name:"Reset database…"}).click();
  assert.equal(calls.filter(r=>r.cmd==="sandbox_action").length,0);
  await page.getByRole("button",{name:"Delete database and restore seed"}).click();
  await page.waitForFunction(()=>!document.querySelector('[aria-label="Confirm database reset"]'));
  const reset=calls.find(r=>r.cmd==="sandbox_action");
  assert.deepEqual(reset.args,{key:"chat:demo",action:"reset",confirmation:"octiq-sb-demo"});
  await page.getByRole("button",{name:"Toggle active turn"}).click();
  assert.equal(await page.getByRole("button",{name:"Stop services"}).isDisabled(),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),true);
  await page.screenshot({path:join(artifacts,mobile?"mobile.png":"desktop.png"),fullPage:true});
  await context.close();
 }
 assert.deepEqual(errors,[]);
 console.log("Sandbox controls passed on desktop and mobile. Artifacts:",artifacts);
} finally { await browser?.close(); await server.close(); }
