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
const artifacts = await mkdtemp(join(tmpdir(), "octiq-task-panel-"));
const now = Date.now();
const task = {
  id: "downloads", runId: "run", title: "Verify allowed and denied downloads", spec: "The complete worker brief.",
  dependsOn: [], status: "running", activeAttemptId: "active", createdAt: now, updatedAt: now,
  worker: { agent: "codex", model: "gpt-5.6-sol", effort: "high", access: "auto" },
};
const attempt = {
  id: "active", runId: "run", taskId: task.id, number: 2, workerChatKey: "chat:current-worker",
  agent: "codex", access: "auto", status: "running", cwd: "/test", branch: "feature/downloads",
  isWorktree: true, filesModified: [], createdAt: now, updatedAt: now,
  execution: { state: "executing", retryCount: 0, lastActivityAt: now, lastProgressAt: now,
    lastProgress: "Diagnostic progress", currentOperation: "Diagnostic operation" },
};
const snapshot = {
  runs: [{ id: "run", coordinatorChatKey: "chat:master", objective: "Verify file downloads", workspaceId: "project",
    rootPath: "/test", status: "running", maxConcurrent: 2, createdAt: now, updatedAt: now }],
  tasks: [task, { ...task, id: "queued", title: "Record final evidence", status: "pending", activeAttemptId: null }],
  attempts: [attempt, { ...attempt, id: "old", number: 1, workerChatKey: "chat:old-worker", status: "failed",
    execution: { state: "failed", retryCount: 0 } }],
  gates: [], messages: [],
  reports: { [attempt.workerChatKey]: { objective: task.title, reportedAt: now - 5 * 60_000, steps: [
    "Materialize accepted frontend and spec inputs", "Add RED company-mismatch regressions",
    "Integrate reviewed identity guard", "Run focused tests and source checks", "Start integrated frontend, API, and router",
    "Verify real allowed and denied downloads", "Record evidence and settle the worker",
  ].map((title, index) => ({ title, state: index < 5 ? "done" : index === 5 ? "active" : "pending" })) } },
};
const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { OrchestrationPanel } from "/src/components/OrchestrationPanel.tsx";
import "/src/design-system.css";
import "/src/styles.css";
window.picks = [];
createRoot(document.getElementById("root")).render(
  <aside style={{ width: "min(480px, 100vw)", height: "100vh", display: "flex", marginLeft: "auto", borderLeft: "1px solid var(--border)" }}>
    <OrchestrationPanel embedded project={{ id: "project", name: "OctiqFlow" }} coordinatorKey="chat:master"
      initialSnapshot={${JSON.stringify(snapshot)}} onOpenChat={key => window.picks.push(key)} onClose={() => {}} />
  </aside>
);
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
  browser = await chromium.launch({ headless: true });
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 1000 }, isMobile: mobile, hasTouch: mobile });
    await context.route("**/token", route => route.fulfill({ body: "mock-token" }));
    await context.route("**/auth", route => route.fulfill({ body: "ok" }));
    await context.routeWebSocket(/.*/, socket => socket.onMessage(raw => {
      const request = JSON.parse(String(raw));
      socket.send(JSON.stringify({ t: "reply", id: request.id, ok: true, result: snapshot }));
    }));
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__task-panel-test`);
    const row = page.getByRole("button", { name: `Open task chat: ${task.title}`, exact: true });
    const taskCard = page.locator(".orch-task").filter({ has: row });
    const expand = page.getByRole("button", { name: `Expand task progress: ${task.title}`, exact: true });
    const collapse = page.getByRole("button", { name: `Collapse task progress: ${task.title}`, exact: true });
    const checklist = page.getByRole("list", { name: "Reported checklist" });
    await row.waitFor();
    assert.equal(await checklist.isVisible(), false);
    if (mobile) await row.tap(); else await row.click();
    assert.deepEqual(await page.evaluate(() => window.picks), ["chat:current-worker"]);
    assert.equal(await expand.getAttribute("aria-expanded"), "false", "Opening chat must not expand progress");
    if (mobile) await expand.tap(); else await expand.click();
    await checklist.waitFor();
    assert.equal(await checklist.locator("li").count(), 7);
    assert.equal(await checklist.locator('[data-state="done"]').count(), 5);
    await taskCard.getByText("Selected worker: Codex · Sol · high effort", { exact: true }).waitFor();
    await page.getByText(/5 of 7 steps done · reported 5m ago/).waitFor();
    assert.deepEqual(await page.evaluate(() => window.picks), ["chat:current-worker"], "Expansion must not navigate");
    for (const removed of ["Last activity", "Last meaningful progress", "Current operation"]) {
      assert.equal(await page.getByText(removed, { exact: true }).count(), 0);
    }
    assert.equal(await page.getByRole("button", { name: "codex worker #2", exact: true }).isVisible(), false);
    const empty = page.getByRole("button", { name: "Open task chat: Record final evidence", exact: true });
    assert.equal(await empty.isDisabled(), true);
    await page.getByRole("button", { name: "Expand task progress: Record final evidence", exact: true }).click();
    await page.getByText("No checklist reported", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(artifacts, mobile ? "mobile-expanded.png" : "desktop-expanded.png") });
    await page.getByRole("button", { name: "Collapse task progress: Record final evidence", exact: true }).click();
    if (mobile) await collapse.tap(); else {
      await collapse.focus();
      await page.keyboard.press("Space");
    }
    assert.equal(await checklist.isVisible(), false);
    if (!mobile) {
      await expand.focus();
      await page.keyboard.press("Enter");
      await checklist.waitFor();
      await row.focus();
      await page.keyboard.press("Enter");
      assert.deepEqual(await page.evaluate(() => window.picks), ["chat:current-worker", "chat:current-worker"]);
      await page.getByText("Task details", { exact: true }).first().click();
      await page.getByRole("button", { name: "codex worker #2", exact: true }).waitFor();
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, artifacts }));
} finally {
  await browser?.close();
  await server.close();
}
