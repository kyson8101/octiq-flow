// Live regression for the one-shot exact grant's lifetime (review finding on
// 59f6808): a Claude process that used "Allow this exact command once" still
// carries `--allowedTools Bash(<line>)`, so it must end before anything else
// reaches it — a queued message, a turn after native background work, or a
// second call of the same line.
//
// Runs a real octiq-server in a throwaway HOME with a stub `claude` first on
// PATH. Nothing reaches a model, and nothing touches your profile or service.
//
//   cd src-tauri && cargo build --bin octiq-server && cd ..
//   node scripts/test-exact-grant-lifetime.mjs [path/to/octiq-server]
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SERVER = process.argv[2] || path.join(ROOT, "src-tauri/target/debug/octiq-server");
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-grant-lifetime-"));
const HOME = path.join(DIR, "home");
const BIN = path.join(DIR, "bin");
const LOG = path.join(DIR, "stub.log");
const PORT = 14000 + Math.floor(Math.random() * 1000);
const TOKEN = "grant-lifetime-token";
const LINE = "eas update --branch production";
const RULE = `Bash(${LINE})`;

// The stand-in for `claude -p --input-format stream-json`. Each launch logs
// its argv; each user message is logged with the pid that received it.
//   CLASSIFIER-DENY -> calls the line, then reports an auto-mode refusal
//   RUN-GRANTED     -> calls the line (spending the grant) and holds the turn
//     -BG           -> ...after starting native background work
//     -TWICE        -> ...and calls the same line again 500 ms later
function stubClaude() {
  const fs = require("fs");
  const readline = require("readline");
  const LINE = "eas update --branch production";
  const log = (entry) => fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ at: Date.now(), pid: process.pid, ...entry }) + "\n");
  log({ argv: process.argv.slice(2) });
  const resumed = process.argv.indexOf("--resume");
  const session = resumed >= 0 ? process.argv[resumed + 1] : "stub-" + process.pid;
  const out = (event) => process.stdout.write(JSON.stringify({ session_id: session, ...event }) + "\n");
  out({ type: "system", subtype: "init", model: "stub", tools: [] });
  let n = 0;
  const finish = (said) => {
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: said }] } });
    out({ type: "result", subtype: "success", is_error: false, result: said, duration_ms: 1, num_turns: 1 });
  };
  const call = () => {
    const id = "toolu_" + process.pid + "_" + ++n;
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command: LINE } }] } });
    log({ called: LINE, id });
    return id;
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
    if (text.includes("CLASSIFIER-DENY")) {
      const tool = call();
      out({ type: "system", subtype: "permission_denied", tool_name: "Bash", tool_use_id: tool, decision_reason: "[Production Deploy]",
        decision_reason_type: "classifier", message: "Permission for this action was denied by the Claude Code auto mode classifier." });
      finish("The classifier refused the publish; waiting on the card.");
      return;
    }
    if (text.includes("RUN-GRANTED")) {
      if (text.includes("-BG")) {
        out({ type: "system", subtype: "task_started", task_id: "bg-agent-1", task_type: "local_agent", description: "background checker" });
      }
      call();
      if (text.includes("-TWICE")) {
        setTimeout(() => call(), 500);
        setTimeout(() => { log({ finishedAfterTwice: true }); finish("ran it twice"); }, 3000);
        return;
      }
      setTimeout(() => finish("published once"), 2500);
      return;
    }
    finish("ok");
  });
}

fs.mkdirSync(BIN, { recursive: true });
fs.writeFileSync(path.join(BIN, "claude"), `#!/usr/bin/env node\n(${stubClaude.toString()})();\n`, { mode: 0o755 });
const repo = path.join(HOME, "code", "alpha");
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# alpha\n");
execFileSync("git", ["init", "-q", "-b", "develop"], { cwd: repo });

const server = spawn(SERVER, [], {
  env: { ...process.env, HOME, SHELL: "/bin/zsh", OCTIQ_WEB_PORT: String(PORT), OCTIQ_WEB_TOKEN: TOKEN, OCTIQ_CHAT_IDLE_MINS: "0",
    PATH: `${BIN}:${process.env.PATH}`, STUB_LOG: LOG },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
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
const wait = async (what, test, ms = 30_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const got = await test();
    if (got) return got;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
};
const stub = () => fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const results = {};
let project;

// One chat through: refusal card -> exact grant -> relaunch carrying the rule
// -> a turn that uses it -> what became of that process and the queue.
async function scenario(name, mode, queue) {
  const id = `grant-${name}`;
  const key = `chat:${id}`;
  const base = { key, cwd: repo, agent: "claude", model: "sonnet", access: "auto", useSandbox: false };
  project ??= await invoke("add_workspace", { name: "Alpha", primaryPath: repo });
  await invoke("chat_index_save", { meta: { id, projectId: project.id, title: id, customTitle: true, cwd: repo,
    modelId: "claude:sonnet", access: "auto", createdAt: Date.now(), updatedAt: Date.now(), generation: 0 } });
  const mark = stub().length;
  const fresh = () => stub().slice(mark);
  await invoke("chat_start", { ...base, prompt: "CLASSIFIER-DENY", turnId: `user-${name}-1` });
  const blocked = await wait("safety card", async () => events.find((e) => e.event === "safety-blocked" && e.payload.chatKey === key));
  const refused = fresh().find((e) => e.argv);
  const granted = await invoke("safety_block_grant_exact", { id: blocked.payload.id });
  assert.equal(granted.rule, RULE);
  await wait("the refused process ended", async () => !alive(refused.pid));

  // The browser's continuation: a resume that carries the rule.
  await invoke("chat_start", { ...base, prompt: `RUN-GRANTED${mode}`, resume: `stub-${refused.pid}`, turnId: `user-${name}-2` });
  const holder = await wait("relaunch with the rule", async () => fresh().find((e) => e.argv && e.pid !== refused.pid));
  assert(holder.argv.includes(RULE), `${name}: the granted launch carries the exact rule`);
  await wait("the line was called", async () => fresh().find((e) => e.called && e.pid === holder.pid));
  if (queue) await invoke("chat_send", { key, text: "QUEUED-FOLLOWUP", turnId: `user-${name}-3` });
  await wait("the process holding the rule ended", async () => !alive(holder.pid), 15_000);
  const outcome = {
    holderGotQueued: fresh().some((e) => e.pid === holder.pid && e.userText?.includes("QUEUED-FOLLOWUP")),
    finishedAfterTwice: fresh().some((e) => e.pid === holder.pid && e.finishedAfterTwice),
  };
  let next;
  if (queue) {
    next = await wait("relaunch for the queued message", async () => fresh().find((e) => e.userText?.includes("QUEUED-FOLLOWUP")));
  } else {
    const sent = await invoke("chat_send", { key, text: "AFTER", turnId: `user-${name}-4` }).then(() => "sent", (e) => String(e));
    if (sent.includes("no such chat")) {
      await invoke("chat_start", { ...base, prompt: "AFTER", resume: `stub-${refused.pid}`, turnId: `user-${name}-4` });
    }
    next = await wait("next launch", async () => fresh().find((e) => e.userText?.includes("AFTER")));
  }
  const launch = fresh().find((e) => e.argv && e.pid === next.pid);
  outcome.relaunched = next.pid !== holder.pid;
  outcome.relaunchCarriesRule = launch.argv.includes(RULE);
  outcome.relaunchResumes = launch.argv.includes("--resume");
  outcome.backgroundNotice = next.userText.includes("background work interrupted") && next.userText.includes("bg-agent-1");
  outcome.statuses = events.filter((e) => e.event === "chat-status" && e.payload.key === key && e.payload.kind !== "exit")
    .map((e) => `${e.payload.kind}: ${e.payload.text}`);
  outcome.deliveries = events.filter((e) => e.event === "chat-event" && e.payload.key === key
    && e.payload.event.type === "octiq_user_turn_delivery").map((e) => `${e.payload.event.uuid}:${e.payload.event.state}`);
  results[name] = outcome;
  return outcome;
}

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

  const queued = await scenario("queued", "", true);
  assert.equal(queued.holderGotQueued, false, "queued: the message never reached the process holding the rule");
  assert.equal(queued.relaunched && !queued.relaunchCarriesRule && queued.relaunchResumes, true, "queued: it rode a resume with no rule");
  assert(queued.deliveries.includes("user-queued-3:dispatched") && !queued.deliveries.includes("user-queued-3:failed"));

  const background = await scenario("background", "-BG", true);
  assert.equal(background.holderGotQueued, false, "background: work in the process does not keep the rule alive");
  assert.equal(background.relaunchCarriesRule, false);
  assert.equal(background.backgroundNotice, true, "background: the interrupted work is handed to the next launch");

  const twice = await scenario("twice", "-TWICE", false);
  assert.equal(twice.finishedAfterTwice, false, "twice: ended on the second call, before its turn finished");
  assert.equal(twice.relaunchCarriesRule, false);
  assert(twice.statuses.some((s) => s.includes("a second time")), "twice: the person is told why");
  results.passed = true;
} catch (error) {
  results.error = String(error.stack || error);
  results.serverLog = serverLog.split("\n").filter((l) => l.includes("[perm]"));
  process.exitCode = 1;
} finally {
  console.log(JSON.stringify(results, null, 2));
  ws?.close();
  server.kill("SIGTERM");
  if (results.passed) fs.rmSync(DIR, { recursive: true, force: true });
  else console.log(`kept ${DIR}`);
}
