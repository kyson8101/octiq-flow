"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const http = require("node:http");
const { Broker, createServer, initConfig, readConfig, callMcpTool } = require("../bridge.cjs");

const client = "test-client";
const url = "https://chatgpt.com/c/test-conversation";
function ready(broker) {
  broker.attach({ client, url });
  broker.poll({ client, url, ready: true, busy: false });
}
test("disconnected, stale, draft and busy tabs cannot receive questions", async () => {
  let now = 1000;
  const broker = new Broker({ now: () => now });
  await assert.rejects(broker.tool("ask_chatgpt", { prompt: "hello" }), /Start the bridge/);
  ready(broker);
  now += 15001;
  await assert.rejects(broker.tool("ask_chatgpt", { prompt: "hello" }), /Start the bridge/);
  broker.poll({ client, url, ready: false, busy: false });
  await assert.rejects(broker.tool("ask_chatgpt", { prompt: "hello" }), /busy/);
  broker.poll({ client, url, ready: true, busy: true });
  await assert.rejects(broker.tool("ask_chatgpt", { prompt: "hello" }), /busy/);
});
test("a question is claimed once, attributed to its tab, and result retries are idempotent", async () => {
  const broker = new Broker();
  ready(broker);
  const job = await broker.tool("ask_chatgpt", { prompt: "Explain closures" });
  assert.equal(job.status, "queued");
  assert.equal(job.prompt, undefined);
  await assert.rejects(broker.tool("ask_chatgpt", { prompt: "second" }), /busy/);
  assert.throws(() => broker.attach({ client: "another-tab", url }), /switching tabs/);
  assert.throws(() => broker.poll({ client: "another-tab", url, ready: true, busy: false }), /not attached/);
  const claimed = broker.poll({ client, url, ready: true, busy: false });
  assert.equal(claimed.job.prompt, "Explain closures");
  assert.equal(broker.poll({ client, url, ready: true, busy: false }).job, null);
  assert.throws(() => broker.result({ client: "wrong", job_id: job.job_id }), /different tab/);
  const result = { client, job_id: job.job_id, status: "completed", answer: "A closure captures lexical bindings.", url };
  broker.result(result);
  broker.result({ ...result, answer: "wrong retry" });
  const final = await broker.tool("get_chatgpt_answer", { job_id: job.job_id, wait_seconds: 0 });
  assert.equal(final.answer, result.answer);
  assert.equal(final.conversation_url, url);
  assert.equal(broker.jobs.get(job.job_id).prompt, undefined);
});
test("timeout never resends and late answers cannot overwrite failure", async () => {
  let now = 1000;
  const broker = new Broker({ now: () => now });
  ready(broker);
  const job = await broker.tool("ask_chatgpt", { prompt: "slow", timeout_seconds: 30 });
  broker.poll({ client, url, ready: true, busy: false });
  now += 30001;
  assert.equal(broker.get(job.job_id).status, "failed");
  assert.equal(broker.poll({ client, url, ready: true, busy: false }).job, null);
  broker.result({ client, job_id: job.job_id, status: "completed", answer: "late", url });
  assert.equal(broker.get(job.job_id).status, "failed");
});
test("cancelling a queued question prevents delivery", async () => {
  const broker = new Broker();
  ready(broker);
  const job = await broker.tool("ask_chatgpt", { prompt: "cancel me" });
  await broker.tool("cancel_chatgpt_job", { job_id: job.job_id });
  assert.equal(broker.poll({ client, url, ready: true, busy: false }).job, null);
  assert.equal(broker.get(job.job_id).status, "cancelled");
});
test("wait returns a later completion without submitting another job", async () => {
  const broker = new Broker();
  ready(broker);
  const job = await broker.tool("ask_chatgpt", { prompt: "hello" });
  broker.poll({ client, url, ready: true, busy: false });
  const pending = broker.tool("get_chatgpt_answer", { job_id: job.job_id, wait_seconds: 2 });
  setTimeout(() => broker.result({ client, job_id: job.job_id, status: "completed", answer: "world", url }), 20);
  assert.equal((await pending).answer, "world");
  assert.equal(broker.jobs.size, 1);
});
test("jobs expire and input limits are enforced", async () => {
  let now = 1000;
  const broker = new Broker({ now: () => now, retentionMs: 1000 });
  ready(broker);
  for (const args of [{ prompt: "" }, { prompt: "x".repeat(60001) }, { prompt: "x", timeout_seconds: 0 }, { prompt: "x", timeout_seconds: 1.5 }, { prompt: "x", url: "https://evil.invalid" }]) {
    await assert.rejects(broker.tool("ask_chatgpt", args));
  }
  assert.throws(() => broker.attach({ client, url: "https://chatgpt.com.evil.invalid/" }));
  const job = await broker.tool("ask_chatgpt", { prompt: "x" });
  await broker.tool("cancel_chatgpt_job", { job_id: job.job_id });
  now += 1001;
  assert.throws(() => broker.get(job.job_id), /not found/);
});

async function serverFixture(t) {
  const broker = new Broker();
  const config = { token: "a".repeat(64) };
  const server = createServer(config, broker);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  config.port = server.address().port;
  t.after(() => { server.close(); server.closeAllConnections(); });
  const post = (endpoint, body, headers = {}) => fetch(`http://127.0.0.1:${config.port}${endpoint}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}`, ...headers }, body: JSON.stringify(body),
  });
  return { config, broker, post };
}
test("HTTP boundary rejects unauthenticated calls, page origins and DNS rebinding", async t => {
  const { post, config } = await serverFixture(t);
  const body = { name: "chatgpt_status" };
  assert.equal((await post("/tool", body, { Authorization: "" })).status, 401);
  assert.equal((await post("/tool", body, { Origin: "https://chatgpt.com" })).status, 403);
  assert.equal((await post("/tool", body, { Origin: "null" })).status, 403);
  const reboundStatus = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: config.port, path: "/tool", method: "POST", headers: { Host: "evil.invalid", Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" } }, res => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
  assert.equal(reboundStatus, 403);
  assert.equal((await post("/tool", body, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await post("/tool", body, { Origin: `chrome-extension://${"b".repeat(32)}` })).status, 200);
});
test("config creation is private and refuses to overwrite an existing token", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-bridge-test-"));
  const file = path.join(folder, "config.json");
  const config = initConfig(file);
  assert.deepEqual(readConfig(file), config);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => initConfig(file), /EEXIST/);
  assert.deepEqual(readConfig(file), config);
});
test("real stdio MCP automatically returns the answer and supports async mode", { timeout: 10000 }, async t => {
  const { config, post } = await serverFixture(t);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-mcp-test-"));
  const file = path.join(folder, "config.json");
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const process = spawn(global.process.execPath, [path.join(__dirname, "../bridge.cjs"), "mcp", "--config", file], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => process.kill());
  const lines = readline.createInterface({ input: process.stdout });
  const pending = new Map();
  let id = 0;
  lines.on("line", line => { const response = JSON.parse(line); pending.get(response.id)?.(response); pending.delete(response.id); });
  const rpc = (method, params) => new Promise(resolve => { const requestId = ++id; pending.set(requestId, resolve); process.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n"); });
  const tool = async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).result;
  const initialize = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(initialize.result.protocolVersion, "2025-06-18");
  assert.equal((await rpc("tools/list")).result.tools.length, 4);
  assert.equal((await rpc("unknown")).error.code, -32601);
  assert.equal((await tool("ask_chatgpt", { prompt: "test" })).isError, true);
  await post("/extension/attach", { client, url });
  await post("/extension/poll", { client, url, ready: true, busy: false });
  const waiting = tool("ask_chatgpt", { prompt: "What is 2 + 2?" });
  let browserJob;
  do {
    browserJob = await (await post("/extension/poll", { client, url, ready: true, busy: false })).json();
    if (!browserJob.job) await new Promise(resolve => setTimeout(resolve, 10));
  } while (!browserJob.job);
  // A waiting ask must not block other MCP requests.
  assert.equal((await rpc("ping")).error, undefined);
  assert.equal(browserJob.job.prompt, "What is 2 + 2?");
  await post("/extension/result", { client, url, job_id: browserJob.job.job_id, status: "completed", answer: "4" });
  const completed = await waiting;
  assert.equal(completed.isError, false);
  const answer = JSON.parse(completed.content[0].text);
  assert.equal(answer.answer, "4");
  assert.equal(answer.status, "completed");
  assert.equal(answer.job_id, browserJob.job.job_id);
  await post("/extension/poll", { client, url, ready: true, busy: false });
  const queued = JSON.parse((await tool("ask_chatgpt", { prompt: "async", wait_for_answer: false })).content[0].text);
  assert.equal(queued.status, "queued");
  await tool("cancel_chatgpt_job", { job_id: queued.job_id });
  const cancelled = await tool("get_chatgpt_answer", { job_id: queued.job_id, wait_seconds: 0 });
  assert.equal(cancelled.isError, true);
  process.stdin.end();
});

for (const status of ["completed", "failed", "cancelled"]) {
  test(`automatic wait polls the same job to ${status} without resubmission`, async () => {
    const calls = [];
    const results = [
      { job_id: "one", status: "queued" },
      { job_id: "one", status: "running" },
      { job_id: "one", status, ...(status === "completed" ? { answer: "done" } : {}) },
    ];
    const final = await callMcpTool({}, { name: "ask_chatgpt", arguments: { prompt: "hello", timeout_seconds: 60 } }, async (_, endpoint, body) => {
      assert.equal(endpoint, "/tool");
      calls.push(body);
      return results.shift();
    });
    assert.equal(final.status, status);
    assert.deepEqual(calls, [
      { name: "ask_chatgpt", arguments: { prompt: "hello", timeout_seconds: 60 } },
      { name: "get_chatgpt_answer", arguments: { job_id: "one", wait_seconds: 20 } },
      { name: "get_chatgpt_answer", arguments: { job_id: "one", wait_seconds: 20 } },
    ]);
  });
}
test("interrupted waits retain the job handle for recovery without resending", async () => {
  let calls = 0;
  const result = await callMcpTool({}, { name: "ask_chatgpt", arguments: { prompt: "hello" } }, async () => {
    if (++calls === 1) return { job_id: "recoverable", status: "queued" };
    throw new Error("Connection lost");
  });
  assert.equal(calls, 2);
  assert.equal(result.job_id, "recoverable");
  assert.equal(result.wait_interrupted, true);
  assert.match(result.next, /get_chatgpt_answer/);
});
test("invalid wait mode fails before submitting", async () => {
  await assert.rejects(callMcpTool({}, { name: "ask_chatgpt", arguments: { prompt: "hello", wait_for_answer: "yes" } }, async () => {
    assert.fail("must not submit");
  }), /Invalid wait_for_answer/);
});
