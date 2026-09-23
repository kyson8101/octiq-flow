// Exercise the real Settings screen with mocked RPCs. No real vault is read or changed.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const artifacts = await mkdtemp(join(tmpdir(), "octiq-memory-vault-ui-"));
const base = process.env.OCTIQ_TEST_URL || "http://127.0.0.1:5273/";
const browser = await chromium.launch({ channel: process.env.OCTIQ_TEST_BROWSER || "chrome", headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  const calls = [], errors = [];
  let config = { path: "", writable: false };
  let rejectConfig = false;
  await context.route("**/token", route => route.fulfill({ body: "test-token" }));
  await context.route("**/auth", route => route.fulfill({ body: "ok" }));
  await context.routeWebSocket(/.*/, ws => ws.onMessage(raw => {
    const call = JSON.parse(String(raw));
    if (call.t !== "invoke") return;
    calls.push(call);
    let result = [], error;
    if (call.cmd === "list_workspaces") result = [{ id: "p", name: "Vault test", primary_path: "/test/project" }];
    if (call.cmd === "chat_index_list") result = [{ id: "c", projectId: "p", title: "Vault integration", createdAt: 1, updatedAt: 2 }];
    if (call.cmd === "chat_page") result = { events: [], context: [], before: null };
    if (call.cmd === "chat_queue_state") result = { live: false, queuedTurnIds: [] };
    if (call.cmd === "orchestration_snapshot") result = { runs: [], tasks: [], attempts: [], gates: [], messages: [], reports: [] };
    if (call.cmd === "memory_vault_settings") result = config;
    if (call.cmd === "memory_vault_configure") {
      if (rejectConfig) error = "The selected folder is unavailable.";
      else result = config = call.args.config;
    }
    if (call.cmd === "memory_vault_call") {
      if (call.args.action === "search") result = { matches: [{ path: "agent-zone/projects/example/decisions.md", line: 8, snippet: "Use one shared Memory Vault for both agents.", revision: "r1" }], total: 1, nextOffset: null, truncated: false, skipped: 0 };
      if (call.args.action === "read") result = { path: call.args.args.path, content: "# Shared memory\n\nA confirmed decision.", revision: "r1", startLine: call.args.args.startLine, totalLines: 10, nextLine: null };
    }
    ws.send(JSON.stringify({ t: "reply", id: call.id, ok: !error, result, error }));
  }));
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(String(error)));
  await page.goto(base + "#/p/vault-test/c/c");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Memory Vault Shared agent knowledge" }).click();
  await page.getByRole("heading", { name: "Shared Memory Vault" }).waitFor();
  await page.getByLabel("Vault folder on the server").fill("/test/vault");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByLabel("Allow agents to update notes").waitFor();
  assert.deepEqual(config, { path: "/test/vault", writable: false });
  await page.getByLabel("Allow agents to update notes").click();
  await page.waitForFunction(() => document.querySelector(".vault-write-toggle input")?.checked);
  assert.equal(config.writable, true);
  await page.getByLabel("Search notes", { exact: true }).fill("shared memory");
  await page.getByLabel("Within folder", { exact: false }).fill("agent-zone/projects");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: /agent-zone\/projects\/example\/decisions.md/ }).click();
  await page.getByRole("article").waitFor();
  assert.ok((await page.locator(".vault-note pre").textContent()).includes("A confirmed decision"));
  assert.ok(calls.some(call => call.cmd === "memory_vault_call" && call.args.action === "search" && call.args.args.path === "agent-zone/projects"));
  await page.screenshot({ path: join(artifacts, "desktop-dark.png"), fullPage: true });
  await page.getByRole("button", { name: /^Appearance/ }).click();
  await page.getByRole("radio", { name: "Light", exact: true }).click();
  await page.getByRole("button", { name: "Memory Vault Shared agent knowledge" }).click();
  await page.getByLabel("Vault folder on the server").waitFor();
  await page.screenshot({ path: join(artifacts, "desktop-light.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.screenshot({ path: join(artifacts, "mobile-light.png"), fullPage: true });
  rejectConfig = true;
  await page.getByLabel("Vault folder on the server").fill("/missing/vault");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "selected folder is unavailable" }).waitFor();
  assert.equal(config.path, "/test/vault", "a rejected connection preserves the current vault");
  rejectConfig = false;
  await page.getByRole("button", { name: "Disconnect vault" }).click();
  await page.getByText("Connect a folder to make its notes available", { exact: false }).waitFor();
  assert.deepEqual(config, { path: "", writable: false });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, artifacts, checked: ["connect", "write-access", "scoped-search", "read", "light-dark", "mobile-layout", "connection-error", "disconnect"] }));
} finally { await browser.close(); }
