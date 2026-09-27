// Live check for d59f830a's supported route: a worker started with Manual
// access asks the person before each command, through OctiqFlow's own
// permission card, and a declined command does not run — not then, and not
// later unless a NEW ask is approved.
//
// Evidence class: STUB PROVIDER through a real octiq-server (throwaway HOME).
// The stand-in `claude` asks over the stdio permission channel exactly as a
// real `claude -p --permission-mode manual --permission-prompt-tool stdio`
// does (checked separately against claude 2.1.281 with a harmless mkdir), and
// runs its one harmless command only on an `allow`. What this shows: the
// launch flag, the ask reaching the person with the exact command, deny ⇒
// nothing ran, and a later allow needing its own ask. Not shown: a model.
//
//   cd src-tauri && cargo build --bin octiq-server && cd ..
//   node scripts/test-manual-worker-asks.mjs [path/to/octiq-server] [evidence-dir]
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SERVER = process.argv[2] || path.join(ROOT, "src-tauri/target/debug/octiq-server");
const OUT = process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), "octiq-manual-evidence-"));
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-manual-"));
const HOME = path.join(DIR, "home");
const BIN = path.join(DIR, "bin");
const LOG = path.join(DIR, "stub.log");
const PORT = 16000 + Math.floor(Math.random() * 1000);
const TOKEN = "manual-token";
const COORD = "chat:coord-manual";
fs.mkdirSync(OUT, { recursive: true });

function stubClaude() {
  const fs = require("fs");
  const path = require("path");
  const readline = require("readline");
  const log = (entry) => fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ at: Date.now(), pid: process.pid, ...entry }) + "\n");
  const argv = process.argv.slice(2);
  log({ argv, cwd: process.cwd() });
  const out = (event) => process.stdout.write(JSON.stringify({ session_id: "stub-" + process.pid, ...event }) + "\n");
  let n = 0;
  const waiting = new Map();
  const turn = () => {
    const id = "toolu_" + process.pid + "_" + ++n;
    const command = "mkdir manual-probe";
    out({ type: "system", subtype: "init", model: "stub", tools: ["Bash"] });
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
    const request = "req_" + id;
    waiting.set(request, (answer) => {
      log({ answer: answer.behavior, id });
      if (answer.behavior === "allow") {
        fs.mkdirSync(path.join(process.cwd(), "manual-probe"), { recursive: true });
        log({ ran: id });
        out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "" }] } });
      } else {
        out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: answer.message || "denied" }] } });
      }
      const said = answer.behavior === "allow" ? "Created manual-probe." : "The person declined mkdir; I did not run it.";
      out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: said }] } });
      out({ type: "result", subtype: "success", is_error: false, result: said, duration_ms: 1, num_turns: 1 });
    });
    out({ type: "control_request", request_id: request, request: { subtype: "can_use_tool", tool_name: "Bash", input: { command }, tool_use_id: id } });
  };
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === "control_request" && msg.request?.subtype === "initialize") {
      out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: {} } });
      return;
    }
    if (msg.type === "control_response") {
      const done = waiting.get(msg.response?.request_id);
      waiting.delete(msg.response?.request_id);
      done?.(msg.response?.response ?? {});
      return;
    }
    if (msg.type === "user") {
      log({ userText: JSON.stringify(msg.message?.content ?? "").slice(0, 300) });
      turn();
    }
  });
}

fs.mkdirSync(BIN, { recursive: true });
fs.writeFileSync(path.join(BIN, "claude"), `#!/usr/bin/env node\n(${stubClaude.toString()})();\n`, { mode: 0o755 });
const repo = path.join(HOME, "code", "fixture");
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n");
execFileSync("git", ["init", "-q", "-b", "develop"], { cwd: repo });
execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", "add", "README.md"], { cwd: repo });
execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "-m", "fixture"], { cwd: repo });

const ENV = { ...process.env, HOME, SHELL: "/bin/zsh", OCTIQ_WEB_PORT: String(PORT), OCTIQ_WEB_TOKEN: TOKEN,
  OCTIQ_CHAT_IDLE_MINS: "0", PATH: `${BIN}:${process.env.PATH}`, STUB_LOG: LOG };
const stub = () => fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
const wait = async (what, test, ms = 30_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const got = await test();
    if (got) return got;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
};

let serverLog = "";
const server = spawn(SERVER, [], { env: ENV, stdio: ["ignore", "pipe", "pipe"] });
server.stdout.on("data", (d) => { serverLog += d; });
server.stderr.on("data", (d) => { serverLog += d; });
const events = [];
let ws;
let seq = 0;
const replies = new Map();
const invoke = (cmd, args = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  replies.set(id, { resolve, reject });
  ws.send(JSON.stringify({ t: "invoke", id, cmd, args }));
});

const results = {};
try {
  await wait("server", async () => {
    try { return (await fetch(`http://127.0.0.1:${PORT}/`)).status > 0; } catch { return false; }
  });
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (m) => {
    const frame = JSON.parse(m.data);
    if (frame.t === "reply") {
      const waiting = replies.get(frame.id);
      if (!waiting) return;
      replies.delete(frame.id);
      frame.ok ? waiting.resolve(frame.result) : waiting.reject(new Error(frame.error));
    } else if (frame.t === "event") events.push(frame);
  };
  const asks = () => events.filter((e) => e.event === "permission-ask");
  const probe = path.join(repo, "manual-probe");

  const project = await invoke("add_workspace", { name: "Fixture", primaryPath: repo });
  const run = await invoke("orchestration_run_create", { actorChatKey: COORD, objective: "Run one command with approval",
    workspaceId: project.id, rootPath: repo, maxConcurrent: 1, workspaceMode: "direct" });
  const task = await invoke("orchestration_task_create", { actorChatKey: COORD, runId: run.id, dependsOn: [],
    title: "Make a directory", spec: "Run mkdir manual-probe." });
  await invoke("orchestration_worker_start", { actorChatKey: COORD, taskId: task.id, agent: "claude", model: "sonnet",
    access: "manual", newWorktree: false });

  // 1. The ask reaches the person, naming the exact command. Decline it.
  const first = await wait("the first ask", async () => asks()[0], 60_000);
  const worker = (await invoke("orchestration_snapshot", { runId: run.id })).attempts.find((a) => a.taskId === task.id);
  const launch = stub().find((e) => e.argv);
  results.launch = { permissionMode: launch.argv[launch.argv.indexOf("--permission-mode") + 1],
    promptTool: launch.argv[launch.argv.indexOf("--permission-prompt-tool") + 1] };
  results.firstAsk = { chatKey: first.payload.chatKey, tool: first.payload.toolName, input: first.payload.toolInput };
  assert.equal(results.launch.permissionMode, "manual");
  assert.equal(results.launch.promptTool, "stdio");
  assert.equal(results.firstAsk.chatKey, worker.workerChatKey);
  assert.equal(results.firstAsk.tool, "Bash");
  assert.equal(results.firstAsk.input.command, "mkdir manual-probe");
  await invoke("permission_decide", { id: first.payload.id, decision: "deny" });
  await wait("the declined turn to end", async () => stub().some((e) => e.answer === "deny"));
  await new Promise((r) => setTimeout(r, 1500));
  results.afterDeny = { ran: stub().filter((e) => e.ran).length, exists: fs.existsSync(probe), asks: asks().length };
  assert.equal(results.afterDeny.ran, 0, "declined: nothing ran");
  assert.equal(results.afterDeny.exists, false);
  assert.equal(results.afterDeny.asks, 1, "nothing re-asked or replayed by itself");

  // 2. Only a new turn, and a new ask the person approves, runs it.
  await invoke("orchestration_message_send", { actorChatKey: COORD, runId: run.id, to: worker.id, kind: "instruction",
    subject: "Try again", body: "The person will approve the mkdir now." });
  const second = await wait("a second, separate ask", async () => asks()[1], 60_000);
  assert.notEqual(second.payload.id, first.payload.id);
  await invoke("permission_decide", { id: second.payload.id, decision: "allow" });
  await wait("the approved command", async () => stub().some((e) => e.ran));
  results.afterAllow = { ran: stub().filter((e) => e.ran).length, exists: fs.existsSync(probe), asks: asks().length };
  assert.equal(results.afterAllow.ran, 1);
  assert.equal(results.afterAllow.exists, true);
  results.pass = true;
} catch (error) {
  results.pass = false;
  results.error = String(error?.stack ?? error);
} finally {
  fs.writeFileSync(path.join(OUT, "manual-worker-asks.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(OUT, "manual-server.log"), serverLog);
  ws?.close();
  server.kill("SIGTERM");
}
console.log(JSON.stringify({ pass: results.pass, evidence: OUT, error: results.error }, null, 2));
process.exit(results.pass ? 0 : 1);
