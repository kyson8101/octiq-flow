// Real server/socket/queue/recovery, deterministic stub CLI providers. No model
// calls or account credits. Fixtures and their home are removed on every exit.
// Usage: node scripts/test-registered-runtime.mjs [octiq-server] [evidence-dir]
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
        return out({ method: "thread/started", params: { thread: { id: thread, model: msg.params.model } } });
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
    out({ type: "system", subtype: "init", session_id: thread, model: process.argv[process.argv.indexOf("--model") + 1], tools: [] });
    if (text.includes("TRIGGER_MODEL_NOT_FOUND")) {
      return out({ type: "result", subtype: "error_during_execution", is_error: true, session_id: thread, result: "model_not_found: configured Claude model is unavailable" });
    }
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
let server = spawn(binary, [], { env, stdio: ["ignore", "pipe", "pipe"] });
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
  await wait("server", async () => { try { return (await fetch(`http://127.0.0.1:${port}/healthz`)).status === 200; } catch { return false; } });
  const connect = async () => {
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    ws.onmessage = ({ data }) => { const frame = JSON.parse(data); if (frame.t === "event") events.push(frame); else if (frame.t === "reply") { const pending = replies.get(frame.id); if (pending) { replies.delete(frame.id); frame.ok ? pending.resolve(frame.result) : pending.reject(new Error(frame.error)); } } };
  };
  await connect();
  const project = await invoke("add_workspace", { name: "Registered fixture", primaryPath: repo });
  const agent = await invoke("team_save", { agent: { name: "Registered Opus", role: "Test only", agent: "claude", model: "claude-opus-5-5", effort: "high", access: "full", projectId: project.id } });
  const setup = async (id, modelId = "claude:opus-5-5", assigned = agent) => {
    await invoke("chat_index_save", { meta: { id, projectId: project.id, title: id, cwd: mainRepo, modelId, access: "full", effort: "high" } });
    await invoke("team_brief", { chatKey: `chat:${id}`, projectId: project.id, leadId: assigned.id, task: "Wait for the person" });
  };
  const start = (id, extra = {}) => invoke("chat_start", { key: `chat:${id}`, cwd: mainRepo, agent: "claude", model: "claude-opus-5-5", access: "full", effort: "high", prompt: "Preserve the exact registered preset", turnId: `${id}-${sequence}`, ...extra });
  const heard = (key, type) => events.filter(e => e.event === "chat-event" && e.payload.key === key && e.payload.event.type === type);
  const starts = provider => calls().filter(c => c.provider === provider && c.argv);
  await setup("registered");
  await start("registered");
  await wait("registered first result", () => heard("chat:registered", "result").length === 1);
  assert(starts("claude")[0].argv.includes("claude-opus-5-5"));
  assert.equal(starts("codex").length, 0);
  const native = heard("chat:registered", "system").find(e => e.payload.event.subtype === "init").payload.event.session_id;
  await invoke("team_save", { agent: { ...agent, agent: "codex", model: "gpt-6.1-sol" } });
  await assert.rejects(invoke("chat_send", { key: "chat:registered", text: "Must not reach the old provider", turnId: "refuse-wrong-live" }), /Stop this chat/);
  await invoke("team_save", { agent });
  await invoke("chat_restart", { key: "chat:registered" });
  await start("registered", { resume: native });
  await wait("registered continued result", () => heard("chat:registered", "result").length === 2);
  assert(starts("claude")[1].argv.includes("claude-opus-5-5"));
  assert(starts("claude")[1].argv.includes(native));
  await invoke("chat_restart", { key: "chat:registered" });
  await setup("broken", "codex:model:claude-opus-5-5");
  // A cached wrong provider/model and foreign native id are deliberately sent
  // through the real socket contract, exactly like the two reported chats.
  await invoke("chat_index_save", { meta: { id: "broken", projectId: project.id, title: "Corrupt cached model", cwd: mainRepo, modelId: "codex:model:claude-opus-5-5", sessionId: "foreign-codex-session", access: "full", effort: "high" } });
  await start("broken", { agent: "codex", model: "claude-opus-5-5", resume: "foreign-codex-session", turnId: "repair-once", prompt: "Recover this old conversation" });
  await wait("recovered result", () => heard("chat:broken", "result").length === 1);
  const repair = starts("claude")[2];
  // No native session from the foreign provider may be reused.
  assert(!repair.argv.includes("foreign-codex-session"));
  assert(!repair.argv.includes("--resume"));
  assert(repair.argv.includes("claude-opus-5-5"));
  assert.equal(starts("codex").length, 0);
  assert.equal(heard("chat:broken", "octiq_registered_recovered").length, 1);
  const meta = (await invoke("chat_index_list")).find(c => c.id === "broken");
  assert.equal(meta.modelId, "claude:model:claude-opus-5-5");
  await invoke("chat_restart", { key: "chat:broken" });
  const beforeRetry = starts("claude").length;
  await start("broken", { agent: "codex", model: "claude-opus-5-5", resume: "foreign-codex-session", turnId: "repair-once" });
  assert.equal(starts("claude").length, beforeRetry);
  assert(heard("chat:broken", "octiq_registered_index_settings").some(e => e.payload.event.previousModelId === "codex:model:claude-opus-5-5"));
  results.presetStartContinueRecovery = true;
  const codexAgent = await invoke("team_save", { agent: { name: "Registered Codex", role: "Other lead identity", agent: "codex", model: "gpt-6.1-sol", effort: "high", access: "full", projectId: project.id } });
  await setup("codex-repair", "codex:model:claude-opus-5-5", codexAgent);
  await start("codex-repair", { agent: "codex", model: "claude-opus-5-5", resume: "unknown-native-session" });
  await wait("Codex lead recovered to its own registration", () => heard("chat:codex-repair", "octiq_registered_recovered").length === 1);
  await wait("Codex recovery completed", () => heard("chat:codex-repair", "turn.completed").length === 1);
  assert.equal(heard("chat:codex-repair", "octiq_registered_recovered")[0].payload.event.model, "gpt-6.1-sol");
  await invoke("chat_restart", { key: "chat:codex-repair" });
  results.recoveryFollowsEachLeadIdentity = true;

  // Invalid unregistered and backup tuples fail before any process launch.
  await assert.rejects(invoke("chat_start", { key: "chat:foreign-model", cwd: mainRepo, agent: "codex", model: "claude-opus-5-5", access: "full", prompt: "Never launch" }), /does not belong/);
  await assert.rejects(invoke("provider_fallback_policy_set", { owner: agent.id, rule: { mode: "auto", backup: { agent: "codex", model: "claude-opus-5-5", effort: "high" } } }), /does not belong/);

  await setup("unavailable-model");
  const beforeModelError = starts("codex").length;
  await start("unavailable-model", { prompt: "TRIGGER_MODEL_NOT_FOUND" });
  await wait("explicit model failure", () => heard("chat:unavailable-model", "result").length === 1);
  assert.equal(starts("codex").length, beforeModelError);
  assert.equal(heard("chat:unavailable-model", "octiq_provider_switched").length, 0);
  await invoke("chat_restart", { key: "chat:unavailable-model" });
  results.modelNotFoundNeverBecomesQuota = true;

  // Auto switching is legal only through policy, with a matching receipt.
  await setup("auto");
  await start("auto", { prompt: "TRIGGER_LIMIT: preserve this unfinished request" });
  await wait("auto switched", () => heard("chat:auto", "octiq_provider_switched").length === 1);
  await wait("Codex result", () => heard("chat:auto", "turn.completed").length === 1);
  const change = heard("chat:auto", "octiq_provider_switched")[0].payload.event;
  assert.equal(change.agent, "codex"); assert.equal(change.model, "gpt-5.6-sol"); assert.equal(change.effort, "high"); assert.equal(change.access, "full");
  const codexCall = calls().filter(c => c.method === "thread/start").at(-1);
  assert.equal(codexCall.params.model, change.model);
  assert(!calls().some(c => c.method === "thread/resume"));
  const afterAuto = (await invoke("team_list", { all: true })).find(a => a.id === agent.id);
  assert.equal(afterAuto.agent, "claude"); assert.equal(afterAuto.model, "claude-opus-5-5");
  await invoke("chat_restart", { key: "chat:auto" });
  results.autoReceiptMatchesRuntime = true;

  // A blocked FIRST launch under Ask must persist the original message and
  // survive a real server restart without spending a provider call.
  await invoke("provider_fallback_policy_set", { owner: agent.id, rule: { mode: "ask", backup: null } });
  await setup("ask-first");
  const count = calls().filter(c => c.argv).length;
  await assert.rejects(start("ask-first", { prompt: "SAVED_INITIAL_REQUEST", turnId: "ask-initial" }), /provider card/);
  const pending = (await invoke("provider_fallback_choices", { key: "chat:ask-first" }))[0];
  await assert.rejects(start("ask-first", { prompt: "SAVED_INITIAL_REQUEST", turnId: "ask-initial" }), /already saved/);
  assert.equal((await invoke("provider_fallback_choices", { key: "chat:ask-first" }))[0].id, pending.id);
  assert.equal(pending.source.agent, "claude"); assert.equal(pending.source.model, "claude-opus-5-5");
  assert.equal(calls().filter(c => c.argv).length, count);
  ws.close(); server.kill("SIGTERM");
  await new Promise(resolve => server.once("exit", resolve));
  server = spawn(binary, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", data => { serverLog += data; }); server.stderr.on("data", data => { serverLog += data; });
  await wait("restarted isolated server", async () => { try { return (await fetch(`http://127.0.0.1:${port}/healthz`)).status === 200; } catch { return false; } });
  await connect();
  const restored = (await invoke("provider_fallback_choices", { key: "chat:ask-first" }))[0];
  assert.equal(restored.id, pending.id);
  await invoke("provider_fallback_choose", { key: restored.key, id: restored.id, selection: { agent: "codex", model: "gpt-5.6-terra", effort: "low" }, remember: false });
  await wait("held initial request delivered", () => calls().some(c => c.method === "turn/start" && JSON.stringify(c.params).includes("SAVED_INITIAL_REQUEST")));
  await wait("choice switch receipt", () => heard("chat:ask-first", "octiq_provider_switched").length === 1);
  assert.equal(heard("chat:ask-first", "octiq_provider_switched")[0].payload.event.model, "gpt-5.6-terra");
  results.askFirstSurvivesRestart = true;
  await invoke("chat_restart", { key: "chat:ask-first" });
  // The fixture shell changes only probe output; any launch still reaches the
  // stubs, never a real model CLI elsewhere on the machine's PATH.
  const missingShell = `#!/bin/sh
if [ "$1" = '-lic' ]; then
  printf 'codex\\t%s/codex\\n' '${bin}'
  exit 0
fi
if [ "$1" = '-lc' ]; then shift; exec /bin/sh -c "$@"; fi
if [ "$1" = '-l' ]; then shift; fi
exec /bin/sh "$@"
`;
  fs.writeFileSync(shell, missingShell, { mode: 0o755 });
  const availability = await invoke("agent_installs", { refresh: true });
  assert.equal(availability.find(a => a.id === "claude").installed, false);
  await setup("missing-cli");
  const beforeMissing = starts("claude").length;
  await assert.rejects(start("missing-cli", { prompt: "WAIT_FOR_EXPLICIT_MISSING_CHOICE" }), /provider card/);
  assert.equal(starts("claude").length, beforeMissing);
  const missingChoice = (await invoke("provider_fallback_choices", { key: "chat:missing-cli" }))[0];
  assert.equal(missingChoice.source.model, "claude-opus-5-5");
  await invoke("provider_fallback_choose", { key: missingChoice.key, id: missingChoice.id, selection: null, remember: false });
  await invoke("provider_fallback_policy_set", { owner: agent.id, rule: { mode: "auto", backup: null } });
  await setup("missing-auto");
  await start("missing-auto");
  await wait("missing CLI Auto receipt", () => heard("chat:missing-auto", "octiq_provider_switched").length === 1);
  assert.equal(starts("claude").length, beforeMissing);
  assert.match(heard("chat:missing-auto", "octiq_provider_switched")[0].payload.event.message, /CLI is unavailable/);
  results.missingCliAskAndExplicitAuto = true;
  results.pass = true;
} catch (error) { results.pass = false; results.error = String(error.stack ?? error); }
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
