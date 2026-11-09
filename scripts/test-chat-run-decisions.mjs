// REAL SERVER + REAL APP, stub providers, isolated HOME. Never port 1421.
// node scripts/test-chat-run-decisions.mjs /path/to/octiq-server
// OCTIQ_WEB_ROOT and PLAYWRIGHT_MODULE may point at an isolated client/tool install.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer as netServer } from "node:net";
import { browserPaths } from "./browser-paths.mjs";
const { webRoot, require, moduleUrl } = browserPaths(import.meta.url);
const { createServer } = await import(moduleUrl(require.resolve("vite")));
const { chromium } = await import(moduleUrl(process.env.PLAYWRIGHT_MODULE || "playwright"));
const binary = resolve(process.argv[2] || "src-tauri/target/debug/octiq-server");
const evidence = process.env.OCTIQ_EVIDENCE_DIR || await mkdtemp(join(tmpdir(), "octiq-chat-decisions-evidence-"));
await mkdir(evidence, { recursive: true });
const wait = async (label, read, timeout = 30_000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const result = await read(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 80)); }
  throw new Error(`Timed out: ${label}`);
};
function stub() {
  const fs = require("node:fs");
  fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + "\n");
  if (process.argv.includes("--version")) { console.log("stub 1.0.0"); return; }
  if (process.argv.includes("mcp") || process.argv.includes("models")) { console.log("[]"); return; }
  const out = event => console.log(JSON.stringify(event));
  require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message.type === "control_request") return out({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
    if (message.type !== "user") return;
    out({ type: "system", subtype: "init", session_id: `stub-${process.pid}`, model: "sonnet", tools: [] });
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Decision received by the stub provider." }] } });
    out({ type: "result", subtype: "success", is_error: false, session_id: `stub-${process.pid}`, result: "Ready" });
  });
}
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const results = [];
try {
  for (const width of [1280, 390]) {
    const scratch = await mkdtemp(join(tmpdir(), "octiq-chat-decisions-"));
    const taskHome = join(scratch, "home"), bin = join(scratch, "bin"), repo = join(scratch, "repo");
    const profile = join(taskHome, ".octiqflow/profiles/default");
    for (const folder of [taskHome, bin, repo, profile]) await mkdir(folder, { recursive: true });
    await writeFile(join(repo, "README.md"), "# Scratch decision cards\n");
    for (const args of [["init", "-q", "-b", "develop"], ["add", "README.md"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) execFileSync("git", args, { cwd: repo });
    for (const cli of ["claude", "codex", "agy", "pi"]) await writeFile(join(bin, cli), `#!${process.execPath}\n(${stub.toString()})();\n`, { mode: 0o755 });
    const shell = join(bin, "fixture-shell");
    await writeFile(shell, '#!/bin/sh\nif [ "$1" = "-lc" ]; then shift; exec /bin/sh -c "$@"; fi\nif [ "$1" = "-l" ]; then shift; fi\nexec /bin/sh "$@"\n', { mode: 0o755 });
    const stored = { version: 1, runs: {}, tasks: {}, attempts: {}, gates: {} };
    const scenes = {};
    for (const [kind, file] of [["gate", "failure_escalated"], ["failure", "failure_awaits_person"]]) {
      const scene = JSON.parse(await readFile(join(webRoot, "src/lib/__fixtures__/host", `${file}.json`), "utf8"));
      const coordinator = `chat:main-${kind}`;
      const original = scene.runs[0].coordinatorChatKey;
      const replace = value => typeof value === "string" && value === original ? coordinator : value;
      const source = JSON.parse(JSON.stringify(scene), (_, v) => replace(v));
      const run = source.runs[0];
      Object.assign(run, { coordinatorChatKey: coordinator, rootPath: repo, workspaceId: "fixture-project", workspaceMode: "direct", workerDefaults: null });
      // These are derived host fixtures, seeded as persisted inputs; old disk paths
      // and provider settings are replaced only with this scratch repo/stub.
      for (const task of source.tasks) {
        delete task.workspaceProposal;
        delete task.workspace;
        task.title = kind === "gate" ? "Choose how to recover this task" : "Retry the failed build";
      }
      for (const attempt of source.attempts) Object.assign(attempt, { cwd: repo, branch: "develop", isWorktree: false, agent: "claude", model: "sonnet", access: "full" });
      for (const key of Object.keys(stored).filter(key => key !== "version")) for (const item of source[key] ?? []) stored[key][item.id] = item;
      scenes[kind] = { run, task: source.tasks[0], gate: source.gates[0], coordinator };
    }
    await writeFile(join(profile, "orchestrations.json"), JSON.stringify(stored));
    await writeFile(join(profile, "workspaces.json"), JSON.stringify({ workspaces: [
      { id: "fixture-project", name: "Decision fixture", primary_path: repo },
    ] }));
    const allocator = netServer(); await new Promise(resolve => allocator.listen(0, "127.0.0.1", resolve));
    const port = allocator.address().port; await new Promise(resolve => allocator.close(resolve));
    assert.notEqual(port, 1421);
    const token = "isolated-decision-fixture";
    const server = spawn(binary, [], { env: { ...process.env, HOME: taskHome, USERPROFILE: taskHome, SHELL: shell,
      PATH: `${bin}:${process.env.PATH}`, STUB_LOG: join(scratch, "stub.jsonl"), OCTIQ_WEB_BIND: "127.0.0.1", OCTIQ_WEB_PORT: String(port), OCTIQ_WEB_TOKEN: token, OCTIQ_CHAT_IDLE_MINS: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    let serverLog = "", socket, vite, context;
    server.stdout.on("data", data => { serverLog += data; }); server.stderr.on("data", data => { serverLog += data; });
    try {
      await wait("scratch server", async () => { try { return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch { return false; } });
      socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
      await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
      let sequence = 0; const replies = new Map();
      socket.onmessage = ({ data }) => { const frame = JSON.parse(data); if (frame.t !== "reply") return; const pending = replies.get(frame.id); if (!pending) return; replies.delete(frame.id); frame.ok ? pending.resolve(frame.result) : pending.reject(new Error(frame.error)); };
      const invoke = (cmd, args = {}) => new Promise((resolve, reject) => { const id = ++sequence; replies.set(id, { resolve, reject }); socket.send(JSON.stringify({ t: "invoke", id, cmd, args })); });
      for (const { coordinator } of Object.values(scenes)) await invoke("chat_index_save", { meta: { id: coordinator.slice(5), projectId: "fixture-project", title: "Decision coordinator", cwd: repo, modelId: "claude:sonnet", access: "full", sessionId: "fixture-main", coordinatesRun: true } });
      vite = await createServer({ root: webRoot, server: { host: "127.0.0.1", port: 0, proxy: {
        "/ws": { target: `ws://127.0.0.1:${port}`, ws: true },
        "/auth": `http://127.0.0.1:${port}`, "/token": `http://127.0.0.1:${port}`,
      } } });
      await vite.listen(); const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
      context = await browser.newContext({ viewport: { width, height: 960 }, reducedMotion: "reduce" });
      await context.addInitScript(token => {
        localStorage.setItem("octiq.web.token", token); localStorage.setItem("octiq.agentsMode", "on");
        localStorage.setItem("octiq.v2.gitColumn", "0"); localStorage.setItem("octiq.theme", "dark");
      }, token);
      const page = await context.newPage(); page.setDefaultTimeout(20_000);
      const errors = []; page.on("pageerror", error => errors.push(error.message));
      for (const kind of ["gate", "failure"]) {
        const scene = scenes[kind];
        const url = `${base}/?token=${token}#/p/fixture-project/c/${scene.coordinator.slice(5)}`;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
        const card = page.locator(`.chat-run-decision[data-pending-keys="${kind === "gate" ? `gate:${scene.gate.id}` : `failure:${scene.task.id}`}" ]`);
        try { await card.waitFor(); } catch (error) {
          await page.screenshot({ path: join(evidence, `missing-${width}.png`), fullPage: true });
          await writeFile(join(evidence, `missing-${width}.html`), await page.content());
          await writeFile(join(evidence, `ledger-${width}.json`), JSON.stringify(await invoke("orchestration_snapshot"), null, 2));
          console.error("Evidence:", evidence, errors); throw error;
        }
        // The Tasks column is put away: the chat alone owns the answer here.
        const toggle = page.locator(".tasks-toggle").first();
        if (await toggle.count() && await toggle.getAttribute("aria-expanded") === "true") await toggle.click();
        await card.scrollIntoViewIfNeeded();
        const composer = page.locator(".composer-box");
        const before = await composer.boundingBox();
        await card.getByRole("button", { name: "Show details", exact: true }).click();
        await card.getByRole("button", { name: "Hide details", exact: true }).waitFor();
        assert.deepEqual(await composer.boundingBox(), before, "the fold grows up without moving the composer");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        for (const button of await card.locator("button").all()) assert.ok((await button.boundingBox()).height >= 44, "44px touch targets");
        await page.screenshot({ path: join(evidence, `${kind}-${width}.png`), fullPage: true });
        if (kind === "gate") {
          await card.locator("input").fill("Leave this task for review");
          await card.getByRole("button", { name: "Answer", exact: true }).click();
          await wait("gate's person answer", async () => (await invoke("orchestration_snapshot", { runId: scene.run.id })).gates.some(gate => gate.id === scene.gate.id && gate.status === "resolved"));
        } else {
          await card.getByRole("button", { name: "Start retry", exact: true }).click();
          try {
            await wait("person retry", async () => (await invoke("orchestration_snapshot", { runId: scene.run.id })).attempts.some(attempt => attempt.taskId === scene.task.id && attempt.number > 3));
          } catch (error) {
            await page.screenshot({ path: join(evidence, `retry-error-${width}.png`), fullPage: true });
            console.error("Retry card:", await card.innerText(), "Evidence:", evidence);
            throw error;
          }
        }
        await card.waitFor({ state: "detached" });
        if (width === 390) await page.getByRole("button", { name: "Tasks", exact: true }).click();
        else await toggle.click();
        const panel = page.locator(".orch-embedded");
        await panel.waitFor();
        if (kind === "gate") assert.equal(await panel.locator(`.orch-gate[data-pending-keys="gate:${scene.gate.id}"]`).count(), 0, "panel gate is gone too");
        else assert.equal(await panel.locator(`[data-task-id="${scene.task.id}"]`).getAttribute("data-failure"), null, "panel no longer calls the failure the person's");
        await page.screenshot({ path: join(evidence, `${kind}-answered-panel-${width}.png`), fullPage: true });
        results.push({ width, kind, chatAnswered: true, panelUpdated: true });
        console.log("Verified", width, kind);
      }
      assert.deepEqual(errors, []);
    } catch (error) {
      await writeFile(join(evidence, `server-${width}.log`), serverLog);
      throw error;
    } finally {
      await context?.close(); await vite?.close(); socket?.close(); server.kill("SIGTERM");
      if (server.exitCode === null) await new Promise(resolve => server.once("exit", resolve));
    }
  }
  await writeFile(join(evidence, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ results, evidence }));
} finally { await browser.close(); }
