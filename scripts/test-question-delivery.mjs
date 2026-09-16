// Real question card and pending-request hook, with deterministic transport.
// Does not read real chats or start any agent.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.OCTIQOS_PLAYWRIGHT_MODULE ?? "@playwright/test");
const artifacts = await mkdtemp(join(tmpdir(), "octiq-question-ui-"));
const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { UserQuestion } from "/src/components/UserQuestion.tsx";
import { useChatRequests } from "/src/lib/useChatRequests.ts";
import "/src/design-system.css";
import "@fontsource-variable/inter";
import "/src/styles.css";
const pending = JSON.parse(localStorage.getItem("test.questions") || '[{"id":"q1","chatKey":"chat:test","question":"Which database?","options":["SQLite","Postgres"],"status":"pending"}]');
window.calls = [];
window.failure = "network";
window.invoke = async (command, args) => {
  if (command.endsWith("_pending")) return command === "question_pending" ? pending : [];
  window.calls.push({command, args});
  if (window.failure === "network") throw new Error("Disconnected. Your answer is still here.");
  if (window.failure === "receipt") return {saved:false};
  if (command === "question_answer_batch") {
    await new Promise(resolve => { window.release = resolve; });
    const saved = pending.map(q => ({...q, status:"saved", answer:args.answers.find(a => a.id === q.id).answer}));
    localStorage.setItem("test.questions", JSON.stringify(saved));
    saved.forEach(q => window.emit("question-updated", q));
    return {saved:true};
  }
  if (command === "question_cancel") { localStorage.setItem("test.questions", "[]"); return null; }
  if (command === "question_retry") return {saved:true};
};
function Fixture() {
  const {questions, setQuestions} = useChatRequests("open", () => {});
  const current = questions.test || [];
  return React.createElement("main",{style:{maxWidth:650,margin:"24px auto",padding:"0 16px"}},
    current.length ? React.createElement(UserQuestion,{questions:current,startOpen:true,
      onDone:ids => setQuestions(s => ({...s,test:(s.test || []).filter(q => !ids.includes(q.id))}))}) : "No pending questions");
}
createRoot(document.getElementById("root")).render(React.createElement(Fixture));
`;
const mockBridge = `
const handlers = new Map();
window.emit = (event, value) => { for (const fn of handlers.get(event) || []) fn(value); };
export const bridge = {
 invoke: (command, args) => window.invoke(command, args),
 on: (event, fn) => { if (!handlers.has(event)) handlers.set(event,new Set()); handlers.get(event).add(fn); return () => handlers.get(event).delete(fn); }
};`;
const server = await createServer({
  root: fileURLToPath(new URL("../web", import.meta.url)),
  configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)),
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  plugins: [{
    name: "question-delivery-fixture", enforce: "pre",
    resolveId(id) {
      if (id === "question-delivery-fixture") return "\0question-delivery-fixture";
      if (id === "./bridge" || id === "../lib/bridge") return "\0question-test-bridge";
    },
    load(id) {
      if (id === "\0question-delivery-fixture") return fixture;
      if (id === "\0question-test-bridge") return mockBridge;
    },
    configureServer(server) {
      server.middlewares.use("/__question-test", async (_req, res, next) => {
        try {
          res.setHeader("Content-Type", "text/html");
          res.end(await server.transformIndexHtml("/__question-test", '<html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="overflow:auto"><div id="root"></div><script type="module">import "question-delivery-fixture"</script></body></html>'));
        } catch (error) { next(error); }
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, channel: process.env.OCTIQOS_CHROME_EXECUTABLE ? undefined : "chrome", executablePath: process.env.OCTIQOS_CHROME_EXECUTABLE });
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 850 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__question-test`);
    await page.getByRole("radio", { name: "SQLite" }).click();
    await page.getByRole("button", { name: "Send 1 answer", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Disconnected" }).waitFor();
    assert.equal(await page.getByRole("radio", { name: "SQLite" }).getAttribute("aria-checked"), "true");
    await page.evaluate(() => { window.failure = "receipt"; });
    await page.getByRole("button", { name: "Send 1 answer", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "did not confirm" }).waitFor();
    await page.screenshot({ path: join(artifacts, `failed-${width}.png`) });
    await page.evaluate(() => { window.failure = null; });
    await page.getByRole("button", { name: "Send 1 answer", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "Sending…" }).isDisabled(), true);
    await page.evaluate(() => window.release());
    await page.getByText("Answers saved · waiting for agent", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.calls.filter(c => c.command === "question_answer_batch").length), 3);
    await page.reload();
    await page.getByText("Answers saved · waiting for agent", { exact: true }).waitFor();
    assert.equal(await page.getByText("SQLite", { exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(artifacts, `saved-${width}.png`) });
    await page.getByRole("button", { name: "Cancel pending delivery" }).click();
    await page.getByRole("alert").filter({ hasText: "Disconnected" }).waitFor();
    assert.equal(await page.getByText("SQLite", { exact: true }).count(), 1);
    await page.evaluate(() => window.emit("question-expired", {id:"q1"}));
    await page.getByText("No pending questions").waitFor();
    await context.close();
  }
  console.log(`Question delivery browser checks passed. Screenshots: ${artifacts}`);
} finally {
  await browser?.close();
  await server.close();
}
