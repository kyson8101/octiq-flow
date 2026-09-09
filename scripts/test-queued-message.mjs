// Exercise the real mobile queue controls without starting an agent.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.OCTIQOS_PLAYWRIGHT_MODULE ?? "@playwright/test");
const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { MessageList } from "/src/components/MessageList.tsx";
import "/src/styles.css";
window.calls = [];
createRoot(document.getElementById("root")).render(React.createElement(MessageList, {messages:[{id:"u",turnId:"u",role:"user",blocks:[{kind:"text",text:"Queued message"}]}], busy:true, onStartQueued:() => window.calls.push("start"), onCancelQueued:() => window.calls.push("cancel")}));
`;
const server = await createServer({
  root: fileURLToPath(new URL("../web", import.meta.url)),
  configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)),
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  plugins: [{ name: "chat-preview-test-fixture",
    resolveId(id) { if (id === "chat-preview-test-fixture") return "\0chat-preview-test-fixture"; },
    async load(id) { if (id === "\0chat-preview-test-fixture") return fixture; },
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
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__chat-preview-test`);
  await page.getByRole("button", {name:"Take this queued message back to edit",exact:true}).tap({timeout:3000});
  assert.deepEqual(await page.evaluate(() => window.calls), ["cancel"]);
  await page.getByRole("button", {name:"Send this queued message now",exact:true}).tap();
  assert.deepEqual(await page.evaluate(() => window.calls), ["cancel", "start"]);
  console.log("Mobile queue actions passed");
} finally { await browser?.close(); await server.close(); }
