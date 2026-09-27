// The run panel's environment evidence and staged acceptance (feedback
// caa2ca88 B4, ee0a43b0 B7), in the real panel with a synthetic ledger and
// sandbox record; never opens or changes live chats.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer, transformWithEsbuild } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const artifacts = process.env.OUT || await mkdtemp(join(tmpdir(), "octiq-sandbox-lifecycle-ui-"));
const now = Date.now();
const base = { runId: "run", spec: "brief", dependsOn: [], createdAt: now, updatedAt: now,
  worker: { agent: "claude", model: "opus", access: "auto" } };
const attempt = (id, taskId, key, status, execution) => ({ id, runId: "run", taskId, number: 1, workerChatKey: key,
  agent: "claude", access: "auto", status, cwd: "/w", branch: `feature/${taskId}`, isWorktree: true, filesModified: [],
  createdAt: now, updatedAt: now, execution: { retryCount: 0, lastActivityAt: now, lastProgressAt: now, ...execution } });
const workspace = (merged) => ({
  plan: { mode: "worktree", cwd: "/w", checkoutRoot: "/w", repositoryRoot: "/r", branch: "b", baseBranch: "develop", baseSha: "0",
    managed: true, isRepo: true, warnings: [], initialStatus: "" },
  state: "retained", abandoned: false, validationPaths: [],
  delivery: { headSha: "1", dirty: false, hasCommits: true, pushed: true, merged, checkedAt: now, notes: [] },
});
const snapshot = {
  runs: [{ id: "run", coordinatorChatKey: "chat:master", objective: "Excel import, accepted in a sandbox", workspaceId: "project",
    rootPath: "/test", status: "running", maxConcurrent: 2, createdAt: now, updatedAt: now }],
  tasks: [
    { ...base, id: "build", title: "Build the import", status: "completed", activeAttemptId: "a1", environment: "sandbox", workspace: workspace(true) },
    { ...base, id: "browser", title: "Browser-check the upload", status: "running", activeAttemptId: "a2", environment: "sandbox", kind: "acceptance", dependsOn: ["build"] },
    { ...base, id: "review", title: "Review the change", status: "completed", activeAttemptId: "a3", kind: "review", verdict: "pass" },
    { ...base, id: "legacy", title: "Older review", status: "completed", activeAttemptId: "a4" },
    { ...base, id: "release", title: "Publish the OTA", status: "running", activeAttemptId: "a5" },
  ],
  attempts: [
    attempt("a1", "build", "chat:w1", "completed", { state: "completed" }),
    attempt("a2", "browser", "chat:w2", "running", { state: "waiting_tool", currentOperation: "Waiting for environment capacity: 3 of 3 in use, position 1 in line", pendingTools: { "octiq:environment": "Waiting for environment capacity: 3 of 3 in use, position 1 in line" } }),
    attempt("a3", "review", "chat:w3", "completed", { state: "completed" }),
    attempt("a4", "legacy", "chat:w4", "completed", { state: "completed" }),
    attempt("a5", "release", "chat:w5", "running", { state: "awaiting_report" }),
  ],
  gates: [], messages: [],
  nativeDecisions: [{ id: "nd_7f3a9c21b4e5", runId: "run", taskId: "release", attemptId: "a5", chatKey: "chat:w5",
    reason: "Auto mode refused the release command.", blockedAction: null, status: "pending",
    continuation: "unavailable", recovery: "Start a new attempt with manual access.", observedAt: now }],
};
const sandboxes = {
  defaultEnabled: false,
  environments: {
    "chat:w1": { id: "octiq-sb-1", chatKey: "chat:w1", enabled: true, locked: true, cwd: "/w", state: "stale",
      checkedAt: now - 12 * 60_000, error: null, urls: {}, sourceRevision: "0123456789", sourceDirty: false, fixtureVersion: "ihrms-tomei-v1",
      fingerprint: { sources: [{ path: "/repos/api", revision: "0123456789", dirty: false, digest: null }], recipe: "recorded", fixtureVersion: "ihrms-tomei-v1" },
      invalidated: { kind: "stale", reason: "/repos/api: HEAD moved from 01234567 to 89abcdef since the last check.", at: now - 60_000 },
      probedAt: now - 60_000, probing: false },
  },
  capacity: { limit: 3, live: ["chat:x", "chat:y", "chat:w1"], waiting: [{ label: "Browser-check the upload", keys: ["chat:w2", "chat:w1"], since: now - 90_000 }] },
};
const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { OrchestrationPanel } from "/src/components/OrchestrationPanel.tsx";
import "/src/design-system.css";
import "/src/styles.css";
createRoot(document.getElementById("root")).render(
  <aside style={{ width: "min(560px, 100vw)", height: "100vh", display: "flex", marginLeft: "auto", borderLeft: "1px solid var(--border)" }}>
    <OrchestrationPanel embedded project={{ id: "project", name: "OctiqFlow" }} coordinatorKey="chat:master"
      initialSnapshot={${JSON.stringify(snapshot)}} onOpenChat={() => {}} onClose={() => {}} />
  </aside>
);
`;
const server = await createServer({
  root: fileURLToPath(new URL("../web", import.meta.url)),
  configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)),
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  plugins: [{
    name: "lifecycle-fixture",
    resolveId(id) { if (id === "lifecycle-fixture") return "\0lifecycle-fixture.tsx"; },
    async load(id) {
      if (id === "\0lifecycle-fixture.tsx") return (await transformWithEsbuild(fixture, "fixture.tsx", { loader: "tsx", jsx: "automatic" })).code;
    },
    configureServer(server) {
      server.middlewares.use("/__lifecycle-test", async (_req, res, next) => {
        try {
          res.setHeader("Content-Type", "text/html");
          res.end(await server.transformIndexHtml("/__lifecycle-test", '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"/></head><body><div id="root"></div><script type="module">import "lifecycle-fixture"</script></body></html>'));
        } catch (error) { next(error); }
      });
    },
  }],
});
let browser;
const errors = [];
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 1000 }, isMobile: mobile, hasTouch: mobile });
    await context.route("**/token", route => route.fulfill({ body: "mock-token" }));
    await context.route("**/auth", route => route.fulfill({ body: "ok" }));
    const asked = [];
    await context.routeWebSocket(/.*/, socket => socket.onMessage(raw => {
      const request = JSON.parse(String(raw));
      asked.push(request.cmd);
      const result = request.cmd === "sandbox_snapshot" ? sandboxes : snapshot;
      socket.send(JSON.stringify({ t: "reply", id: request.id, ok: true, result }));
    }));
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__lifecycle-test`);
    const card = (title) => page.locator(".orch-task").filter({ has: page.getByRole("button", { name: `Open task chat: ${title}`, exact: true }) });
    await card("Build the import").waitFor();

    // Environment state beside, not inside, the task's status.
    const stale = card("Build the import").locator(".orch-task-env");
    await stale.waitFor();
    assert.equal(await stale.textContent(), "Env stale");
    assert.match(await stale.getAttribute("title"), /HEAD moved from 01234567 to 89abcdef/);
    assert.match(await stale.getAttribute("title"), /not a release/);
    assert.match(await card("Build the import").locator(".orch-task-state").textContent(), /^Completed/);
    const waiting = card("Browser-check the upload").locator(".orch-task-env");
    assert.equal(await waiting.textContent(), "Env waiting for a slot");
    assert.match(await waiting.getAttribute("title"), /All 3 host environment slots/);
    assert.equal(await card("Browser-check the upload").locator(".orch-task-kind").textContent(), "Acceptance");
    assert.match(await card("Browser-check the upload").locator(".orch-task-state").textContent(), /^Waiting for an environment slot/);

    // Verdicts: a passed review says so; a legacy task gets nothing invented.
    assert.match(await card("Review the change").locator(".orch-task-state").textContent(), /^Done · passed/);
    assert.match(await card("Older review").locator(".orch-task-state").textContent(), /^Completed/);
    assert.equal(await card("Older review").locator(".orch-task-kind").count(), 0);

    // The native decision, named only because one was observed, and never
    // offered as resumable when it cannot be.
    const decision = card("Publish the OTA").locator(".orch-task-decision");
    assert.equal(await decision.textContent(), "Decision recorded · cannot resume nd_7f3a9c2");
    assert.match(await decision.getAttribute("title"), /cannot continue from here/);
    assert.equal(await card("Build the import").locator(".orch-task-decision").count(), 0);

    // Staged acceptance: closed, the acceptance line; open, each stage.
    const stages = page.locator(".orch-stages");
    assert.equal(await stages.locator("summary").textContent(), "AcceptanceUnverified");
    await stages.locator("summary").click();
    const stage = async (label) => (await stages.locator(".orch-stage").filter({ has: page.locator("dt").getByText(label, { exact: true }) }).locator(".orch-stage-value").textContent());
    assert.equal(await stage("Tasks settled"), "3 of 5");
    assert.equal(await stage("Checks"), "1 passed · 1 awaiting");
    assert.equal(await stage("Source integration"), "1 of 1 branches merged");
    assert.equal(await stage("Sandbox runtime"), "1 stale · 1 waiting for a slot");
    assert.equal(await stage("Deployed runtime"), "Not tracked");
    assert.equal(await stage("Acceptance"), "Unverified");

    // The task details carry the full evidence list.
    await page.getByRole("button", { name: "Expand task progress: Build the import", exact: true }).click();
    await card("Build the import").getByText("Task details", { exact: true }).click();
    await card("Build the import").getByText("/repos/api @ 01234567").waitFor();
    await card("Build the import").getByText("Fixture ihrms-tomei-v1").waitFor();
    assert.ok(asked.includes("sandbox_snapshot"), "the panel reads test environments for a run that has them");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no sideways scroll");
    await page.screenshot({ path: join(artifacts, mobile ? "mobile.png" : "desktop.png"), fullPage: true });
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, artifacts }));
} finally {
  await browser?.close();
  await server.close();
}
