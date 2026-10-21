// Real server/socket/queue/recovery, deterministic stub CLI providers. No model
// calls or account credits. Fixtures and their home are removed on every exit.
// Usage: node scripts/test-provider-failover.mjs [octiq-server] [evidence-dir]
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceProvider = process.argv[4] || "claude";
const targetProvider = sourceProvider === "claude" ? "codex" : "claude";
const sourceModel = sourceProvider === "claude" ? "opus" : "gpt-5.6-sol";
const targetModel = targetProvider === "claude" ? "opus" : "gpt-5.6-sol";
const marker = sourceProvider === "claude" ? "TRIGGER_LIMIT" : "TRIGGER_CODEX_LIMIT";
const binary = process.argv[2] || path.join(root, "src-tauri/target/debug/octiq-server");
const evidence = process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), "octiq-failover-evidence-"));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-failover-"));
const taskHome = path.join(fixture, "home"), bin = path.join(fixture, "bin"), repo = path.join(fixture, "repo");
const mainRepo = path.join(fixture, "ordinary");
fs.mkdirSync(mainRepo);
const log = path.join(fixture, "calls.jsonl");
const port = 18000 + Math.floor(Math.random() * 1000), token = "isolated-failover-test";
for (const folder of [taskHome, bin, repo, evidence]) fs.mkdirSync(folder, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# Failover fixture\n");
for (const args of [["init", "-q", "-b", "develop"], ["add", "README.md"], ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]]) execFileSync("git", args, { cwd: repo });

function cli() {
  const fs = require("node:fs"), readline = require("node:readline");
  const provider = require("node:path").basename(process.argv[1]);
  const log = (data) => fs.appendFileSync(process.env.FAILOVER_TEST_LOG, JSON.stringify({ provider, pid: process.pid, ...data }) + "\n");
  const out = (data) => process.stdout.write(JSON.stringify(data) + "\n");
  if (process.argv.includes("--version")) { console.log("stub 1.0.0"); return; }
  if (process.argv.includes("models")) { console.log("[]"); return; }
  const thread = `new-${provider}-${process.pid}`;
  log({ argv: process.argv.slice(2), cwd: process.cwd(), attempt: process.env.OCTIQ_ORCHESTRATION_ATTEMPT });
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (provider === "codex") {
      if (msg.method === "initialize") return out({ id: msg.id, result: { userAgent: "fixture" } });
      if (msg.method === "thread/start" || msg.method === "thread/resume") {
        log({ method: msg.method, params: msg.params });
        out({ id: msg.id, result: { thread: { id: thread } } });
        return out({ method: "thread/started", params: { thread: { id: thread, model: "gpt-5.6-sol" } } });
      }
      if (msg.method === "turn/start") {
        log({ method: msg.method, params: msg.params });
        out({ id: msg.id, result: { turn: { id: "turn-test" } } });
        out({ method: "turn/started", params: { threadId: thread, turn: { id: "turn-test" } } });
        if (JSON.stringify(msg.params.input).includes("TRIGGER_CODEX_LIMIT")) {
          return out({ method: "turn/completed", params: { threadId: thread, turn: { id: "turn-test", status: "failed", error: { message: "Usage limit reached" } } } });
        }
        out({ method: "item/completed", params: { threadId: thread, item: { id: "answer", type: "agentMessage", text: "Continued without repeating previous work." } } });
        return out({ method: "turn/completed", params: { threadId: thread, turn: { id: "turn-test", status: "completed" } } });
      }
      return;
    }
    if (msg.type === "control_request") return out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: {} } });
    if (msg.type !== "user") return;
    const text = JSON.stringify(msg.message?.content ?? "");
    log({ text });
    out({ type: "system", subtype: "init", session_id: thread, model: "opus", tools: [] });
    if (text.includes("TRIGGER_LIMIT")) {
      out({ type: "result", subtype: "error_during_execution", is_error: true, session_id: thread, result: "You've hit your session limit", quotaLimits: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 3600 } });
    } else {
      out({ type: "assistant", session_id: thread, message: { role: "assistant", content: [{ type: "text", text: "Ready for the next instruction." }] } });
      out({ type: "result", subtype: "success", session_id: thread, is_error: false, result: "Ready" });
    }
  });
}
for (const provider of ["claude", "codex"]) fs.writeFileSync(path.join(bin, provider), `#!${process.execPath}\n(${cli.toString()})();\n`, { mode: 0o755 });
// A non-login shell keeps the fixture CLIs first, independent of local dotfiles.
const shell = path.join(bin, "fixture-shell");
fs.writeFileSync(shell, "#!/bin/sh\nif [ \"$1\" = '-lc' ]; then shift; exec /bin/sh -c \"$@\"; fi\nif [ \"$1\" = '-l' ]; then shift; fi\nexec /bin/sh \"$@\"\n", { mode: 0o755 });
const env = { ...process.env, HOME: taskHome, SHELL: shell, PATH: `${bin}:${process.env.PATH}`, FAILOVER_TEST_LOG: log,
  OCTIQ_WEB_PORT: String(port), OCTIQ_WEB_TOKEN: token, OCTIQ_CHAT_IDLE_MINS: "0" };
const server = spawn(binary, [], { env, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "", ws, sequence = 0;
server.stdout.on("data", (data) => { serverLog += data; }); server.stderr.on("data", (data) => { serverLog += data; });
const events = [], replies = new Map(), results = {};
const calls = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const wait = async (label, test, timeout = 45_000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = await test(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${label}`);
};
const invoke = (cmd, args = {}) => new Promise((resolve, reject) => {
  const id = ++sequence; replies.set(id, { resolve, reject }); ws.send(JSON.stringify({ t: "invoke", id, cmd, args }));
});
try {
  await wait("server", async () => { try { return (await fetch(`http://127.0.0.1:${port}/`)).status === 200; } catch { return false; } });
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ({ data }) => { const frame = JSON.parse(data); if (frame.t === "event") events.push(frame); else if (frame.t === "reply") { const pending = replies.get(frame.id); if (pending) { replies.delete(frame.id); frame.ok ? pending.resolve(frame.result) : pending.reject(new Error(frame.error)); } } };
  const project = await invoke("add_workspace", { name: "Failover fixture", primaryPath: repo });
  const coordinator = "chat:quota-coordinator";
  const run = await invoke("orchestration_run_create", { actorChatKey: coordinator, objective: "Preserve the current worker", workspaceId: project.id, rootPath: repo, maxConcurrent: 1, workspaceMode: "direct" });
  const task = await invoke("orchestration_task_create", { actorChatKey: coordinator, runId: run.id, title: "Keep the checkout", spec: "Wait for an instruction.", dependsOn: [], worker: { agent: sourceProvider, model: sourceModel, effort: "xhigh", access: "manual" } });
  const worker = await invoke("orchestration_worker_start", { actorChatKey: coordinator, taskId: task.id, agent: sourceProvider, model: sourceModel, effort: "xhigh", access: "manual", newWorktree: false });
  await wait("first worker turn", () => events.some((e) => e.event === "chat-event" && e.payload.key === worker.workerChatKey && ["result", "turn.completed"].includes(e.payload.event.type)));
  await invoke("chat_start", { key: "chat:quota-main", cwd: mainRepo, agent: sourceProvider, model: sourceModel, effort: "xhigh", access: "auto", prompt: `${marker}: preserve this original request.`, turnId: "main-original" });
  await wait("durable switch scheduled", () => events.some((e) => e.payload?.event?.type === "octiq_auto_resume_scheduled"));
  await invoke("orchestration_message_send", { actorChatKey: coordinator, runId: run.id, to: worker.id, kind: "instruction", subject: "Continue", body: `${marker}: continue this same task.` });
  const next = await wait("worker switched after quota", async () => (await invoke("orchestration_snapshot", { runId: run.id })).attempts.find((a) => a.number === 2 && a.agent === targetProvider));
  assert.equal(next.access, "manual"); assert.equal(next.model, targetModel); assert.equal(next.effort, "xhigh");
  assert.equal(next.execution.providerOrigin.agent, sourceProvider);
  await wait("worker uses retained checkout", async () => { const snapshot = await invoke("orchestration_snapshot", { runId: run.id }); return snapshot.attempts.find((a) => a.id === next.id && a.cwd === worker.cwd); });
  await wait("ordinary conversation switched", () => events.some((e) => e.event === "chat-provider-switch" && e.payload.key === "chat:quota-main"));
  results.worker = { before: worker, after: next };
  const starts = await wait("both replacement processes actually start", () => {
    const starts = calls().filter((c) => c.provider === targetProvider && (targetProvider === "codex" ? c.method === "thread/start" : c.argv));
    return starts.length >= 2 && starts;
  });
  assert.equal(starts.length, 2);
  if (targetProvider === "codex") {
    assert(!calls().some((c) => c.method === "thread/resume"));
    for (const start of starts) { assert.equal(start.params.sandbox, "workspace-write"); assert.equal(start.params.approvalPolicy, "on-request"); assert.equal(start.params.config.model_reasoning_effort, "xhigh"); }
  } else {
    assert(starts.some((start) => start.argv[start.argv.indexOf("--permission-mode") + 1] === "manual"));
    for (const start of starts) { assert.equal(start.argv[start.argv.indexOf("--model") + 1], "opus"); assert.equal(start.argv[start.argv.indexOf("--effort") + 1], "xhigh"); assert(!start.argv.includes("--resume")); }
  }
  await wait("original context reaches the replacement", () => calls().some((c) => c.provider === targetProvider && JSON.stringify(c.params ?? c.text ?? "").includes("preserve this original request")));
  results.pass = true; results.worker = { before: worker, after: next }; results.replacementStarts = starts;
} catch (error) { results.pass = false; results.error = String(error.stack ?? error); if (ws?.readyState === WebSocket.OPEN) results.snapshot = await invoke("orchestration_snapshot", {}); }
finally {
  fs.writeFileSync(path.join(evidence, "result.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(evidence, "server.log"), serverLog);
  fs.writeFileSync(path.join(evidence, "cli-calls.json"), JSON.stringify(calls(), null, 2));
  ws?.close(); server.kill("SIGTERM");
  await new Promise((resolve) => { if (server.exitCode !== null) resolve(); else server.once("exit", resolve); });
  fs.rmSync(fixture, { recursive: true, force: true });
}
console.log(JSON.stringify({ pass: results.pass, evidence, error: results.error }, null, 2));
process.exit(results.pass ? 0 : 1);
