// Real MessageList and CSS on a scratch Vite page; no backend connection.
// PLAYWRIGHT_MODULE and PLAYWRIGHT_CHANNEL select an installed browser.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const webRoot = resolve(process.env.OCTIQ_WEB_ROOT || fileURLToPath(new URL("../web", import.meta.url)));
const require = createRequire(join(webRoot, "package.json"));
const moduleUrl = (spec) => isAbsolute(spec) || spec.startsWith(".") ? pathToFileURL(resolve(spec)).href : spec;
const { createServer } = await import(moduleUrl(require.resolve("vite")));
const { chromium } = await import(moduleUrl(process.env.PLAYWRIGHT_MODULE || "playwright"));
const artifacts = process.env.OCTIQ_EVIDENCE_DIR || await mkdtemp(join(tmpdir(), "octiq-shell-run-"));
await mkdir(artifacts, { recursive: true });

const command = "printf '%s\\n' 'hello from the chat'\n" + "echo whole-command\n".repeat(30).replace(/\n$/, "");
const replyText = "Run the check in a new terminal.\n\n```bash\n" + command + "\n```";
const fixture = `
import React, { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MessageList } from "/src/components/MessageList.tsx";
import { ConfirmProvider } from "/src/components/Confirm.tsx";
import { TerminalRunContext } from "/src/components/RunCommand.tsx";
import { TerminalDrawer } from "/src/components/TerminalDrawer.tsx";
import { useTerminalStore } from "/src/lib/useTerminalStore.ts";
import { addTab } from "/src/lib/terminals.ts";
import { applyTheme, themeById } from "/src/lib/themeStore.ts";
window.setScheme = applyTheme;
window.inspectTheme = () => ({light: themeById("light"), style: document.documentElement.getAttribute("style"), bg: getComputedStyle(document.body).backgroundColor});
import "@fontsource-variable/inter";
import "/src/design-system.css";
import "/src/styles.css";
const folder = "/work/OctiqFlow/feature-shell-run";
const command = ${JSON.stringify(command)};
const reply = { id: "reply", role: "assistant", streaming: false, blocks: [{ kind: "text", text: ${JSON.stringify(replyText)} }] };
function Scene() {
  const [mode, setMode] = useState("main");
  const [open, setOpen] = useState(false);
  const tabs = useTerminalStore();
  const current = useRef(mode);
  current.current = mode;
  const project = { id: "project:chat", name: "OctiqFlow", primary_path: folder };
  const terminal = useMemo(() => mode === "main" ? { folder, run: command => {
    if (current.current !== "main") return;
    tabs.update(project.id, previous => addTab(previous, project.id, { name: "Run", onceCommand: command, cwd: folder }));
    setOpen(true);
  }} : null, [mode, tabs.update]);
  return <ConfirmProvider><main className="app" style={{ display: "flex", flexDirection: "column" }}>
    <nav style={{ display: "flex", gap: 8, padding: 12 }}>
      <button onClick={() => setOpen(true)}>Open terminal</button>
      {["main", "worker", "beside task", "subagent", "no project"].map(value => <button key={value} onClick={() => setMode(value)}>{value}</button>)}
    </nav>
    <TerminalRunContext.Provider value={terminal}><MessageList messages={[reply]} busy={false} /></TerminalRunContext.Provider>
    {open && <TerminalDrawer project={project} store={tabs.store} onTabsChange={tabs.update} onCommandsChanged={() => {}} onHide={() => setOpen(false)} />}
  </main></ConfirmProvider>;
}
createRoot(document.getElementById("root")).render(<Scene />);
`;
const server = await createServer({
  root: webRoot, configFile: join(webRoot, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  plugins: [{
    name: "shell-run-scratch",
    enforce: "pre",
    resolveId(id) {
      if (id === "/__shell-run.tsx") return id;
      if (id.endsWith("/lib/bridge") || id.endsWith("/lib/bridge.ts")) return "\0scratch-bridge";
    },
    load(id) {
      if (id === "/__shell-run.tsx") return fixture;
      if (id === "\0scratch-bridge") return "export const bridge = { invoke: async (command, args) => { (window.__calls ??= []).push({command,args}); return []; }, on: () => () => {}, onState: () => () => {} };";
    },
    configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url?.split("?")[0] !== "/__shell-run") return next();
        const html = await vite.transformIndexHtml("/__shell-run", '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__shell-run.tsx"></script></body></html>');
        res.setHeader("Content-Type", "text/html");
        res.end(html);
      });
    },
  }],
});
let browser;
const report = { artifacts, widths: [] };
try {
  await server.listen();
  const address = server.httpServer.address();
  assert.notEqual(address.port, 1421);
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  for (const width of [1280, 390]) for (const scheme of ["dark", "light"]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    page.setDefaultTimeout(120_000);
    const errors = [];
    page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
    await page.goto(`http://127.0.0.1:${address.port}/__shell-run`);
    await page.evaluate(scheme => window.setScheme(scheme), scheme);
    await page.waitForFunction(scheme => getComputedStyle(document.body).backgroundColor === (scheme === "light" ? "rgb(247, 247, 247)" : "rgb(16, 16, 16)"), scheme, {timeout:5000}).catch(async error => { console.error(await page.evaluate(() => window.inspectTheme())); throw error; });
    const run = page.locator(".code-run");
    await run.waitFor();
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.getByRole("button", {name: /paste/i}).count(), 0);
    assert.equal(await page.evaluate(() => (window.__calls || []).filter(call => call.command === "pty_spawn").length), 0);
    await run.scrollIntoViewIfNeeded();
    await page.screenshot({path: join(artifacts, `shell-run-${width}-${scheme}-reply.png`)});
    // Enter opens the question. A held key answers nothing; a fresh Enter
    // lands on Cancel. Neither opens a terminal.
    await run.focus();
    await page.keyboard.press("Enter");
    let dialog = page.getByRole("alertdialog", {name: "Run this command?"});
    await dialog.waitFor();
    assert.equal(await page.evaluate(() => document.activeElement.textContent), "Cancel");
    await page.evaluate(() => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", {key:"Enter", repeat:true, bubbles:true, cancelable:true})));
    assert.equal(await dialog.count(), 1);
    await page.keyboard.press("Enter");
    await dialog.waitFor({state:"detached"});
    assert.equal(await page.locator(".drawer").count(), 0);
    const guarded = await run.evaluate(async button => {
      const rect = button.getBoundingClientRect();
      const click = {bubbles:true,detail:1,clientX:rect.x+rect.width/2,clientY:rect.y+rect.height/2};
      button.dispatchEvent(new MouseEvent("click", click));
      await new Promise(requestAnimationFrame);
      document.querySelector(".ask-btn.is-primary").dispatchEvent(new MouseEvent("click", click));
      await new Promise(requestAnimationFrame);
      return !!document.querySelector(".ask");
    });
    assert.ok(guarded);
    dialog = page.getByRole("alertdialog");
    await dialog.waitFor();
    assert.equal(await dialog.locator(".ask-command").innerText(), command);
    assert.ok((await dialog.locator(".ask-body").innerText()).includes("Folder: feature-shell-run\n/work/OctiqFlow/feature-shell-run"));
    const bounds = await dialog.evaluate(element => {
      const box = element.getBoundingClientRect();
      const code = element.querySelector(".ask-command");
      return {left:box.left,right:box.right,bottom:box.bottom,top:box.top,scrolls:code.scrollHeight > code.clientHeight};
    });
    assert.ok(bounds.left >= 0 && bounds.right <= width && bounds.top >= 0 && bounds.bottom <= 844);
    assert.ok(bounds.scrolls);
    await page.screenshot({path: join(artifacts, `shell-run-${width}-${scheme}-confirm.png`)});
    await dialog.getByRole("button", {name:"Run", exact:true}).click();
    await page.locator(".drawer").waitFor();
    await page.waitForFunction(() => window.__calls.some(call => call.command === "pty_spawn"));
    const calls = await page.evaluate(() => window.__calls.filter(call => call.command === "pty_spawn"));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.cwd, "/work/OctiqFlow/feature-shell-run");
    assert.equal(calls[0].args.id, "term:project:chat:1");
    assert.equal(calls[0].args.startCmd, command);
    // A second confirmation creates a distinct tab, preserving the first.
    await run.click();
    await page.getByRole("alertdialog").getByRole("button", {name:"Run", exact:true}).click();
    await page.waitForFunction(() => window.__calls.filter(call => call.command === "pty_spawn").length === 2);
    const store = await page.evaluate(() => JSON.parse(localStorage.getItem("octiq.v2.terminals")));
    assert.equal(store["project:chat"].tabs.length, 3);
    assert.equal(store["project:chat"].active, "term:project:chat:2");
    assert.ok(store["project:chat"].tabs.every(tab => !tab.cmd && !tab.takeCommand));
    await page.getByTitle("Hide the terminal (every shell keeps running)").click();
    await page.getByRole("button", {name:"Open terminal",exact:true}).click();
    await page.waitForFunction(() => window.__calls.filter(call => call.command === "pty_spawn").length === 3);
    const restored = await page.evaluate(() => window.__calls.filter(call => call.command === "pty_spawn").at(-1).args);
    assert.equal(restored.startCmd, undefined);
    assert.equal(restored.cwd, "/work/OctiqFlow/feature-shell-run");
    await page.reload();
    await page.getByRole("button", {name:"Open terminal",exact:true}).click();
    await page.waitForFunction(() => window.__calls?.some(call => call.command === "pty_spawn"));
    assert.equal(await page.evaluate(() => window.__calls.find(call => call.command === "pty_spawn").args.startCmd), undefined);
    await page.getByTitle("Hide the terminal (every shell keeps running)").click();
    for (const mode of ["worker", "beside task", "subagent", "no project"]) {
      await page.getByRole("button", {name:mode,exact:true}).click();
      assert.equal(await run.count(), 0);
    }
    assert.deepEqual(errors, []);
    report.widths.push({width,scheme,bounds,spawn:calls[0],newTabs:2,keyboard:"pass",restrictedContexts:"pass",errors});
    await context.close();
  }
  await writeFile(join(artifacts, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
