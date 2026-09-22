// Exercise the real sidebar and live orchestration subscription against an isolated backend.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer, transformWithEsbuild } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const artifacts = await mkdtemp(join(tmpdir(), "octiq-nested-chats-"));
const fixture = `
import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Sidebar } from "/src/components/Sidebar.tsx";
import { OrchestrationButton } from "/src/components/OrchestrationPanel.tsx";
import { useOrchestrationSnapshot } from "/src/lib/useOrchestrationSnapshot.ts";
import { workerChatParents } from "/src/lib/orchestration.ts";
import { byTask } from "/src/lib/store.ts";
import "/src/design-system.css";
import "/src/styles.css";
const chats = [
  { id: "master", title: "Ship the orchestrator", updatedAt: 2 },
  { id: "build", title: "Worker: Implement chat grouping", updatedAt: 5 },
  { id: "test", title: "Worker: Verify the sidebar", updatedAt: 4 },
  { id: "other", title: "Plan the next release", updatedAt: 3 },
].map(c => ({ ...c, projectId: "project", messages: [], createdAt: 1, readAt: c.id === "build" ? 1 : 5,
  modelId: "codex:sol", latestResponse: "Ready to continue the task." }));
const searchChats = async () => [{ id: "build", speaker: "Assistant", role: "assistant", excerpt: "Grouping is ready." }];
window.picks = [];
function App() {
  const snapshot = useOrchestrationSnapshot();
  const chatParents = useMemo(() => workerChatParents(snapshot), [snapshot]);
  const [current, setCurrent] = useState("master");
  const [conversations, setChats] = useState(chats);
  window.selectChat = setCurrent;
  window.removeMaster = () => setChats(v => v.filter(c => c.id !== "master"));
  window.restoreMaster = () => setChats(chats);
  return <div className="app projects-screen" style={{display: "flex", height: "100vh"}}>
    <Sidebar projects={[{id: "project", name: "OctiqFlow"}]} shelved={[]} onShowShelved={() => {}}
      conversations={byTask(conversations)} chatParents={chatParents} currentConversation={current}
      running={new Set(["build"])} busy={new Set(["build"])}
      onPickConversation={c => { window.picks.push(c.id); setCurrent(c.id); }} onNewChat={() => {}}
      onDelete={() => {}} onPin={id => setChats(v => v.map(c => c.id === id ? {...c, pinned: !c.pinned} : c))}
      onRename={(id, title) => setChats(v => v.map(c => c.id === id ? {...c, title} : c))}
      onNewProject={() => {}} searchChats={searchChats} />
    <main style={{padding: 32}}><OrchestrationButton open={false} onToggle={() => {}} snapshot={snapshot}/></main>
  </div>;
}
createRoot(document.getElementById("root")).render(<App/>);
`;
const server = await createServer({
  root: fileURLToPath(new URL("../web", import.meta.url)),
  configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)),
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  plugins: [{
    name: "nested-agent-chat-fixture",
    resolveId(id) { if (id === "nested-agent-chat-fixture") return "\0nested-agent-chat-fixture.tsx"; },
    async load(id) {
      if (id === "\0nested-agent-chat-fixture.tsx") {
        return (await transformWithEsbuild(fixture, "fixture.tsx", { loader: "tsx", jsx: "automatic" })).code;
      }
    },
    configureServer(server) {
      server.middlewares.use("/__nested-chat-test", async (_req, res, next) => {
        try {
          res.setHeader("Content-Type", "text/html");
          res.end(await server.transformIndexHtml("/__nested-chat-test", '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"/></head><body><div id="root"></div><script type="module">import "nested-agent-chat-fixture"</script></body></html>'));
        } catch (error) { next(error); }
      });
    },
  }],
});
const empty = { runs: [], tasks: [], attempts: [], gates: [], messages: [] };
const ledger = {
  ...empty,
  runs: [{ id: "run", coordinatorChatKey: "chat:master", status: "running" }],
  attempts: ["build", "test"].map(id => ({ id, runId: "run", workerChatKey: `chat:${id}`, status: "running" })),
};
let snapshot = ledger;
let socket;
let failReads = false;
const calls = [];
const errors = [];
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("**/token", route => route.fulfill({ body: "mock-token" }));
  await context.route("**/auth", route => route.fulfill({ body: "ok" }));
  await context.routeWebSocket(/.*/, ws => {
    socket = ws;
    ws.onMessage(raw => {
      const request = JSON.parse(String(raw));
      calls.push(request.cmd);
      ws.send(JSON.stringify({ t: "reply", id: request.id, ok: !failReads, result: snapshot, error: failReads ? "Offline" : undefined }));
    });
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__nested-chat-test`);
  const toggle = page.locator(".chat-children-toggle");
  const children = page.getByRole("list", { name: "Agent chats for Ship the orchestrator", exact: true });
  const titles = () => page.locator(".chat-title").allTextContents();
  await children.waitFor();
  assert.deepEqual(await titles(), ["Ship the orchestrator", "Worker: Implement chat grouping", "Worker: Verify the sidebar", "Plan the next release"]);
  assert.equal(await page.locator(".task-chat-list > .chat-row").count(), 2);
  assert.match(await toggle.textContent(), /2 agents1 working1 unread/);
  const masterBox = await page.locator(".chat-btn").first().boundingBox();
  const childBox = await children.locator(".chat-btn").first().boundingBox();
  assert.ok(childBox.x > masterBox.x && childBox.y > masterBox.y, "Workers are indented below their master");
  await page.locator(".sidebar").screenshot({ path: join(artifacts, "desktop-expanded.png") });

  await toggle.click();
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  assert.deepEqual(await titles(), ["Ship the orchestrator", "Plan the next release"]);
  assert.deepEqual(await page.evaluate(() => window.picks), [], "Collapsing must not select a chat");
  await page.waitForFunction(() => localStorage.getItem("octiq.chat.collapsed-agents") === '["master"]');
  await page.reload();
  await toggle.waitFor();
  assert.equal(await toggle.getAttribute("aria-expanded"), "false", "Collapsed state survives a reload");
  await page.locator(".sidebar").screenshot({ path: join(artifacts, "desktop-collapsed.png") });

  await page.getByRole("searchbox").fill("grouping");
  await page.getByRole("button", { name: /Worker: Implement chat grouping,/ }).waitFor();
  assert.deepEqual(await titles(), ["Worker: Implement chat grouping"], "Search finds a collapsed worker without duplicating it");
  await page.getByRole("button", { name: /Worker: Implement chat grouping,/ }).click();
  await page.getByRole("button", { name: "Clear chat search", exact: true }).click();
  await children.waitFor();
  assert.equal(await toggle.getAttribute("aria-expanded"), "true", "Selecting a worker reveals its parent group");
  assert.equal(await children.locator('[aria-current="page"]').count(), 1);
  assert.equal(await page.locator(".chat-children-unread").count(), 0, "The open worker is read");

  await page.getByRole("button", { name: "Actions for Worker: Verify the sidebar", exact: true }).click();
  await page.getByRole("menuitem", { name: "Rename chat", exact: true }).click();
  await page.getByRole("textbox", { name: "Chat title", exact: true }).fill("Worker: Review results");
  await page.getByRole("textbox", { name: "Chat title", exact: true }).press("Enter");
  await children.getByText("Worker: Review results", { exact: true }).waitFor();

  failReads = true;
  socket.send(JSON.stringify({ t: "event", event: "orchestration-changed", payload: {} }));
  await page.waitForTimeout(100);
  assert.equal(await children.count(), 1, "Transient errors retain the last hierarchy");
  failReads = false;
  snapshot = { ...ledger, attempts: ledger.attempts.slice(0, 1) };
  socket.send(JSON.stringify({ t: "event", event: "orchestration-changed", payload: {} }));
  await page.waitForFunction(() => document.querySelector(".chat-children-toggle")?.textContent.includes("1 agent"));
  assert.equal(await children.locator(".chat").count(), 1, "Ledger events refresh the sidebar with the panel closed");
  snapshot = ledger;
  socket.send(JSON.stringify({ t: "event", event: "orchestration-changed", payload: {} }));
  await page.waitForFunction(() => document.querySelectorAll(".chat-children .chat").length === 2);

  await page.evaluate(() => window.removeMaster());
  await page.waitForFunction(() => !document.querySelector(".chat-children-toggle"));
  assert.equal(await page.locator(".task-chat-list > .chat-row").count(), 3, "Deleting a parent leaves all workers reachable");
  await page.evaluate(() => window.restoreMaster());
  await children.waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  await toggle.waitFor();
  await page.locator(".sidebar").screenshot({ path: join(artifacts, "mobile-expanded.png") });
  const toggleBox = await toggle.boundingBox();
  assert.ok(toggleBox.height >= 44, "Touch disclosure has a full tap target");
  assert.ok(await page.locator(".sidebar").evaluate(el => el.scrollWidth <= el.clientWidth), "Nesting does not overflow the sidebar");
  await toggle.click();
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  await toggle.focus();
  await page.keyboard.press("Enter");
  assert.equal(await toggle.getAttribute("aria-expanded"), "true", "Disclosure is keyboard accessible");
  assert.deepEqual(errors, []);
  assert.ok(calls.every(cmd => cmd === "orchestration_snapshot"), "No live chat is started or changed");
  console.log("PASS: nesting, collapse persistence, search, selection, unread/running summaries, rename, live ledger updates, orphan fallback, mobile layout, and keyboard access.");
  console.log("Screenshots:", artifacts);
} finally {
  await browser?.close();
  await server.close();
}
