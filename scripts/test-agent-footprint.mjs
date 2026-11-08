// Real isolated backend and launch policy; stub providers and extra MCPs only.
// No paid provider, personal configuration, live service, or open chat is used.
// Usage: node scripts/test-agent-footprint.mjs <binary> <evidence-dir> before|after
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const binary = path.resolve(process.argv[2]);
const evidence = path.resolve(process.argv[3]);
const after = process.argv[4] === "after";
assert(["before", "after"].includes(process.argv[4]));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-agent-footprint-"));
const home = path.join(scratch, "home"), bin = path.join(scratch, "bin");
const repo = path.join(scratch, "repo"), ordinary = path.join(scratch, "ordinary");
for (const dir of [home, bin, repo, ordinary, evidence]) fs.mkdirSync(dir, { recursive: true });
for (const args of [["init", "-q", "-b", "develop"], ["-c", "user.name=Fixture", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "fixture"]]) execFileSync("git", args, { cwd: repo });
const callsFile = path.join(scratch, "calls.jsonl");

function providerStub() {
  const fs = require("node:fs"), path = require("node:path");
  const { spawn } = require("node:child_process");
  const provider = path.basename(process.argv[1]), argv = process.argv.slice(2);
  const servers = ["fixture_browser", "fixture_codegraph", "fixture_docs"];
  if (argv.includes("--version")) { console.log("stub 1.0.0"); return; }
  if (argv.includes("models") || argv.includes("--help")) { console.log("[]"); return; }
  if (argv[0] === "mcp") { console.log(JSON.stringify(servers.map(name => ({ name, transport: { type: "stdio" } })))); return; }
  const log = data => fs.appendFileSync(process.env.FOOTPRINT_LOG, JSON.stringify({ provider, pid: process.pid, key: process.env.OCTIQ_CHAT_KEY, ...data }) + "\n");
  const out = data => process.stdout.write(JSON.stringify(data) + "\n");
  log({ argv });
  let octiqArgs;
  if (provider === "claude") {
    octiqArgs = JSON.parse(fs.readFileSync(argv[argv.indexOf("--mcp-config") + 1])).mcpServers.octiq.args;
  } else {
    const setting = argv.find(a => a.startsWith("mcp_servers.octiq.args="));
    octiqArgs = JSON.parse(setting.slice(setting.indexOf("=") + 1));
  }
  const octiq = spawn(process.execPath, octiqArgs, { stdio: ["pipe", "pipe", "inherit"] });
  octiq.stdout.resume();
  octiq.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) + "\n");
  const enabled = servers.filter(name => provider === "claude" ? !argv.includes("--strict-mcp-config") : !argv.some(a => a.startsWith(`mcp_servers.${name}=`) && a.includes("enabled=false")));
  for (const name of enabled) {
    const child = spawn(process.execPath, ["-e", "process.stdin.resume(); process.stdin.on('end',()=>process.exit(0))"], { stdio: ["pipe", "ignore", "ignore"] });
    log({ mcp: name, child: child.pid });
  }
  log({ mcp: "octiq", child: octiq.pid });
  const thread = `fixture-${provider}-${process.pid}`;
  require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
    const msg = JSON.parse(line);
    if (provider === "codex") {
      if (msg.method === "initialize") return out({ id: msg.id, result: { userAgent: "fixture" } });
      if (["thread/start", "thread/resume"].includes(msg.method)) {
        log({ method: msg.method, params: msg.params });
        return out({ id: msg.id, result: { thread: { id: thread } } });
      }
      if (msg.method === "turn/start") {
        log({ method: msg.method, params: msg.params });
        out({ id: msg.id, result: { turn: { id: "fixture-turn" } } });
        out({ method: "turn/started", params: { threadId: thread, turn: { id: "fixture-turn" } } });
        return out({ method: "turn/completed", params: { threadId: thread, turn: { id: "fixture-turn", status: "completed" } } });
      }
    } else if (msg.type === "user") {
      out({ type: "system", subtype: "init", session_id: thread, model: "sonnet", tools: [] });
      out({ type: "result", subtype: "success", session_id: thread, is_error: false, result: "Fixture ready" });
    } else if (msg.type === "control_request") {
      out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: {} } });
    }
  }).on("close", () => process.exit(0));
}
for (const provider of ["claude", "codex"]) fs.writeFileSync(path.join(bin, provider), `#!${process.execPath}\n(${providerStub.toString()})();\n`, { mode: 0o755 });
// No fallback can accidentally launch an installed provider.
for (const provider of ["pi", "agy"]) fs.writeFileSync(path.join(bin, provider), "#!/bin/sh\nexit 127\n", { mode: 0o755 });
const shell = path.join(bin, "fixture-shell");
fs.writeFileSync(shell, "#!/bin/sh\nif [ \"$1\" = '-lc' ]; then shift; exec /bin/sh -c \"$@\"; fi\nexec /bin/sh \"$@\"\n", { mode: 0o755 });
const portFinder = net.createServer();
await new Promise(resolve => portFinder.listen(0, "127.0.0.1", resolve));
const port = portFinder.address().port;
await new Promise(resolve => portFinder.close(resolve));
const token = "isolated-footprint-fixture";
const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex"), CLAUDE_CONFIG_DIR: path.join(home, ".claude"), SHELL: shell, PATH: `${bin}:${process.env.PATH}`, FOOTPRINT_LOG: callsFile, OCTIQ_CHAT_KEY: "", OCTIQ_SESSION_KEY: "", OCTIQ_CHAT_CAPABILITY: "", OCTIQ_ORCHESTRATION_ATTEMPT: "", OCTIQ_FRONT_DESK: "", OCTIQ_HOOK_PORT: "", OCTIQ_ROOT: "",
  OCTIQ_WEB_BIND: "127.0.0.1", OCTIQ_WEB_PORT: String(port), OCTIQ_WEB_TOKEN: token, OCTIQ_CHAT_IDLE_MINS: "1", OCTIQ_CODEX_TRANSPORT: "app-server" };
const server = spawn(binary, [], { env, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "", ws, sequence = 0;
server.stdout.on("data", d => { serverLog += d; }); server.stderr.on("data", d => { serverLog += d; });
const replies = new Map(), events = [], keys = [], labels = {};
const calls = () => fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const wait = async (label, test, timeout = 30_000, interval = 100) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const result = await test(); if (result) return result; await new Promise(r => setTimeout(r, interval)); }
  throw new Error(`Timed out: ${label}`);
};
const invoke = (cmd, args = {}) => new Promise((resolve, reject) => {
  const id = ++sequence; replies.set(id, { resolve, reject }); ws.send(JSON.stringify({ t: "invoke", id, cmd, args }));
});
// Same ps RSS / PPID walk and nearest chat-root attribution as memory.rs.
function measure() {
  const table = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8" }).trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
  const roots = new Map(calls().filter(c => c.argv).map(c => [c.pid, c.key]));
  const stack = [[server.pid, null]], seen = new Set(), rows = {};
  while (stack.length) {
    const [pid, inherited] = stack.pop();
    if (seen.has(pid)) continue; seen.add(pid);
    const owner = roots.get(pid) ?? inherited;
    const p = table.find(row => row[0] === pid);
    if (p && owner) { const row = rows[owner] ??= { rssKiB: 0, processes: 0 }; row.rssKiB += p[2]; row.processes++; }
    for (const child of table.filter(row => row[1] === pid)) stack.push([child[0], owner]);
  }
  return rows;
}
const result = { labels, phase: process.argv[4], syntheticProvidersAndExtraMcps: true, serverPid: server.pid };
try {
  await wait("isolated backend", async () => { try { return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch { return false; } });
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ({ data }) => {
    const frame = JSON.parse(data);
    if (frame.t === "event") events.push(frame);
    else if (frame.t === "reply") { const pending = replies.get(frame.id); if (pending) { replies.delete(frame.id); frame.ok ? pending.resolve(frame.result) : pending.reject(new Error(frame.error)); } }
  };
  const project = await invoke("add_workspace", { name: "Footprint fixture", primaryPath: repo });
  const coordinator = "chat:fixture-coordinator", workers = [];
  for (const provider of ["claude", "codex"]) {
    const key = `chat:ordinary-${provider}`; keys.push(key); labels[key] = `ordinary-${provider}`;
    await invoke("chat_start", { key, cwd: ordinary, agent: provider, access: "auto", prompt: "Fixture", turnId: `ordinary-${provider}` });
    // Separate direct roots prevent the fixture workers from sharing a lease.
    const run = await invoke("orchestration_run_create", { actorChatKey: coordinator, objective: "Measure fixture", workspaceId: project.id, rootPath: repo, maxConcurrent: 1, workspaceMode: "direct" });
    const task = await invoke("orchestration_task_create", { actorChatKey: coordinator, runId: run.id, title: "Measure fixture", spec: "Wait", dependsOn: [], worker: { agent: provider, access: "read" } });
    const attempt = await invoke("orchestration_worker_start", { actorChatKey: coordinator, taskId: task.id, agent: provider, access: "read", newWorktree: false });
    keys.push(attempt.workerChatKey); labels[attempt.workerChatKey] = `worker-${provider}`; workers.push(attempt);
  }
  await wait("all four full stops", () => keys.every(key => events.some(e => e.payload?.key === key && ["result", "turn.completed"].includes(e.payload.event?.type))));
  await new Promise(r => setTimeout(r, 1500));
  result.active = measure();
  for (const key of keys) assert.equal(result.active[key]?.processes, after && workers.some(w => w.workerChatKey === key) ? 2 : 5, key);
  for (const worker of workers) await invoke("orchestration_worker_report", { actorChatKey: worker.workerChatKey, attemptId: worker.id, outcome: "completed", summary: "Fixture complete", filesModified: [] });
  await new Promise(r => setTimeout(r, 3500));
  result.settled = measure();
  for (const worker of workers) assert.equal(Boolean(result.settled[worker.workerChatKey]), !after, "settled worker lifetime");
  const idleStarted = Date.now();
  await wait("idle sweep frees every fixture descendant", () => Object.keys(measure()).length === 0, 130_000, 5000);
  result.idleSweepWaitMs = Date.now() - idleStarted;
  result.afterIdleSweep = measure();
  // MCPs have their own pipe lifetime. Check their pids, not just attribution:
  // an orphan stops being counted under the server but still holds memory.
  const mcpPids = calls().filter(c => c.mcp).map(c => c.child);
  const alive = new Set(execFileSync("ps", ["-axo", "pid="], { encoding: "utf8" }).trim().split(/\s+/).map(Number));
  result.orphanMcps = mcpPids.filter(pid => alive.has(pid));
  assert.deepEqual(result.orphanMcps, []);
  result.pass = true;
} catch (error) { result.pass = false; result.error = String(error.stack ?? error); }
finally {
  if (ws?.readyState === WebSocket.OPEN) for (const key of keys) await invoke("chat_stop", { key }).catch(() => {});
  ws?.close(); server.kill("SIGTERM");
  if (server.exitCode === null) await new Promise(resolve => server.once("exit", resolve));
  fs.writeFileSync(path.join(evidence, `${process.argv[4]}.json`), JSON.stringify(result, null, 2));
  // argv has no secrets in this isolated fixture, but don't persist capabilities.
  fs.writeFileSync(path.join(evidence, `${process.argv[4]}-calls.json`), JSON.stringify(calls(), null, 2));
  fs.writeFileSync(path.join(evidence, `${process.argv[4]}-server.log`), serverLog);
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.pass ? 0 : 1;
