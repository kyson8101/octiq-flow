// Live regression: a command Claude's auto mode refused is never run on the
// strength of anything OctiqFlow does afterwards.
//
// "Allow this exact command once" used to add `--allowedTools Bash(<line>)` to
// the chat's next launch and end the process after a call used it. A rule
// lasts as long as the process and matches every call of the line, and the
// host sees a call only after Claude has emitted it: a real claude 2.1.281 ran
// one rule's line twice in a single response (review of aca0f66). The grant is
// withdrawn; this checks, by COUNTING RUNS of a harmless command, that nothing
// runs the refused line — in one turn (repeated and parallel calls), across
// turns, across a relaunch, and after a server restart with a stale grant
// request replayed from an old page. It also checks that a queued message and
// native background work are left alone now that nothing ends the process.
//
// Evidence class: STUB PROVIDER. A real octiq-server runs in a throwaway HOME
// with a stand-in `claude` first on PATH; no model is involved. The stand-in
// runs a Bash call (one line appended to a counter file) only when a
// `--allowedTools` rule on its own argv names exactly that line, and otherwise
// reports an auto-mode refusal. That is the permission behaviour the real
// provider showed; the control case proves the counter is not vacuous by
// giving the stand-in the old rule directly. What this does NOT show: how a
// real classifier decides, or anything about a real model's choices.
//
//   cd src-tauri && cargo build --bin octiq-server && cd ..
//   node scripts/test-claude-refusal-no-grant.mjs [path/to/octiq-server]
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SERVER = process.argv[2] || path.join(ROOT, "src-tauri/target/debug/octiq-server");
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-refusal-"));
const HOME = path.join(DIR, "home");
const BIN = path.join(DIR, "bin");
const LOG = path.join(DIR, "stub.log");
const COUNTER = path.join(DIR, "ran.txt");
const PORT = 14000 + Math.floor(Math.random() * 1000);
const TOKEN = "refusal-token";
const LINE = "node ran.js";
const RULE = `Bash(${LINE})`;

// The stand-in for `claude -p --input-format stream-json`.
//   CALL<n>  -> n calls of LINE in ONE assistant message (parallel tool use)
//   SEQ<n>   -> n calls of LINE, one message each, in the same turn
//   HOLD     -> keep the turn open 1.5 s before its full stop
//   BG       -> start native background work first
// A call runs (appends to COUNTER) only when this process's argv carries an
// exact `Bash(LINE)` rule; otherwise it is refused as auto mode refuses.
function stubClaude() {
  const fs = require("fs");
  const readline = require("readline");
  const LINE = "node ran.js";
  const log = (entry) => fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ at: Date.now(), pid: process.pid, ...entry }) + "\n");
  const argv = process.argv.slice(2);
  log({ argv });
  const rules = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--allowedTools") continue;
    for (let j = i + 1; j < argv.length && !argv[j].startsWith("--"); j++) {
      if (argv[j].startsWith("Bash(")) rules.push(argv[j]);
      else rules.push(...argv[j].split(/\s+/).filter((w) => w && w !== "\\"));
    }
  }
  const resumed = argv.indexOf("--resume");
  const session = resumed >= 0 ? argv[resumed + 1] : "stub-" + process.pid;
  const out = (event) => process.stdout.write(JSON.stringify({ session_id: session, ...event }) + "\n");
  out({ type: "system", subtype: "init", model: "stub", tools: [] });
  let n = 0;
  const finish = (said) => {
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: said }] } });
    out({ type: "result", subtype: "success", is_error: false, result: said, duration_ms: 1, num_turns: 1 });
  };
  const calls = (count) => {
    const ids = Array.from({ length: count }, () => "toolu_" + process.pid + "_" + ++n);
    out({ type: "assistant", message: { role: "assistant", content: ids.map((id) => ({ type: "tool_use", id, name: "Bash", input: { command: LINE } })) } });
    for (const id of ids) {
      if (rules.includes(`Bash(${LINE})`)) {
        fs.appendFileSync(process.env.STUB_COUNTER, `${process.pid} ${id}\n`);
        log({ ran: id });
        out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
      } else {
        log({ refused: id });
        out({ type: "system", subtype: "permission_denied", tool_name: "Bash", tool_use_id: id, decision_reason: "[Production Deploy]",
          decision_reason_type: "classifier", message: "Permission for this action was denied by the Claude Code auto mode classifier." });
      }
    }
  };
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === "control_request" && msg.request?.subtype === "initialize") {
      out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: {} } });
      return;
    }
    if (msg.type !== "user") return;
    const text = JSON.stringify(msg.message?.content ?? "");
    log({ userText: text.slice(0, 2000) });
    if (text.includes("BG")) {
      out({ type: "system", subtype: "task_started", task_id: "bg-agent-1", task_type: "local_agent", description: "background checker" });
    }
    const par = /CALL(\d+)/.exec(text);
    if (par) calls(Number(par[1]));
    const seq = /SEQ(\d+)/.exec(text);
    if (seq) for (let i = 0; i < Number(seq[1]); i++) calls(1);
    if (text.includes("HOLD")) setTimeout(() => finish("held"), 1500);
    else finish("done");
  });
}

fs.mkdirSync(BIN, { recursive: true });
const STUB = path.join(BIN, "claude");
fs.writeFileSync(STUB, `#!/usr/bin/env node\n(${stubClaude.toString()})();\n`, { mode: 0o755 });
const repo = path.join(HOME, "code", "alpha");
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# alpha\n");
execFileSync("git", ["init", "-q", "-b", "develop"], { cwd: repo });

const ENV = { ...process.env, HOME, SHELL: "/bin/zsh", OCTIQ_WEB_PORT: String(PORT), OCTIQ_WEB_TOKEN: TOKEN,
  OCTIQ_CHAT_IDLE_MINS: "0", PATH: `${BIN}:${process.env.PATH}`, STUB_LOG: LOG, STUB_COUNTER: COUNTER };

const ran = () => fs.existsSync(COUNTER) ? fs.readFileSync(COUNTER, "utf8").trim().split("\n").filter(Boolean).length : 0;
const stub = () => fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const wait = async (what, test, ms = 30_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const got = await test();
    if (got) return got;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
};

// Control: the stand-in given the withdrawn rule directly runs the line once
// per call, so a count of zero below is a real "did not run".
async function control() {
  const before = ran();
  const child = spawn(STUB, ["-p", "--input-format", "stream-json", "--allowedTools", RULE], { env: ENV, stdio: ["pipe", "pipe", "inherit"] });
  child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: "CALL2 SEQ1" } }) + "\n");
  await wait("control turn", async () => stub().some((e) => e.pid === child.pid && e.ran) && ran() - before >= 3, 10_000);
  child.kill();
  return ran() - before;
}

let server;
let serverLog = "";
function startServer() {
  server = spawn(SERVER, [], { env: ENV, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => { serverLog += d; });
  server.stderr.on("data", (d) => { serverLog += d; });
}

const events = [];
let ws;
let seq = 0;
const replies = new Map();
const invoke = (cmd, args = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  replies.set(id, { resolve, reject });
  ws.send(JSON.stringify({ t: "invoke", id, cmd, args }));
});
async function connect() {
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
}

const results = {};
const key = "chat:refusal";
const base = { key, cwd: repo, agent: "claude", model: "sonnet", access: "auto", useSandbox: false };
const cards = () => events.filter((e) => e.event === "safety-blocked" && e.payload.chatKey === key);
const fullStops = () => events.filter((e) => e.event === "chat-event" && e.payload.key === key && e.payload.event?.type === "result").length;
const launches = () => stub().filter((e) => e.argv && e.argv.includes("--input-format") && e.argv.includes("--mcp-config"));

try {
  results.control = await control();
  assert.equal(results.control, 3, "control: the stand-in given an allow rule runs every matching call");
  fs.rmSync(COUNTER, { force: true });

  startServer();
  await connect();
  const project = await invoke("add_workspace", { name: "Alpha", primaryPath: repo });
  await invoke("chat_index_save", { meta: { id: "refusal", projectId: project.id, title: "refusal", customTitle: true, cwd: repo,
    modelId: "claude:sonnet", access: "auto", createdAt: Date.now(), updatedAt: Date.now(), generation: 0 } });

  // 1. The refusal: a card, and nothing ran.
  await invoke("chat_start", { ...base, prompt: "CALL1", turnId: "user-1" });
  const card = await wait("safety card", async () => cards()[0]);
  const first = launches()[0];
  results.refused = { ran: ran(), card: card.payload.title, exactGrant: card.payload.exactGrant ?? null };
  assert.equal(ran(), 0);
  assert.equal(card.payload.exactGrant, undefined, "the card offers no grant");

  // 2. An old page presses "Allow this exact command once": refused, twice.
  const grant = () => invoke("safety_block_grant_exact", { id: card.payload.id }).then(() => "granted", (e) => String(e.message));
  results.grantReplies = [await grant(), await grant()];
  for (const reply of results.grantReplies) assert.match(reply, /cannot allow a command Claude's auto mode refused/);
  const pending = await invoke("safety_block_pending");
  assert(pending.some((c) => c.id === card.payload.id), "the card stays up: nothing was decided");
  assert(alive(first.pid), "nothing ends the process any more");

  // 3. Same turn, same process: two calls in one message, then three in a row.
  await wait("turn 1 over", async () => fullStops() >= 1);
  await invoke("chat_send", { key, text: "CALL2 SEQ3", turnId: "user-2" });
  await wait("5 more refusals", async () => stub().filter((e) => e.pid === first.pid && e.refused).length >= 6);
  results.sameTurn = { ran: ran(), refusedInProcess: stub().filter((e) => e.pid === first.pid && e.refused).length };
  assert.equal(ran(), 0, "same turn: repeated and parallel calls ran nothing");

  // 4. A queued message and background work reach the SAME process at its
  //    full stop: nothing ends it to take anything back.
  await invoke("chat_send", { key, text: "BG HOLD CALL1", turnId: "user-3" });
  await wait("held turn started", async () => stub().some((e) => e.pid === first.pid && e.userText?.includes("BG HOLD")));
  await invoke("chat_send", { key, text: "QUEUED-FOLLOWUP CALL1", turnId: "user-4" });
  const queued = await wait("queued message delivered", async () => stub().find((e) => e.userText?.includes("QUEUED-FOLLOWUP")), 15_000);
  results.queue = {
    samePid: queued.pid === first.pid,
    alive: alive(first.pid),
    interruptedNotice: stub().some((e) => e.userText?.includes("background work interrupted")),
    statuses: events.filter((e) => e.event === "chat-status" && e.payload.key === key && e.payload.kind === "error").map((e) => e.payload.text),
    ran: ran(),
  };
  assert.equal(results.queue.samePid, true, "the queued message went to the live process");
  assert.equal(results.queue.alive, true);
  assert.equal(results.queue.interruptedNotice, false, "background work was not interrupted");
  assert.deepEqual(results.queue.statuses, []);
  assert.equal(ran(), 0);

  // 5. A relaunch: the next process carries no rule and runs nothing.
  await wait("queued turn over", async () => stub().filter((e) => e.pid === first.pid && e.refused).length >= 8);
  await invoke("chat_stop", { key });
  await wait("process ended", async () => !alive(first.pid));
  await invoke("chat_start", { ...base, prompt: "CALL2", resume: `stub-${first.pid}`, turnId: "user-5" });
  const second = await wait("relaunch", async () => launches().find((l) => l.pid !== first.pid));
  await wait("relaunch refusals", async () => stub().filter((e) => e.pid === second.pid && e.refused).length >= 2);
  results.relaunch = { argvHasBashRule: second.argv.some((a) => a.includes("Bash(")), ran: ran() };
  assert.equal(results.relaunch.argvHasBashRule, false);
  assert.equal(ran(), 0, "relaunch: nothing ran");

  // 6. Restart the server; replay the stale grant request; relaunch again.
  const staleId = card.payload.id;
  ws.close();
  server.kill("SIGTERM");
  await wait("server down", async () => server.exitCode !== null || server.signalCode !== null);
  startServer();
  await connect();
  results.staleGrant = await invoke("safety_block_grant_exact", { id: staleId }).then(() => "granted", (e) => String(e.message));
  assert.match(results.staleGrant, /cannot allow a command/);
  await invoke("chat_start", { ...base, prompt: "CALL1 SEQ1", resume: `stub-${first.pid}`, turnId: "user-6" });
  const third = await wait("relaunch after restart", async () => launches().find((l) => l.pid !== first.pid && l.pid !== second.pid));
  await wait("post-restart refusals", async () => stub().filter((e) => e.pid === third.pid && e.refused).length >= 2);
  results.afterRestart = { argvHasBashRule: third.argv.some((a) => a.includes("Bash(")), ran: ran() };
  assert.equal(results.afterRestart.argvHasBashRule, false);

  results.totalRuns = ran();
  results.totalRefusals = stub().filter((e) => e.refused).length;
  results.launches = launches().length;
  assert.equal(results.totalRuns, 0, "the refused line never ran through OctiqFlow");
  results.passed = true;
  results.evidence = "stub provider (no model); real octiq-server";
} catch (error) {
  results.error = String(error.stack || error);
  results.serverLog = serverLog.split("\n").filter((l) => /perm|safety|chat:/.test(l)).slice(-40);
  process.exitCode = 1;
} finally {
  console.log(JSON.stringify(results, null, 2));
  ws?.close();
  server?.kill("SIGTERM");
  if (results.passed) fs.rmSync(DIR, { recursive: true, force: true });
  else console.log(`kept ${DIR}`);
}
