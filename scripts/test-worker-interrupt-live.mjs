// Live check for feedback 240ea516: a coordinator's
// `orchestration_message_send` with `interrupt: true` cuts a busy Claude
// worker's turn, the attempt STAYS ACTIVE, and the message opens the worker's
// next turn. Before the fix the call answered "interrupted" and the host then
// failed the attempt on the cut-off turn's own full stop
// (`Provider request failed ["[ede_diagnostic] … stop_reason=tool_use"]`).
//
// Evidence class: STUB PROVIDER, REAL SERVER, REAL CAPTURED STREAM. A real
// octiq-server runs in a throwaway HOME with a stand-in `claude` first on
// PATH. The stand-in says nothing of its own: it replays
// web/src/lib/__fixtures__/claude-interrupted-tool.jsonl, a verbatim
// `claude -p` 2.1.292 stream interrupted while a Bash call ran, in the three
// parts a real process sends them: the turn up to the tool call when its
// first message arrives, the cancelled call and the failed `result` when the
// server's interrupt arrives, and the second turn when the next message
// does. Only each replayed prompt's text is swapped for what the server
// actually wrote. What this shows: the server's own interrupt, reader,
// ledger and delivery, against the bytes Claude really sends. Not shown: a
// model, or how long a real tool takes to stop.
//
//   cd src-tauri && cargo build --bin octiq-server && cd ..
//   node scripts/test-worker-interrupt-live.mjs [path/to/octiq-server] [evidence-dir]
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SERVER = process.argv[2] || path.join(ROOT, "src-tauri/target/debug/octiq-server");
const OUT = process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), "octiq-interrupt-evidence-"));
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-interrupt-"));
const HOME = path.join(DIR, "home");
const BIN = path.join(DIR, "bin");
const LOG = path.join(DIR, "stub.log");
const FIXTURE = path.join(ROOT, "web/src/lib/__fixtures__/claude-interrupted-tool.jsonl");
const PORT = 17000 + Math.floor(Math.random() * 1000);
const TOKEN = "interrupt-token";
const COORD = "chat:coord-interrupt";
const ORDER = "Stop the render and wait for the new brief.";
fs.mkdirSync(OUT, { recursive: true });

function stubClaude() {
  const fs = require("fs");
  const readline = require("readline");
  const log = (entry) => fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ at: Date.now(), pid: process.pid, ...entry }) + "\n");
  const lines = fs.readFileSync(process.env.STUB_FIXTURE, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const isCall = (e) => e.type === "assistant" && e.message?.content?.[0]?.type === "tool_use";
  const called = lines.findIndex(isCall);
  const cut = lines.findIndex((e) => e.type === "result");
  // The recording's own answer to its interrupt is replaced by one to ours.
  const parts = {
    working: lines.slice(0, called + 1),
    cutOff: lines.slice(called + 1, cut + 1).filter((e) => e.type !== "control_response"),
    next: lines.slice(cut + 1),
  };
  const out = (event) => process.stdout.write(JSON.stringify(event) + "\n");
  const replay = (part, said) => {
    for (const event of parts[part]) {
      if (event.type === "user" && event.isReplay && said !== undefined) {
        out({ ...event, message: { ...event.message, content: said } });
      } else {
        out(event);
      }
    }
    log({ replayed: part });
  };
  let turns = 0;
  log({ argv: process.argv.slice(2) });
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === "control_request" && msg.request?.subtype === "initialize") {
      out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: {} } });
      return;
    }
    if (msg.type === "control_request" && msg.request?.subtype === "interrupt") {
      log({ interrupt: msg.request_id, turns });
      out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: { still_queued: [] } } });
      if (turns === 1) replay("cutOff");
      return;
    }
    if (msg.type === "user") {
      turns += 1;
      const said = msg.message?.content;
      log({ turn: turns, userText: JSON.stringify(said ?? "").slice(0, 4000) });
      if (turns === 1) replay("working", said);
      else if (turns === 2) replay("next", said);
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
  OCTIQ_CHAT_IDLE_MINS: "0", PATH: `${BIN}:${process.env.PATH}`, STUB_LOG: LOG, STUB_FIXTURE: FIXTURE };
for (const name of ["OCTIQ_CHAT_KEY", "OCTIQ_SESSION_KEY", "OCTIQ_LAUNCH_ID", "OCTIQ_CHAT_CAPABILITY", "OCTIQ_HOOK_PORT", "OCTIQ_ROOT"]) {
  delete ENV[name];
}
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
let ws;
let seq = 0;
const replies = new Map();
const invoke = (cmd, args = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  replies.set(id, { resolve, reject });
  ws.send(JSON.stringify({ t: "invoke", id, cmd, args }));
});

const results = { server: SERVER };
try {
  await wait("server", async () => {
    try { return (await fetch(`http://127.0.0.1:${PORT}/`)).status > 0; } catch { return false; }
  });
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (m) => {
    const frame = JSON.parse(m.data);
    if (frame.t !== "reply") return;
    const waiting = replies.get(frame.id);
    if (!waiting) return;
    replies.delete(frame.id);
    frame.ok ? waiting.resolve(frame.result) : waiting.reject(new Error(frame.error));
  };
  const project = await invoke("add_workspace", { name: "Fixture", primaryPath: repo });
  const run = await invoke("orchestration_run_create", { actorChatKey: COORD, objective: "Render, then be redirected",
    workspaceId: project.id, rootPath: repo, maxConcurrent: 1, workspaceMode: "direct" });
  const task = await invoke("orchestration_task_create", { actorChatKey: COORD, runId: run.id, dependsOn: [],
    title: "Render the scene", spec: "Run the long render." });
  await invoke("orchestration_worker_start", { actorChatKey: COORD, taskId: task.id, agent: "claude", model: "sonnet",
    access: "auto", newWorktree: false });
  const attempt = async () => (await invoke("orchestration_snapshot", { runId: run.id })).attempts.find((a) => a.taskId === task.id);
  const taskNow = async () => (await invoke("orchestration_snapshot", { runId: run.id })).tasks.find((t) => t.id === task.id);

  // 1. The worker is inside one long tool call.
  const working = await wait("the worker to be mid tool call",
    async () => { const a = await attempt(); return a && Object.keys(a.execution.pendingTools ?? {}).length === 1 ? a : null; }, 60_000);
  results.working = { status: working.status, state: working.execution.state, tools: Object.values(working.execution.pendingTools) };
  assert.equal(working.status, "running");
  assert.equal(working.execution.state, "waiting_tool");

  // 2. The coordinator interrupts it with an instruction.
  const sent = await invoke("orchestration_message_send", { actorChatKey: COORD, runId: run.id, to: working.id,
    kind: "instruction", subject: "Pause", body: ORDER, interrupt: true });
  results.interrupt = sent.interrupt;
  assert.equal(sent.interrupt, "interrupted");
  await wait("the cut-off turn's full stop", async () => stub().some((e) => e.replayed === "cutOff"));

  // 3. The message opens the worker's next turn, on the same attempt.
  const second = await wait("the instruction to open the next turn",
    async () => stub().find((e) => e.turn === 2), 60_000);
  results.nextTurnCarriesTheInstruction = second.userText.includes(ORDER);
  assert.ok(results.nextTurnCarriesTheInstruction, second.userText);
  await wait("the next turn's full stop", async () => stub().some((e) => e.replayed === "next"));

  // 4. The failure used to land seconds later: give it longer than that.
  await new Promise((r) => setTimeout(r, 8_000));
  const after = await attempt();
  const snapshot = await invoke("orchestration_snapshot", { runId: run.id });
  results.after = { attemptId: after.id, sameAttempt: after.id === working.id, status: after.status,
    state: after.execution.state, latestError: after.execution.latestError ?? null,
    pendingTools: Object.keys(after.execution.pendingTools ?? {}).length, task: (await taskNow()).status,
    attempts: snapshot.attempts.filter((a) => a.taskId === task.id).length,
    toldCoordinator: snapshot.notifications.filter((n) => n.targetChatKey === COORD).map((n) => n.kind),
    interrupts: stub().filter((e) => e.interrupt).length, workerProcesses: stub().filter((e) => e.argv).length };
  assert.equal(after.id, working.id);
  assert.equal(after.status, "running", JSON.stringify(after.execution.latestError));
  assert.equal(after.execution.latestError ?? null, null);
  assert.equal(results.after.pendingTools, 0);
  assert.equal(results.after.task, "running");
  assert.equal(results.after.attempts, 1, "no retry was needed");
  assert.deepEqual(results.after.toldCoordinator, [], "the coordinator is not told its interrupt failed the worker");
  assert.equal(results.after.interrupts, 1);
  assert.equal(results.after.workerProcesses, 1, "the same process went on");
  results.pass = true;
} catch (error) {
  results.pass = false;
  results.error = String(error?.stack ?? error);
  try {
    const snapshot = await invoke("orchestration_snapshot", {});
    results.atFailure = { attempts: snapshot.attempts.map((a) => ({ id: a.id, status: a.status, state: a.execution.state, latestError: a.execution.latestError })),
      notifications: snapshot.notifications.map((n) => ({ to: n.targetChatKey, kind: n.kind, state: n.state, body: n.body.slice(0, 300) })) };
  } catch {}
} finally {
  results.stub = stub().map(({ at, pid, argv, ...rest }) => (argv ? { launched: true } : rest));
  fs.writeFileSync(path.join(OUT, "worker-interrupt.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(OUT, "worker-interrupt-server.log"), serverLog);
  ws?.close();
  server.kill("SIGTERM");
}
console.log(JSON.stringify({ pass: results.pass, evidence: OUT, interrupt: results.interrupt, after: results.after, atFailure: results.atFailure, error: results.error }, null, 2));
process.exit(results.pass ? 0 : 1);
