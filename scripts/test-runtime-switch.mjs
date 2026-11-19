// A person changes a registered agent's runtime from inside its chat
// (`chat_switch_runtime`). Real server, real socket, real queue and failover,
// deterministic stub CLIs, an isolated HOME and profile. No model calls, no
// account credits. Fixtures and their home are removed on every exit.
//
// Usage: node scripts/test-runtime-switch.mjs [octiq-server] [evidence-dir]
//
// Scenes, in the order the person lives them:
//   1  Claude Opus hits its limit and the chat fails over to Codex, the
//      conversation and the agent's identity carry over.
//   2  The person returns to Opus during a stale cooldown (the limit is back
//      but the host's estimate says an hour) - and a stale tab's start that
//      still names Codex does not undo it.
//   3  The same, after the provider's own reset time has passed.
//   4  A switch during a turn, with a message queued: nothing is interrupted,
//      the turn finishes on the old runtime, the queued message goes to the
//      new one.
//   5  A still-limited return: the provider says no again, failover runs and
//      the person's message is not lost.
//   6  A long chat: the original first message is past the history window and
//      the agent's brief still reaches the fresh session.
//   7  A worker's notification after a switch starts the coordinator on the
//      new runtime.
//   8  Same provider: the native session is kept and resumed with the new model.
//   9  A restart on a fallback, and a restart with a switch waiting.
//   10 A stale tab after an automatic failover and a restart (the cooldowns
//      are empty, the tab still names Opus): the host's recorded runtime
//      wins, the fresh Codex session gets the history and the brief, and
//      Claude is never started. Asserted on the actual CLI launches and prompts.
//   11 A stale picker intent (a start naming Codex with the page's own
//      handoff, after a newer switch to Opus): the chat stays on the
//      recorded runtime, the page's history is unused, nothing is recorded as
//      the person's, and the picker's `chat_retarget` of a registered chat is
//      refused in words that name `chat_switch_runtime`.
//   12 A chat that was never switched (no receipt) and a stale tab that
//      names Codex with a handoff and a session of its own (H3): the host
//      keeps the runtime it last ran, resumes its own native session, never
//      starts Codex, and the page's history is unused.
//   13 The same chat started as a coordinator (`orchestration_master_start`)
//      with Codex and a page handoff (H3): Claude again, never Codex.
//   14 A same-runtime stale start with no session after a switch whose
//      handoff debt was paid, then a restart (H4): the earlier context is not
//      lost, and the page's own "Ready." history is not used.
//   (Every scene asserts the real CLI launches' argv and prompts.)
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binary = process.argv[2] || path.join(root, "src-tauri/target/debug/octiq-server");
const evidence = process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), "octiq-runtime-switch-evidence-"));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-runtime-switch-"));
const taskHome = path.join(fixture, "home"), bin = path.join(fixture, "bin"), repo = path.join(fixture, "repo");
const log = path.join(fixture, "calls.jsonl");
const port = 19000 + Math.floor(Math.random() * 900), token = "isolated-runtime-switch-test";
for (const folder of [taskHome, bin, repo, evidence]) fs.mkdirSync(folder, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# Runtime switch fixture\n");
for (const args of [["init", "-q", "-b", "develop"], ["add", "README.md"], ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]]) execFileSync("git", args, { cwd: repo });

// One stub for both providers. Markers in the prompt steer it:
//   TRIGGER_LIMIT        a quota failure whose reset is in an hour
//   TRIGGER_SHORT_LIMIT  a quota failure whose reset is in forty seconds
//   SLOW                 the turn takes three seconds
function cli() {
  const fs = require("node:fs"), readline = require("node:readline");
  const provider = require("node:path").basename(process.argv[1]);
  const log = (data) => fs.appendFileSync(process.env.SWITCH_TEST_LOG, JSON.stringify({ provider, pid: process.pid, ...data }) + "\n");
  const out = (data) => process.stdout.write(JSON.stringify(data) + "\n");
  if (process.argv.includes("--version")) { console.log("stub 1.0.0"); return; }
  if (process.argv.includes("models")) { console.log("[]"); return; }
  if (process.argv.includes("mcp") && process.argv.includes("list")) { console.log("[]"); return; }
  const thread = `new-${provider}-${process.pid}`;
  log({ argv: process.argv.slice(2), cwd: process.cwd() });
  // Markers steer a turn only when they are in the CURRENT message: a handoff
  // carries the earlier turns as data, and those must not fire them again.
  const current = (text) => text.includes("Current user message (JSON string):") ? text.split("Current user message (JSON string):").pop() : text;
  const slow = (text, then) => (current(text).includes("SLOW") ? setTimeout(then, 3000) : then());
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
        const text = JSON.stringify(msg.params.input);
        log({ method: msg.method, params: msg.params, text });
        out({ id: msg.id, result: { turn: { id: "turn-test" } } });
        out({ method: "turn/started", params: { threadId: thread, turn: { id: "turn-test" } } });
        return slow(text, () => {
          out({ method: "item/completed", params: { threadId: thread, item: { id: "answer", type: "agentMessage", text: "Codex continued the conversation." } } });
          out({ method: "turn/completed", params: { threadId: thread, turn: { id: "turn-test", status: "completed" } } });
        });
      }
      return;
    }
    if (msg.type === "control_request") return out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: {} } });
    if (msg.type !== "user") return;
    const text = JSON.stringify(msg.message?.content ?? "");
    log({ text });
    out({ type: "system", subtype: "init", session_id: thread, model: "opus", tools: [] });
    const now = current(text);
    const reset = now.includes("TRIGGER_SHORT_LIMIT") ? 40 : 3600;
    if (now.includes("TRIGGER_LIMIT") || now.includes("TRIGGER_SHORT_LIMIT")) {
      out({ type: "result", subtype: "error_during_execution", is_error: true, session_id: thread, result: "You've hit your session limit", quotaLimits: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + reset } });
    } else {
      slow(text, () => {
        out({ type: "assistant", session_id: thread, message: { role: "assistant", content: [{ type: "text", text: "Claude answered." }] } });
        out({ type: "result", subtype: "success", session_id: thread, is_error: false, result: "Claude answered." });
      });
    }
  });
}
for (const provider of ["claude", "codex"]) fs.writeFileSync(path.join(bin, provider), `#!${process.execPath}\n(${cli.toString()})();\n`, { mode: 0o755 });
const shell = path.join(bin, "fixture-shell");
fs.writeFileSync(shell, "#!/bin/sh\nif [ \"$1\" = '-lc' ]; then shift; exec /bin/sh -c \"$@\"; fi\nif [ \"$1\" = '-l' ]; then shift; fi\nexec /bin/sh \"$@\"\n", { mode: 0o755 });
const env = { ...process.env, HOME: taskHome, SHELL: shell, PATH: `${bin}:${process.env.PATH}`, SWITCH_TEST_LOG: log,
  OCTIQ_WEB_PORT: String(port), OCTIQ_WEB_TOKEN: token, OCTIQ_CHAT_IDLE_MINS: "0" };

let server, serverLog = "", ws, sequence = 0;
const events = [], replies = new Map(), results = {};
const calls = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const wait = async (label, test, timeout = 45_000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = await test(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${label}`);
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const invoke = (cmd, args = {}) => new Promise((resolve, reject) => {
  const id = ++sequence; replies.set(id, { resolve, reject }); ws.send(JSON.stringify({ t: "invoke", id, cmd, args }));
});
async function boot() {
  server = spawn(binary, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (data) => { serverLog += data; }); server.stderr.on("data", (data) => { serverLog += data; });
  await wait("server", async () => { try { return (await fetch(`http://127.0.0.1:${port}/healthz`)).status === 200; } catch { return false; } });
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ({ data }) => {
    const frame = JSON.parse(data);
    if (frame.t === "event") events.push(frame);
    else if (frame.t === "reply") { const pending = replies.get(frame.id); if (pending) { replies.delete(frame.id); frame.ok ? pending.resolve(frame.result) : pending.reject(new Error(frame.error)); } }
  };
}
async function restart(signal = "SIGTERM") {
  ws.close(); server.kill(signal);
  await new Promise((resolve) => { if (server.exitCode !== null || server.signalCode) resolve(); else server.once("exit", resolve); });
  await boot();
}

try {
  await boot();
  await invoke("scheduling_set", { settings: { orientation: "agents", hostCap: null } });
  const project = await invoke("add_workspace", { name: "Runtime switch fixture", primaryPath: repo });
  const agent = await invoke("team_save", { agent: { name: "Ada", role: "Owns the backend and its tests.", agent: "claude", model: "opus", effort: "high", access: "auto", projectId: project.id } });
  const lead = await invoke("lead_thread_open", { agentId: agent.id ?? agent.agent?.id });
  const key = `chat:${lead.id}`, cwd = lead.cwd;
  const state = () => invoke("chat_queue_state", { key });
  const idle = async () => {
    const rows = await invoke("chat_activity", { key }).catch(() => []);
    return !(Array.isArray(rows) ? rows : [rows]).some((row) => row?.key === key && row.busy);
  };
  const providerCalls = (provider) => calls().filter((call) => call.provider === provider);
  const messages = (provider) => providerCalls(provider).filter((call) => call.text ?? call.params).map((call) => JSON.stringify(call.text ?? call.params));
  // What the page does: start the chat, and send when it is already running.
  const send = (text, turnId, runtime = { agent: "claude", model: "opus" }, resume) =>
    invoke("chat_start", { key, cwd, ...runtime, effort: "high", access: "auto", prompt: text, turnId, ...(resume ? { resume } : {}) })
      .catch((error) => { if (!/already running/.test(String(error.message))) throw error; return invoke("chat_send", { key, text, turnId }); });
  const switched = (name) => events.some((e) => e.event === "chat-provider-switch" && e.payload.key === key && e.payload.agent === name);
  const registrationUnchanged = async () => {
    const roster = await invoke("team_list", { all: true });
    const row = (roster.agents ?? roster).find((a) => a.name === "Ada");
    assert.equal(row.agent, "claude"); assert.equal(row.model, "opus");
  };

  // ---- 1: the limit, and the failover to Codex --------------------------------
  await send("TRIGGER_LIMIT: please carry out the original request.", "t1");
  await wait("failover to Codex", () => switched("codex"), 60_000);
  await wait("Codex got the conversation", () => messages("codex").some((m) => m.includes("original request")));
  const firstCodex = messages("codex").find((m) => m.includes("original request"));
  // Identity: the role and the roster travel with the fresh session.
  assert.match(firstCodex, /You are Ada/, "the agent's brief reaches the failover session");
  assert.match(firstCodex, /Owns the backend and its tests\./);
  let now = await state();
  assert.equal(now.homeRuntime.agent, "claude");
  assert.equal(now.homeRuntime.model, "opus");
  assert.equal(now.homeRuntime.limited, true, "the host still thinks Claude is limited");
  assert.ok(now.homeRuntime.resetsAt > Date.now() / 1000, "the provider's own reset time, not a guess");
  assert.equal(now.pendingRuntime, undefined);
  results.scene1 = { homeRuntime: now.homeRuntime };

  // ---- 2: back to Opus during a stale cooldown ----------------------------------
  const claudeStartsBefore = providerCalls("claude").filter((c) => c.argv).length;
  const back = await invoke("chat_switch_runtime", { key, agent: "claude", model: "opus", effort: "high" });
  assert.deepEqual(back, { state: "switched", agent: "claude", model: "opus", effort: "high", access: "auto" });
  now = await state();
  assert.equal(now.homeRuntime, undefined, "back on its own runtime: no fallback");
  await registrationUnchanged();
  // A stale tab still names Codex: the host's recorded runtime wins.
  await send("Back on Opus, continue please.", "t2", { agent: "codex", model: "gpt-5.6-sol" });
  const claudeStart = await wait("Claude started again", () => providerCalls("claude").filter((c) => c.argv).length > claudeStartsBefore && providerCalls("claude").filter((c) => c.argv).at(-1));
  assert.ok(!claudeStart.argv.includes("--resume"), "a fresh session: the old Claude session is never reused after Codex");
  assert.equal(claudeStart.argv[claudeStart.argv.indexOf("--model") + 1], "opus");
  const second = await wait("Claude got history and identity", () => messages("claude").find((m) => m.includes("Back on Opus")));
  assert.match(second, /Codex continued the conversation/, "the Codex turns are not lost");
  assert.match(second, /original request/);
  assert.match(second, /You are Ada/, "identity after returning to Claude");
  assert.ok(second.indexOf("Back on Opus") < second.lastIndexOf("You are Ada"), "the new message is in the data, the brief is outside it");
  assert.equal(providerCalls("codex").filter((c) => c.method === "turn/start").length, 1, "nothing more went to Codex");
  now = await state();
  assert.equal(now.homeRuntime, undefined);
  await wait("the turn ended", idle);
  results.scene2 = { claudeStart: claudeStart.argv };

  // ---- 3: after the provider's own reset ----------------------------------------
  await send("TRIGGER_SHORT_LIMIT: limited again for forty seconds.", "t3");
  await wait("second failover", () => events.filter((e) => e.event === "chat-provider-switch" && e.payload.key === key && e.payload.agent === "codex" && !e.payload.byPerson).length >= 2, 60_000);
  now = await state();
  results.scene3Debug = { at: Math.floor(Date.now() / 1000), homeRuntime: now.homeRuntime };
  assert.equal(now.homeRuntime.limited, true);
  assert.ok(now.homeRuntime.resetsAt - Math.floor(Date.now() / 1000) < 120, `the provider said forty seconds: ${JSON.stringify(results.scene3Debug)}`);
  await wait("the short limit expires", async () => (await state()).homeRuntime?.limited === false, 90_000);
  const afterReset = await invoke("chat_switch_runtime", { key, agent: "claude", model: "opus", effort: "high" });
  assert.equal(afterReset.state, "switched");
  assert.equal((await state()).homeRuntime, undefined);
  results.scene3 = afterReset;

  // ---- 4: a switch during a turn, with a message queued -------------------------
  await send("SLOW first turn.", "t4");
  await wait("the slow turn is running", () => messages("claude").some((m) => m.includes("SLOW first turn")));
  await invoke("chat_send", { key, text: "queued second message", turnId: "t4b" });
  const claudeWrites = messages("claude").length;
  const pending = await invoke("chat_switch_runtime", { key, agent: "codex", model: "gpt-5.6-sol", effort: "high" });
  assert.equal(pending.state, "pending");
  assert.equal((await state()).pendingRuntime.agent, "codex");
  assert.ok(events.some((e) => e.event === "chat-runtime-pending" && e.payload.key === key && e.payload.agent === "codex"));
  // A second pick replaces it, and picking what runs clears it: both are one call away.
  assert.equal((await invoke("chat_switch_runtime", { key, agent: "codex", model: "gpt-5.6-terra", effort: "high" })).state, "pending");
  assert.equal((await invoke("chat_switch_runtime", { key, agent: "codex", model: "gpt-5.6-sol", effort: "high" })).state, "pending");
  await wait("the queued message reaches Codex", () => messages("codex").some((m) => m.includes("queued second message")), 60_000);
  assert.equal(messages("claude").length, claudeWrites, "nothing more was written to the old process");
  assert.ok(messages("claude").some((m) => m.includes("SLOW first turn")));
  const queued = messages("codex").find((m) => m.includes("queued second message"));
  assert.match(queued, /SLOW first turn/, "the first turn is in the history the queued message carries");
  assert.match(queued, /You are Ada/);
  assert.equal((await state()).pendingRuntime, undefined);
  assert.equal((await state()).homeRuntime, undefined, "the person's pick is the chat's own runtime now");
  results.scene4 = { pending, queued: queued.length };

  // ---- 5: a still-limited return ----------------------------------------------
  await wait("Codex idle", idle);
  assert.equal((await invoke("chat_switch_runtime", { key, agent: "claude", model: "opus", effort: "high" })).state, "switched");
  await send("TRIGGER_LIMIT: Claude is still limited.", "t5");
  await wait("failover again after a real quota failure", () => events.filter((e) => e.event === "chat-provider-switch" && e.payload.key === key && e.payload.agent === "codex" && !e.payload.byPerson).length >= 3, 60_000);
  await wait("the message was not lost", () => messages("codex").some((m) => m.includes("Claude is still limited")));
  assert.equal((await state()).homeRuntime.limited, true, "marked again by the provider's own failure");
  results.scene5 = { homeRuntime: (await state()).homeRuntime };

  // ---- 6: a long chat: the first message is past the window --------------------
  await wait("Codex idle", idle);
  assert.equal((await invoke("chat_switch_runtime", { key, agent: "claude", model: "opus", effort: "high" })).state, "switched");
  const filler = "x".repeat(12_000);
  for (let n = 0; n < 16; n += 1) {
    await send(`filler ${n} ${filler}`, `long-${n}`);
    await wait(`filler ${n} answered`, idle);
  }
  const longSwitch = await invoke("chat_switch_runtime", { key, agent: "codex", model: "gpt-5.6-sol", effort: "high" });
  results.scene6Debug = { longSwitch, activity: await invoke("chat_activity", { key }).catch((e) => String(e)), queue: await state() };
  assert.equal(longSwitch.state, "switched", JSON.stringify(results.scene6Debug));
  await send("After the long chat, who are you?", "t6", { agent: "codex", model: "gpt-5.6-sol" });
  const long = await wait("Codex got the long chat", () => messages("codex").find((m) => m.includes("who are you")));
  assert.ok(!long.includes("original request"), "the first message is past the 160k window");
  assert.match(long, /You are Ada/, "and the agent's brief still arrives");
  assert.match(long, /Owns the backend and its tests\./);
  results.scene6 = { promptLength: long.length };

  // ---- 7: a worker's notification after a switch -------------------------------
  await wait("Codex idle", idle);
  const run = await invoke("orchestration_run_create", { actorChatKey: key, objective: "Notify the coordinator", workspaceId: project.id, rootPath: repo, maxConcurrent: 1, workspaceMode: "direct" });
  const reportSaved = await invoke("team_save", { agent: { name: "Bo", role: "Does the work.", agent: "claude", model: "opus", effort: "high", access: "manual", projectId: project.id, reportsTo: agent.id ?? agent.agent?.id } });
  const reportId = reportSaved.id ?? reportSaved.agent?.id;
  const task = await invoke("orchestration_task_create", { actorChatKey: key, runId: run.id, title: "A worker", spec: "Wait.", dependsOn: [], assignee: reportId, worker: { agent: "claude", model: "opus", effort: "high", access: "manual" } });
  const ledger = await invoke("orchestration_snapshot", { runId: run.id });
  const planned = (ledger.runs ?? []).find((r) => r.id === run.id) ?? ledger.run;
  const revision = planned?.planApproval?.revision ?? planned?.plan?.revision;
  results.scene7Plan = { revision, keys: Object.keys(planned ?? {}) };
  await invoke("orchestration_plan_approve", { actorChatKey: key, runId: run.id, taskIds: [task.id], revision, surface: "chat", shownMs: 60_000, updatedMs: null });
  // Agents orientation queues the task; the 2-second scheduler starts its worker.
  const worker = await wait("the scheduler started the worker", async () => {
    const view = await invoke("orchestration_snapshot", { runId: run.id });
    const attempt = (view.attempts ?? []).find((a) => a.taskId === task.id && a.workerChatKey);
    return attempt ? { workerChatKey: attempt.workerChatKey } : false;
  }, 60_000);
  // Let the coordinator go idle with no process, then move it to Claude.
  assert.equal((await invoke("chat_switch_runtime", { key, agent: "claude", model: "opus", effort: "high" })).state, "switched");
  const claudeBefore = messages("claude").length;
  await invoke("orchestration_message_send", { actorChatKey: worker.workerChatKey, runId: run.id, to: "coordinator", kind: "status", subject: "Done", body: "WORKER_NOTE: the worker has something to say." });
  const woke = await wait("the coordinator was woken on the new runtime", () => messages("claude").slice(claudeBefore).find((m) => m.includes("WORKER_NOTE")), 60_000);
  assert.match(woke, /You are Ada/, "a host wake after a provider change carries the brief too");
  assert.equal(messages("codex").filter((m) => m.includes("WORKER_NOTE")).length, 0, "not on the old provider");
  results.scene7 = { woke: woke.length };

  // ---- 8: the same provider keeps its session ---------------------------------
  await wait("coordinator idle", idle);
  const sessionBefore = (await invoke("chat_index_list", {})).find?.((row) => row.id === lead.id)?.sessionId;
  const sonnet = await invoke("chat_switch_runtime", { key, agent: "claude", model: "sonnet", effort: "low" });
  assert.equal(sonnet.state, "switched");
  const claudeAgain = providerCalls("claude").filter((c) => c.argv).length;
  await send("Now on Sonnet.", "t8", { agent: "claude", model: "sonnet" }, sessionBefore);
  const resumed = await wait("Claude resumed with the new model", () => { const starts = providerCalls("claude").filter((c) => c.argv); return starts.length > claudeAgain && starts.at(-1); });
  assert.equal(resumed.argv[resumed.argv.indexOf("--model") + 1], "sonnet");
  assert.equal(resumed.argv[resumed.argv.indexOf("--effort") + 1], "low");
  if (sessionBefore) assert.equal(resumed.argv[resumed.argv.indexOf("--resume") + 1], sessionBefore, "the native session followed the model");
  results.scene8 = { argv: resumed.argv, sessionBefore };

  // ---- 9: restarts --------------------------------------------------------------
  await wait("coordinator idle", idle);
  // 9a: on a fallback when the server restarts.
  await invoke("chat_switch_runtime", { key, agent: "claude", model: "opus", effort: "high" });
  await send("TRIGGER_LIMIT: fail over before the restart.", "t9");
  await wait("failover before restart", () => events.filter((e) => e.event === "chat-provider-switch" && e.payload.key === key && e.payload.agent === "codex" && !e.payload.byPerson).length >= 4, 60_000);
  await wait("Codex idle", idle);
  await restart();
  const restarted = await state();
  assert.equal(restarted.homeRuntime.agent, "claude", "the home runtime is derived from the record after a restart");
  assert.equal(restarted.homeRuntime.limited, false, "cooldowns are empty after a restart");
  assert.equal(restarted.homeRuntime.resetsAt, undefined);
  assert.equal((await invoke("chat_switch_runtime", { key, agent: "claude", model: "opus", effort: "high" })).state, "switched");
  assert.equal((await state()).homeRuntime, undefined);
  // 9b: a switch waiting when the server restarts.
  await send("SLOW turn before a restart.", "t10", { agent: "claude", model: "opus" });
  await wait("the slow turn started", () => messages("claude").some((m) => m.includes("SLOW turn before a restart")));
  assert.equal((await invoke("chat_switch_runtime", { key, agent: "codex", model: "gpt-5.6-sol", effort: "high" })).state, "pending");
  await restart("SIGKILL");
  assert.equal((await state()).pendingRuntime.agent, "codex", "the pending switch is read from the record");
  const codexTurns = providerCalls("codex").filter((c) => c.method === "turn/start").length;
  await send("First message after the restart.", "t11", { agent: "claude", model: "opus" });
  await wait("the next start applied it", () => providerCalls("codex").filter((c) => c.method === "turn/start").length > codexTurns, 60_000);
  assert.match(messages("codex").at(-1), /First message after the restart/);
  assert.match(messages("codex").at(-1), /You are Ada/);
  assert.equal((await state()).pendingRuntime, undefined);
  await registrationUnchanged();

  // ---- 10: a stale tab after a failover and a restart ---------------------------
  await wait("Codex idle", idle);
  const indexRow = async () => (await invoke("chat_index_list", {})).find((row) => row.id === lead.id);
  assert.equal((await invoke("chat_switch_runtime", { key, agent: "claude", model: "opus", effort: "high" })).state, "switched");
  const autoBefore = events.filter((e) => e.event === "chat-provider-switch" && e.payload.key === key && e.payload.agent === "codex" && !e.payload.byPerson).length;
  await send("TRIGGER_LIMIT: fail over before the stale tab.", "t12");
  await wait("automatic failover to Codex", () => events.filter((e) => e.event === "chat-provider-switch" && e.payload.key === key && e.payload.agent === "codex" && !e.payload.byPerson).length > autoBefore, 60_000);
  await wait("Codex idle", idle);
  await restart();
  assert.equal((await indexRow()).modelId.startsWith("codex:"), true, "the host's runtime is Codex");
  const claudeWritesBefore = messages("claude").length;
  await send("STALE_TAB_AFTER_RESTART", "t13", { agent: "claude", model: "opus" });
  const stale = await wait("Codex got the stale tab's message", () => messages("codex").find((m) => m.includes("STALE_TAB_AFTER_RESTART")), 60_000);
  assert.equal(messages("claude").length, claudeWritesBefore, "Claude was not started or written to by the stale tab");
  assert.ok(!messages("claude").some((m) => m.includes("STALE_TAB_AFTER_RESTART")));
  // The host resumes its OWN native Codex session (the one the failover
  // started, read back from the chat's record after the restart), so the
  // history and the brief are already in it: they are not sent a second time.
  const failoverCodex = providerCalls("codex").find((c) => c.text?.includes("fail over before the stale tab"));
  const staleCall = providerCalls("codex").find((c) => c.text?.includes("STALE_TAB_AFTER_RESTART"));
  const staleResume = providerCalls("codex").find((c) => c.pid === staleCall.pid && c.method === "thread/resume");
  assert.equal(staleResume?.params.threadId, `new-codex-${failoverCodex.pid}`, "the host resumes its own Codex session, never one the page named");
  assert.ok(!/Earlier turns/.test(stale), "a resumed session is not handed the history again");
  assert.equal((await indexRow()).modelId.startsWith("codex:"), true, "the index still says Codex, and so does the launch");
  const home = (await state()).homeRuntime;
  assert.equal(home?.agent, "claude", "the way back to Opus is still offered: the stale start did not make Codex the baseline");
  await wait("Codex idle", idle);
  // Back to Opus is an explicit choice; a stale tab then cannot undo it.
  assert.equal((await invoke("chat_switch_runtime", { key, agent: "claude", model: "opus", effort: "high" })).state, "switched");
  // ---- 11: a stale picker intent cannot undo a newer switch (H2) -----------------
  // Tab A picked Codex with the ordinary picker and has not sent. Tab B then
  // switched the chat to Opus through the host. Tab A's plain Send is a
  // chat_start that still names Codex and carries the page's own handoff.
  // The reviewer's request, replayed. A start never carries a choice.
  const byPerson = () => events.filter((e) => e.event === "chat-provider-switch" && e.payload.key === key && e.payload.byPerson).length;
  await wait("Claude idle", idle);
  const refused = await invoke("chat_retarget", { key }).then(() => null, (error) => String(error.message));
  assert.match(refused ?? "", /chat_switch_runtime/, "the picker's retarget of a registered chat is refused in words that name the switch");
  assert.match(refused ?? "", /registered/);
  const registeredFact = (await state()).registered;
  assert.equal(registeredFact, true, "the host says the chat is registered, with no roster on the page");
  await restart();
  const personSwitches = byPerson();
  const codexTurnsBefore = providerCalls("codex").filter((c) => c.method === "turn/start").length;
  const claudeStarts = providerCalls("claude").filter((c) => c.argv).length;
  await invoke("chat_start", { key, cwd, agent: "codex", model: "gpt-5.6-sol", effort: "high", access: "auto", prompt: "STALE_PAGE_PICKER_SEND", turnId: "t15",
    handoff: JSON.stringify([{ role: "assistant", text: "Ready." }]), resume: null });
  const picked = await wait("Claude (the recorded runtime) got the stale tab's message", () => providerCalls("claude").filter((c) => c.argv).length > claudeStarts && messages("claude").find((m) => m.includes("STALE_PAGE_PICKER_SEND")), 60_000);
  assert.equal(providerCalls("codex").filter((c) => c.method === "turn/start").length, codexTurnsBefore, "Codex never started: the page's pick is not a choice");
  assert.ok(!picked.includes("Ready."), "the page-built handoff is not used");
  assert.equal(byPerson(), personSwitches, "a start records nothing as the person's");
  assert.equal((await indexRow()).modelId, "claude:opus", "the newer switch stands");
  await wait("Claude idle", idle);
  // The same replay on a chat whose record says Codex: the page may name Opus.
  await invoke("chat_switch_runtime", { key, agent: "codex", model: "gpt-5.6-sol", effort: "high" });
  await restart();
  const claudeStartsB = providerCalls("claude").filter((c) => c.argv).length;
  await invoke("chat_start", { key, cwd, agent: "claude", model: "opus", effort: "high", access: "auto", prompt: "STALE_OPUS_WITH_HANDOFF", turnId: "t16",
    handoff: JSON.stringify([{ role: "user", text: "earlier turn from the page" }]), resume: null });
  const staleOpus = await wait("Codex got it", () => messages("codex").find((m) => m.includes("STALE_OPUS_WITH_HANDOFF")), 60_000);
  assert.ok(!staleOpus.includes("earlier turn from the page"), "the page's history is never used");
  assert.equal(providerCalls("claude").filter((c) => c.argv).length, claudeStartsB, "Claude was not started");
  assert.equal((await indexRow()).modelId.startsWith("codex:"), true);
  // ---- 12-14: a chat that was never switched (H3, H4) ------------------------------
  const bea = await invoke("team_save", { agent: { name: "Bea", role: "Owns the frontend.", agent: "claude", model: "opus", effort: "high", access: "auto", projectId: project.id } });
  const beaLead = await invoke("lead_thread_open", { agentId: bea.id ?? bea.agent?.id });
  const bkey = `chat:${beaLead.id}`, bcwd = beaLead.cwd;
  const bidle = async () => {
    const rows = await invoke("chat_activity", { key: bkey }).catch(() => []);
    return !(Array.isArray(rows) ? rows : [rows]).some((row) => row?.key === bkey && row.busy);
  };
  const bsend = (text, turnId, runtime = { agent: "claude", model: "opus" }, extra = {}) =>
    invoke("chat_start", { key: bkey, cwd: bcwd, ...runtime, effort: "high", access: "auto", prompt: text, turnId, ...extra })
      .catch((error) => { if (!/already running/.test(String(error.message))) throw error; return invoke("chat_send", { key: bkey, text, turnId }); });
  const launches = (provider) => providerCalls(provider).filter((c) => c.argv);
  const launchOf = (pid) => calls().find((c) => c.pid === pid && c.argv);
  const callWith = (provider, marker) => providerCalls(provider).find((c) => (c.text ?? JSON.stringify(c.params ?? "")).includes(marker));
  const resumeOf = (launch) => launch.argv[launch.argv.indexOf("--resume") + 1];
  const switches = () => events.filter((e) => e.event === "chat-provider-switch" && e.payload.key === bkey).length;
  const codexAll = () => providerCalls("codex").filter((c) => c.method === "turn/start" || c.method === "thread/start" || c.method === "thread/resume").length;

  // 12: no receipt, a stale tab naming Codex.
  await bsend("BEA_FIRST_TURN ORIGINAL_IDENTITY_CONTEXT", "b1");
  await wait("Bea idle", bidle);
  const beaFirst = callWith("claude", "BEA_FIRST_TURN");
  const beaSession = `new-claude-${beaFirst.pid}`;
  await restart();
  const beaSwitches = switches(), beaCodexBefore = codexAll(), beaClaudeBefore = launches("claude").length;
  await invoke("chat_start", { key: bkey, cwd: bcwd, agent: "codex", model: "gpt-5.6-sol", effort: "high", access: "auto", prompt: "BEA_STALE_TAB", turnId: "b2",
    handoff: JSON.stringify([{ role: "assistant", text: "PAGE_HISTORY_NOT_THE_HOSTS" }]), resume: "codex-session-of-the-page" });
  const staleBea = await wait("Claude got the stale tab's message", () => launches("claude").length > beaClaudeBefore && callWith("claude", "BEA_STALE_TAB"), 60_000);
  assert.equal(codexAll(), beaCodexBefore, "Codex never started: a start carries no runtime");
  assert.ok(!JSON.stringify(staleBea).includes("PAGE_HISTORY_NOT_THE_HOSTS"), "the page's history is unused");
  const staleLaunch = launchOf(staleBea.pid);
  assert.equal(staleLaunch.argv[staleLaunch.argv.indexOf("--model") + 1], "opus");
  assert.equal(resumeOf(staleLaunch), beaSession, "the host resumes its own native session, never the page's");
  assert.equal(switches(), beaSwitches, "no runtime change is announced");
  const beaQueue = await invoke("chat_queue_state", { key: bkey });
  assert.deepEqual([beaQueue.registered, beaQueue.runtime?.agent, beaQueue.runtime?.model], [true, "claude", "opus"], "the host says what it runs");
  await wait("Bea idle", bidle);

  // 13: the same chat started as a coordinator.
  await invoke("chat_stop", { key: bkey });
  assert.equal((await invoke("chat_switch_runtime", { key: bkey, agent: "claude", model: "opus", effort: "high" })).state, "switched", "an Opus no-op writes no receipt");
  const beaRow = (await invoke("chat_index_list")).find((row) => row.id === beaLead.id);
  await invoke("chat_index_save", { meta: { ...beaRow, cwd: fs.realpathSync(repo) } });
  const beaRun = await invoke("orchestration_run_create", { actorChatKey: bkey, objective: "MASTER_HANDOFF_RUNTIME_PROBE", workspaceId: project.id, rootPath: fs.realpathSync(repo), maxConcurrent: 1, workspaceMode: "direct" });
  const codexBeforeMaster = codexAll(), claudeBeforeMaster = launches("claude").length;
  await invoke("orchestration_master_start", { actorChatKey: bkey, runId: beaRun.id, agent: "codex", model: "gpt-5.6-sol", effort: "high", access: "auto",
    handoff: JSON.stringify([{ role: "user", text: "MASTER_HANDOFF_CONTEXT" }]) });
  const master = await wait("Claude got the coordinator start", () => launches("claude").length > claudeBeforeMaster && callWith("claude", "MASTER_HANDOFF_RUNTIME_PROBE"), 60_000);
  assert.equal(codexAll(), codexBeforeMaster, "Codex never started for the coordinator");
  assert.ok(!JSON.stringify(master).includes("MASTER_HANDOFF_CONTEXT"), "the page's handoff is unused");
  assert.equal(switches(), beaSwitches, "still no runtime change");
  await wait("Bea idle", bidle);

  // 14: switched Codex -> Opus, the handoff debt paid, a restart, then the
  // same-runtime stale start with no session and a page history of its own.
  await invoke("chat_stop", { key: bkey });
  assert.equal((await invoke("chat_switch_runtime", { key: bkey, agent: "codex", model: "gpt-5.6-sol", effort: "high" })).state, "switched");
  await bsend("BEA_ON_CODEX", "b3", { agent: "codex", model: "gpt-5.6-sol" });
  await wait("Codex answered Bea", () => callWith("codex", "BEA_ON_CODEX"), 60_000);
  await wait("Bea idle", bidle);
  assert.equal((await invoke("chat_switch_runtime", { key: bkey, agent: "claude", model: "opus", effort: "high" })).state, "switched");
  await bsend("LATEST_HOST_HISTORY_AFTER_SWITCH", "b4");
  const afterSwitch = await wait("Claude got the history after the switch", () => callWith("claude", "LATEST_HOST_HISTORY_AFTER_SWITCH"), 60_000);
  assert.match(JSON.stringify(afterSwitch), /ORIGINAL_IDENTITY_CONTEXT/, "the fresh session after the switch carries the earlier context");
  await wait("Bea idle", bidle);
  const debtSession = `new-claude-${afterSwitch.pid}`;
  await restart();
  const codexBeforeReplay = codexAll(), claudeBeforeReplay = launches("claude").length;
  await invoke("chat_start", { key: bkey, cwd: bcwd, agent: "claude", model: "opus", effort: "high", access: "auto", prompt: "SAME_RUNTIME_STALE_PAGE_SEND", turnId: "b5",
    handoff: JSON.stringify([{ role: "assistant", text: "Ready." }]), resume: null });
  const replay = await wait("Claude got the same-runtime stale start", () => launches("claude").length > claudeBeforeReplay && callWith("claude", "SAME_RUNTIME_STALE_PAGE_SEND"), 60_000);
  const replayLaunch = launchOf(replay.pid);
  const replayPrompt = JSON.stringify(replay);
  // The earlier context is not lost: the host resumes its own session that
  // holds it, or hands a fresh one the host's history and the full brief.
  const continuity = resumeOf(replayLaunch) === debtSession
    || (/Earlier turns \(JSON\)/.test(replayPrompt) && /ORIGINAL_IDENTITY_CONTEXT/.test(replayPrompt) && /You are Bea/.test(replayPrompt));
  assert.ok(continuity, `the earlier context survives (resume ${resumeOf(replayLaunch)}, prompt ${replayPrompt.slice(0, 200)})`);
  assert.ok(!replayPrompt.includes("Ready."), "the page's own history is not used");
  assert.equal(codexAll(), codexBeforeReplay, "Codex was not started");
  results.scene10 = { stale: stale.length };
  results.scene11 = { picked: picked.length, staleOpus: staleOpus.length, refused };
  results.scene12 = { resumed: resumeOf(staleLaunch), beaSession };
  results.scene13 = { prompt: JSON.stringify(master).length };
  results.scene14 = { resumed: resumeOf(replayLaunch), debtSession };
  results.pass = true;
} catch (error) {
  results.pass = false; results.error = String(error.stack ?? error);
} finally {
  fs.writeFileSync(path.join(evidence, "result.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(evidence, "server.log"), serverLog);
  fs.writeFileSync(path.join(evidence, "cli-calls.json"), JSON.stringify(calls(), null, 2));
  fs.writeFileSync(path.join(evidence, "events.json"), JSON.stringify(events.filter((e) => /provider-switch|runtime-pending/.test(e.event)), null, 2));
  try { ws?.close(); } catch {}
  server?.kill("SIGTERM");
  await new Promise((resolve) => { if (!server || server.exitCode !== null || server.signalCode) resolve(); else server.once("exit", resolve); });
  if (!process.env.KEEP_FIXTURE) fs.rmSync(fixture, { recursive: true, force: true });
  else console.error("fixture kept:", fixture);
}
console.log(JSON.stringify({ pass: results.pass, evidence, error: results.error }, null, 2));
process.exit(results.pass ? 0 : 1);
