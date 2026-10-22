// Real OctiqFlow server/socket and a deterministic Codex app-server stand-in.
// No model calls. The missing tool_name matches Codex 0.163's native metadata.
// node scripts/test-codex-bookkeeping.mjs [octiq-server] [evidence-dir]
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binary = process.argv[2] || path.join(root, "src-tauri/target/debug/octiq-server");
const evidence = process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), "octiq-bookkeeping-evidence-"));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-bookkeeping-"));
const taskHome = path.join(fixture, "home"), bin = path.join(fixture, "bin"), repo = path.join(fixture, "repo");
for (const dir of [taskHome, bin, repo, evidence]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# Isolated Codex fixture\n");
for (const args of [["init", "-q", "-b", "develop"], ["add", "README.md"], ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]]) execFileSync("git", args, { cwd: repo });
const wireLog = path.join(evidence, "wire.jsonl");
function cli() {
  const fs = require("node:fs"), readline = require("node:readline");
  if (process.argv.includes("--version")) { console.log("codex-cli stub"); return; }
  const log = value => fs.appendFileSync(process.env.BOOKKEEPING_WIRE, JSON.stringify(value) + "\n");
  const out = value => { log({ sent: value }); process.stdout.write(JSON.stringify(value) + "\n"); };
  const thread = "thread-fixture", turn = "turn-fixture";
  log({ argv: process.argv.slice(2) });
  let count = 0;
  const tools = ["task_status", "orchestration_worker_report", "vault_agent_memory_append", "orchestration_run_create", "orchestration_validation_create", "orchestration_worker_start"];
  const request = () => {
    const tool = tools[count], id = `approval-${count}`, itemId = `item-${count}`, args = { fixture: count };
    out({ method: "item/started", params: { threadId: thread, turnId: turn, item: { type: "mcpToolCall", id: itemId, server: "octiq", tool, arguments: args, status: "inProgress" } } });
    // Codex suppresses its native confirmation only from configured tool policy.
    // An MCP server can forge elicitation metadata, so never simulate an
    // exemption by emitting a native-looking request for an approved tool.
    if (count < 3) {
      const setting = `mcp_servers.octiq.tools.${tool}.approval_mode="approve"`;
      if (!process.argv.includes(setting)) throw new Error(`Missing policy: ${tool}`);
      out({ method: "item/completed", params: { threadId: thread, turnId: turn, item: { type: "mcpToolCall", id: itemId, server: "octiq", tool, arguments: args, status: "completed", result: { content: [] } } } });
      ++count;
      return request();
    }
    out({ id, method: "mcpServer/elicitation/request", params: { threadId: thread, turnId: turn, serverName: "octiq", mode: "form", message: `Allow the octiq MCP server to run tool "${tool}"?`, requestedSchema: { type: "object", properties: {} }, _meta: { codex_approval_kind: "mcp_tool_call", tool_params: args } } });
    if (count === 5) setTimeout(() => {
      out({ method: "serverRequest/resolved", params: { threadId: thread, requestId: id } });
      out({ method: "item/completed", params: { threadId: thread, turnId: turn, item: { type: "mcpToolCall", id: itemId, server: "octiq", tool, arguments: args, status: "failed", error: { message: "user cancelled MCP tool call" } } } });
    }, 1000);
  };
  readline.createInterface({ input: process.stdin }).on("line", line => {
    const msg = JSON.parse(line); log({ received: msg });
    if (msg.method === "initialize") return out({ id: msg.id, result: { userAgent: "fixture" } });
    if (msg.method === "thread/start" || msg.method === "thread/resume") {
      out({ id: msg.id, result: { thread: { id: thread } } });
      return out({ method: "thread/started", params: { thread: { id: thread, model: "gpt-6.1-sol" } } });
    }
    if (msg.method === "turn/start") {
      out({ id: msg.id, result: { turn: { id: turn } } });
      out({ method: "turn/started", params: { threadId: thread, turn: { id: turn } } });
      return request();
    }
    if (msg.method === "turn/steer") return out({ id: msg.id, result: { turnId: turn } });
    if (msg.id !== `approval-${count}`) return;
    const item = { type: "mcpToolCall", id: `item-${count}`, server: "octiq", tool: tools[count], arguments: { fixture: count }, status: "completed", result: { content: [] } };
    if (msg.result?.action !== "accept") { item.status = "failed"; item.error = { message: "user cancelled MCP tool call" }; }
    out({ method: "item/completed", params: { threadId: thread, turnId: turn, item } });
    if (++count < tools.length) request();
  });
}
fs.writeFileSync(path.join(bin, "codex"), `#!${process.execPath}\n(${cli.toString()})();\n`, { mode: 0o755 });
const shell = path.join(bin, "fixture-shell");
fs.writeFileSync(shell, "#!/bin/sh\nif [ \"$1\" = '-lc' ]; then shift; exec /bin/sh -c \"$@\"; fi\nif [ \"$1\" = '-l' ]; then shift; fi\nexec /bin/sh \"$@\"\n", { mode: 0o755 });
const port = 19000 + Math.floor(Math.random() * 1000), token = "isolated-bookkeeping";
const env = { ...process.env, HOME: taskHome, SHELL: shell, PATH: `${bin}:${process.env.PATH}`, BOOKKEEPING_WIRE: wireLog, OCTIQ_WEB_PORT: String(port), OCTIQ_WEB_TOKEN: token, OCTIQ_CHAT_IDLE_MINS: "0" };
const server = spawn(binary, [], { env, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "", ws, workerKey, sequence = 0;
server.stdout.on("data", data => { serverLog += data; }); server.stderr.on("data", data => { serverLog += data; });
const events = [], replies = new Map();
const wait = async (label, test, ms = 15000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { const value = await test(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(`Timed out: ${label}`);
};
const invoke = (cmd, args = {}) => new Promise((resolve, reject) => {
  const id = ++sequence; replies.set(id, { resolve, reject }); ws.send(JSON.stringify({ t: "invoke", id, cmd, args }));
});
const wire = () => fs.existsSync(wireLog) ? fs.readFileSync(wireLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
try {
  await wait("server", async () => { try { return (await fetch(`http://127.0.0.1:${port}/healthz`)).status === 200; } catch { return false; } });
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ({ data }) => { const f = JSON.parse(data); if (f.t === "event") events.push(f); else if (f.t === "reply") { const p = replies.get(f.id); if (p) { replies.delete(f.id); f.ok ? p.resolve(f.result) : p.reject(new Error(f.error)); } } };
  const project = await invoke("add_workspace", { name: "Bookkeeping fixture", primaryPath: repo });
  const coordinator = "chat:fixture-coordinator";
  const run = await invoke("orchestration_run_create", { actorChatKey: coordinator, objective: "Exercise native confirmations", workspaceId: project.id, rootPath: repo, maxConcurrent: 1, workspaceMode: "direct" });
  const task = await invoke("orchestration_task_create", { actorChatKey: coordinator, runId: run.id, title: "Stub MCP approvals", spec: "No model calls", dependsOn: [], worker: { agent: "codex", model: "gpt-6.1-sol", access: "manual" } });
  const worker = await invoke("orchestration_worker_start", { actorChatKey: coordinator, taskId: task.id, agent: "codex", model: "gpt-6.1-sol", access: "manual", newWorktree: false });
  workerKey = worker.workerChatKey;
  const card = await wait("real permission card", async () => (await invoke("permission_pending")).find(c => c.chatKey === worker.workerChatKey));
  assert.equal(card.provider, "codex"); assert.equal(card.toolName, "mcp__octiq__orchestration_run_create"); assert.equal(card.toolUseId, "item-3");
  assert(!events.some(e => e.event === "permission-ask" && ["item-0", "item-1", "item-2"].includes(e.payload.toolUseId)));
  for (let i = 0; i < 3; i++) assert(!wire().some(w => w.sent?.id === `approval-${i}`));
  // More than the reported 31-second failure: the host keeps a genuine card
  // pending and delivers an answer even after a browser rereads it.
  await new Promise(resolve => setTimeout(resolve, 32000));
  assert((await invoke("permission_pending")).some(c => c.id === card.id));
  await invoke("permission_decide", { id: card.id, decision: "allow", remember: false });
  const next = await wait("next guarded tool", async () => (await invoke("permission_pending")).find(c => c.toolUseId === "item-4"));
  await invoke("permission_decide", { id: next.id, decision: "abstain", remember: false });
  await wait("unanswered reason in model input", () => wire().filter(w => w.received?.method === "turn/steer").length === 2);
  await wait("native cancel explained in transcript", () => events.some(e => e.payload?.event?.item?.id === "item-5" && e.payload.event.item.error?.message.includes("Codex closed the confirmation")));
  assert.equal((await invoke("permission_pending")).length, 0);
  const snapshot = await invoke("orchestration_snapshot", { runId: run.id });
  assert.equal(snapshot.runs[0].coordinatorChatKey, coordinator); assert.equal(snapshot.attempts[0].workerChatKey, worker.workerChatKey);
  for (const options of [undefined, null, []]) {
    const args = { actorChatKey: coordinator, runId: run.id, taskId: task.id, question: "Free text fixture?" };
    if (options !== undefined) args.options = options;
    const gate = await invoke("orchestration_gate_create", args);
    assert.deepEqual(gate.options, []);
    await invoke("orchestration_gate_resolve", { actorChatKey: coordinator, gateId: gate.id, resolution: "Fixture answered", resumeTarget: false });
  }
  const argv = wire().find(w => w.argv).argv.join(" ");
  for (const name of ["task_status", "orchestration_worker_report", "orchestration_message_send", "vault_agent_memory_append"]) assert(argv.includes(`mcp_servers.octiq.tools.${name}.approval_mode=\"approve\"`));
  for (const name of ["orchestration_run_create", "orchestration_validation_create", "orchestration_worker_start", "orchestration_gate_resolve"]) assert(!argv.includes(`mcp_servers.octiq.tools.${name}.approval_mode`));
  fs.writeFileSync(path.join(evidence, "result.json"), JSON.stringify({ pass: true, card, nativeMetadataOmitsToolName: true, heldOver31Seconds: true }, null, 2));
  console.log(`PASS Codex bookkeeping and confirmation lifecycle: ${evidence}`);
} finally {
  fs.writeFileSync(path.join(evidence, "server.log"), serverLog);
  fs.writeFileSync(path.join(evidence, "events.json"), JSON.stringify(events, null, 2));
  if (ws) { try { if (workerKey) await invoke("chat_stop", { key: workerKey }); } catch {} ws.close(); }
  server.kill("SIGTERM");
  await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once("exit", resolve); });
  fs.rmSync(fixture, { recursive: true, force: true });
}
