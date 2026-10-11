"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

function call(root, env, method, params) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "octiq-ask.cjs")], {
      env: { ...process.env, OCTIQ_SESSION_KEY: "", OCTIQ_CHAT_CAPABILITY: "", OCTIQ_ORCHESTRATION_ATTEMPT: "", OCTIQ_FRONT_DESK: "", OCTIQ_ROOT: root, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error("MCP timed out")); }, 5000);
    let out = "";
    child.on("error", reject);
    child.on("exit", () => { clearTimeout(timer); if (!out) reject(new Error("No MCP response")); });
    child.stdout.on("data", chunk => {
      out += chunk;
      if (out.includes("\n")) { clearTimeout(timer); resolve(JSON.parse(out.split("\n")[0]).result); child.stdin.end(); }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n");
  });
}

test("orchestration calls prove their chat with the launch's capability, not their arguments", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-orchestration-mcp-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, capability: req.headers["x-octiq-chat-capability"], body: JSON.parse(body) });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ result: { awarded: false } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  // The person's token sits in web.json; the MCP must neither need nor send it.
  fs.writeFileSync(path.join(root, "web.json"), JSON.stringify({ port: server.address().port, token: "test-token" }));
  process.env.OCTIQ_HOOK_PORT = String(server.address().port);
  t.after(() => { delete process.env.OCTIQ_HOOK_PORT; });

  const accept = { name: "orchestration_task_accept", arguments: { taskId: "task_1", attemptId: "attempt_1", chatKey: "chat:lead" } };
  await call(root, { OCTIQ_CHAT_KEY: "chat:worker", OCTIQ_CHAT_CAPABILITY: "secret-one" }, "tools/call", accept);
  assert.equal(requests[0].url, "/hook/orchestration");
  assert.equal(requests[0].capability, "secret-one");
  assert.equal(requests[0].body.chatKey, "chat:worker", "the chat comes from the process, never the tool arguments");
  assert.equal(requests[0].body.action, "task_accept");
  assert.ok(!("sessionKey" in requests[0].body), "a chat's own process needs no session key");

  // An additional agent's process names the key its capability was issued to.
  await call(root, { OCTIQ_CHAT_KEY: "chat:worker", OCTIQ_SESSION_KEY: "chat:worker#2", OCTIQ_CHAT_CAPABILITY: "secret-two" }, "tools/call", accept);
  assert.equal(requests[1].capability, "secret-two");
  assert.equal(requests[1].body.sessionKey, "chat:worker#2");
});

test("every hook call carries the launch's capability and never the person's token", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-hook-credential-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, capability: req.headers["x-octiq-chat-capability"] });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ result: {}, answer: "fine" }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  fs.writeFileSync(path.join(root, "web.json"), JSON.stringify({ port: server.address().port, token: "test-token" }));
  const env = { OCTIQ_CHAT_KEY: "chat:worker", OCTIQ_CHAT_CAPABILITY: "secret-one", OCTIQ_HOOK_PORT: String(server.address().port) };

  const calls = [
    { name: "ask_user", arguments: { questions: [{ question: "Which one?", header: "Pick", options: [{ label: "A" }, { label: "B" }] }] } },
    { name: "set_chat_title", arguments: { title: "A title" } },
    { name: "vault_read", arguments: { path: "a.md" } },
    { name: "feedback_list", arguments: {} },
    { name: "orchestration_snapshot", arguments: {} },
  ];
  for (const params of calls) await call(root, env, "tools/call", params);
  assert.deepEqual(requests.map(r => r.url.split("?")[0]), ["/hook/ask", "/hook/task", "/hook/vault", "/hook/feedback", "/hook/orchestration"]);
  for (const request of requests) {
    assert.ok(!request.url.includes("token"), `${request.url} carries no token`);
    assert.equal(request.capability, "secret-one", request.url);
  }
});

test("a peer request names a teammate, the work and its result, and never who is asking", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-peer-request-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, capability: req.headers["x-octiq-chat-capability"], body: JSON.parse(body) });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ result: { taskId: "task_1", status: "awaiting_approval" } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  fs.writeFileSync(path.join(root, "web.json"), JSON.stringify({ port: server.address().port, token: "test-token" }));
  const env = { OCTIQ_CHAT_KEY: "chat:lead", OCTIQ_CHAT_CAPABILITY: "secret-one", OCTIQ_HOOK_PORT: String(server.address().port) };

  const listed = await call(root, env, "tools/list", {});
  const tool = listed.tools.find(candidate => candidate.name === "orchestration_peer_request");
  assert.ok(tool, "a lead's chat is offered the tool");
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(),
    ["maxMinutes", "output", "peer", "project", "repository", "request", "title"]);
  assert.deepEqual(tool.inputSchema.required, ["peer", "title", "request", "output"]);
  assert.deepEqual(
    [tool.inputSchema.properties.maxMinutes.type, tool.inputSchema.properties.maxMinutes.minimum, tool.inputSchema.properties.maxMinutes.maximum],
    ["integer", 1, 120]);
  // The text bounds are the host's (peer_request.rs), stated in the schema too.
  assert.deepEqual(
    ["title", "request", "output"].map(name => tool.inputSchema.properties[name].maxLength),
    [240, 4000, 1000]);
  // The limit is working time, and nothing extends it.
  assert.match(tool.inputSchema.properties.maxMinutes.description, /working time; waiting for a decision does not count, and it is not extended/);
  assert.match(tool.description, /minutes of working time; waiting for a decision\s+does not count, and it is not extended/);
  assert.match(tool.description, /There is no way to add time: a longer job is a new\s+request/);
  // The requester is the chat the capability proves: no argument names it.
  for (const name of ["requester", "requestedBy", "agent", "chatKey", "attemptId", "runId"]) {
    assert.ok(!(name in tool.inputSchema.properties), `${name} is not an argument`);
  }
  assert.match(tool.description, /waits on the plan card for the person's approval/);
  assert.match(tool.description, /Nobody's reportsTo\s+changes/);
  assert.match(tool.description, /2 requests per worker attempt, 3 open at once per lead chat/);
  // The question tool says it is no longer a worker's alone, and sends work here.
  const ask = listed.tools.find(candidate => candidate.name === "orchestration_peer_ask");
  assert.match(ask.description, /a registered lead in its own agents-mode chat/);
  assert.match(ask.description, /orchestration_peer_request/);
  assert.ok(!/workers only/.test(ask.description));
  // A worker is offered both too.
  const worker = await call(root, { ...env, OCTIQ_CHAT_KEY: "chat:orch-1", OCTIQ_ORCHESTRATION_ATTEMPT: "attempt_1" }, "tools/list", {});
  for (const name of ["orchestration_peer_ask", "orchestration_peer_request"]) {
    assert.ok(worker.tools.some(candidate => candidate.name === name), `a worker is offered ${name}`);
  }

  const args = { peer: "NAS OPS", title: "Report volume usage", request: "Read each volume's usage.", output: "One line per volume.", maxMinutes: 20, chatKey: "chat:someone-else" };
  const answer = await call(root, env, "tools/call", { name: "orchestration_peer_request", arguments: args });
  assert.ok(!answer.isError, JSON.stringify(answer));
  assert.equal(JSON.parse(answer.content[0].text).status, "awaiting_approval");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/hook/orchestration");
  assert.equal(requests[0].capability, "secret-one");
  assert.equal(requests[0].body.action, "peer_request");
  assert.equal(requests[0].body.chatKey, "chat:lead", "the chat comes from the process, never the tool arguments");
  assert.equal(requests[0].body.args.peer, "NAS OPS");
  assert.equal(requests[0].body.args.maxMinutes, 20);
});

test("without the host's hook port nothing is sent, whatever web.json says", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-hook-noport-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let requests = 0;
  const server = http.createServer((req, res) => { requests += 1; res.end("{}"); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  fs.writeFileSync(path.join(root, "web.json"), JSON.stringify({ port: server.address().port, token: "test-token" }));
  const env = { OCTIQ_CHAT_KEY: "chat:worker", OCTIQ_CHAT_CAPABILITY: "secret-one", OCTIQ_HOOK_PORT: "" };
  const snapshot = await call(root, env, "tools/call", { name: "orchestration_snapshot", arguments: {} });
  assert.equal(snapshot.isError, true);
  assert.match(snapshot.content[0].text, /not reachable/);
  await call(root, env, "tools/call", { name: "ask_user", arguments: { questions: [{ question: "Which one?", header: "Pick", options: [{ label: "A" }, { label: "B" }] }] } });
  assert.equal(requests, 0);
});
