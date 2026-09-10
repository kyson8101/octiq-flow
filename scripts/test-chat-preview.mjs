// Mount the real sidebar with an isolated preview source; no agent is started.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.OCTIQOS_PLAYWRIGHT_MODULE ?? "@playwright/test");
const output = await mkdtemp(path.join(tmpdir(), "octiq-chat-preview-"));
const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Sidebar } from "/src/components/Sidebar.tsx";
import "/src/styles.css";
const message = (id, text, role = "user") => ({ id, role, streaming: false, blocks: [{kind: "text", text}] });
const chats = ["Live conversation", "Saved conversation", "Slow conversation", "Unavailable", "Empty chat"].map((title, i) => ({ id: String(i), projectId: "p", title, messages: [], createdAt: 0, updatedAt: 0 }));
window.calls = []; window.picked = []; window.renamed = [];
const loadPreview = async (chat, cancelled) => {
  window.calls.push(chat.id);
  if (chat.id === "2") await new Promise(resolve => window.resolveSlow = resolve);
  if (chat.id === "3") throw Error("Offline");
  if (cancelled()) return [];
  return chat.id === "4" ? [] : [message("saved", "Latest saved message for " + chat.title)];
};
function App() {
  const [live, setLive] = useState([message("a", "Can I preview the latest conversation?"), message("b", "Hover over a chat to see a quick peek of the latest messages, without leaving your current conversation.", "assistant"), message("c", "Great, keep it small and readable.")]);
  const [expanded, setExpanded] = useState(new Set(["p"]));
  window.updateLive = () => setLive(v => [...v, message("d", "Streaming update just arrived.", "assistant")]);
  return React.createElement("div", { style: { display: "flex", height: "100vh" } },
    React.createElement(Sidebar, { projects: [{id: "p", name: "OctiqFlow"}], shelved: [], onShowShelved() {}, conversations: new Map([["p", chats]]), currentProject: "p", currentConversation: "0", running: new Set(["0"]), busy: new Set(["0"]), expanded, onToggle: () => setExpanded(v => v.size ? new Set() : new Set(["p"])), onPickConversation: c => window.picked.push(c.id), onNewChat() {}, onDelete() {}, onPin() {}, onRename: (id, title) => window.renamed.push({id,title}), onSettings() {}, onNewProject() {}, onReorder() {}, getPreviewMessages: id => id === "0" ? live : undefined, loadPreview }),
    React.createElement("main", { style: { padding: "60px", flex: 1 } }, "Current conversation stays open"));
}
createRoot(document.getElementById("root")).render(React.createElement(App));
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
          res.end(await server.transformIndexHtml("/__chat-preview-test", '<html><body><div id="root"></div><script type="module">import "chat-preview-test-fixture"</script></body></html>'));
        } catch (error) { next(error); }
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OCTIQOS_CHROME_EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__chat-preview-test`);
  const row = name => page.getByRole("button", { name, exact: true });
  const preview = page.getByRole("tooltip");
  const live = row("Live conversation");
  await live.hover();
  await page.mouse.move(1000, 600);
  await page.waitForTimeout(650);
  assert.equal(await preview.count(), 0, "Passing over a row must not open a preview");
  assert.deepEqual(await page.evaluate(() => window.calls), []);
  await live.hover();
  await preview.waitFor();
  assert.equal(await preview.locator(".chat-preview-message").count(), 3);
  assert.deepEqual(await page.evaluate(() => window.picked), [], "Preview does not select the chat");
  const anchorBox = await live.boundingBox(), box = await preview.boundingBox();
  assert.ok(box.x >= anchorBox.x + anchorBox.width && box.x + box.width <= 1280);
  await preview.hover();
  await page.waitForTimeout(250);
  assert.equal(await preview.count(), 1, "Preview stays open while reading it");
  await page.screenshot({ path: path.join(output, "desktop.png") });
  await page.evaluate(() => window.updateLive());
  await preview.getByText("Streaming update just arrived.").waitFor();
  await page.keyboard.press("Escape");
  await preview.waitFor({ state: "hidden" });
  await row("Saved conversation").hover();
  await preview.getByText("Latest saved message for Saved conversation").waitFor();
  await page.mouse.move(1000, 600);
  await preview.waitFor({ state: "hidden" });
  await row("Slow conversation").hover();
  await preview.getByText("Loading latest messages…").waitFor();
  await row("Empty chat").hover();
  await preview.getByText("No messages yet.").waitFor();
  await page.evaluate(() => window.resolveSlow());
  await page.waitForTimeout(200);
  assert.equal(await preview.getByText("Latest saved message for Slow conversation").count(), 0);
  await row("Unavailable").hover();
  await preview.getByText("Preview unavailable. Open the chat to try again.").waitFor();
  await row("Unavailable").click();
  await preview.waitFor({ state: "hidden" });
  assert.deepEqual(await page.evaluate(() => window.picked), ["3"]);
  await page.mouse.move(1000, 600);
  await page.keyboard.press("Tab");
  await live.focus();
  await preview.waitFor();
  assert.equal(await live.getAttribute("aria-describedby"), await preview.getAttribute("id"));
  await page.keyboard.press("Escape");
  await preview.waitFor({ state: "hidden" });
  await live.dblclick();
  await page.getByRole("textbox", { name: "Chat title" }).waitFor();
  assert.equal(await preview.count(), 0, "Rename hides preview");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 900, height: 240 });
  await page.mouse.move(850, 220);
  await live.hover();
  await preview.waitFor();
  const small = await preview.boundingBox();
  assert.ok(small.y >= 0 && small.y + small.height <= 240, "Preview fits short viewports");
  await page.screenshot({ path: path.join(output, "short-viewport.png") });
  await page.keyboard.press("Escape");
  await live.dispatchEvent("pointerenter", { pointerType: "touch" });
  await page.waitForTimeout(600);
  assert.equal(await preview.count(), 0, "Touch does not activate hover");
  assert.deepEqual(errors, []);
  console.log(`Chat preview browser checks passed. Screenshots: ${output}`);
} finally { await browser?.close(); await server.close(); }
