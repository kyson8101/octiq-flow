"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

function call(root, chatKey, method, params, flags = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "octiq-ask.cjs"), ...flags], {
      env: { ...process.env, OCTIQ_SESSION_KEY: "", OCTIQ_CHAT_CAPABILITY: "", OCTIQ_ROOT: root, OCTIQ_CHAT_KEY: chatKey }, stdio: ["pipe", "pipe", "pipe"],
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

test("feedback tools are chat-bound, discoverable by both providers, and mark only the reads read-only", async () => {
  for (const flags of [[], ["--disable-ask-user"]]) {
    const result = await call("", "chat:current", "tools/list", {}, flags);
    const tools = result.tools.filter(tool => tool.name.startsWith("feedback_"));
    assert.deepEqual(tools.map(tool => tool.name), ["feedback_submit", "feedback_list", "feedback_get", "feedback_update"]);
    for (const tool of tools) {
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.ok(!("chatKey" in tool.inputSchema.properties));
      assert.ok(!("source" in tool.inputSchema.properties));
      assert.ok(!("updatedBy" in tool.inputSchema.properties));
    }
    // A write marked read-only would skip the card a read-only chat asks on.
    assert.deepEqual(tools.map(tool => tool.annotations.readOnlyHint), [false, true, true, false]);
    const update = tools.at(-1);
    assert.deepEqual(Object.keys(update.inputSchema.properties), ["id", "status", "note", "expectedRevision"]);
    assert.deepEqual(update.inputSchema.required, ["id", "status"]);
    assert.deepEqual(update.inputSchema.properties.status.enum, ["new", "triaged", "in_progress", "resolved", "dismissed"]);
    assert.match(update.description, /verified it yourself/);
    assert.match(update.description, /commit or release/);
    assert.match(update.description, /duplicate or cannot be reproduced/);
    const initialized = await call("", "chat:current", "initialize", {}, flags);
    assert.match(initialized.instructions, /feedback_submit/);
    assert.match(initialized.instructions, /feedback_update/);
  }
  const standalone = await call("", "", "tools/list", {});
  assert.ok(!standalone.tools.some(tool => tool.name.startsWith("feedback_")));
  for (const [name, args] of [["feedback_submit", {}], ["feedback_update", { id: "report-one", status: "resolved" }]]) {
    const rejected = await call("", "", "tools/call", { name, arguments: args });
    assert.equal(rejected.isError, true, name);
  }
});

test("feedback uses process identity, preserves retry IDs, and surfaces host failures", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-feedback-mcp-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requests = [];
  let status = 200, response = { result: { id: "report-one", status: "new", revision: 1 } };
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, body: JSON.parse(body) });
    res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(response));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  // The person's token sits in web.json; the MCP must neither need nor send it.
  fs.writeFileSync(path.join(root, "web.json"), JSON.stringify({ port: server.address().port, token: "test-token" }));
  process.env.OCTIQ_HOOK_PORT = String(server.address().port);
  t.after(() => { delete process.env.OCTIQ_HOOK_PORT; });
  const submit = args => call(root, "chat:current", "tools/call", { name: "feedback_submit", arguments: args });
  const args = { requestId: "stable-retry", title: "Queue stalls", kind: "bug", severity: "high", description: "After Stop", actual: "No next turn" };
  const result = await submit({ ...args, chatKey: "chat:other", source: { appVersion: "fake" }, status: "resolved" });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), response.result);
  await submit(args);
  assert.deepEqual(requests, Array(2).fill({ url: "/hook/feedback", body: { chatKey: "chat:current", action: "submit", args } }));
  await call(root, "chat:current", "tools/call", { name: "feedback_list", arguments: { query: "Queue", limit: 5 } });
  assert.equal(requests.at(-1).body.action, "list");
  await call(root, "chat:current", "tools/call", { name: "feedback_get", arguments: { id: "report-one" } });
  assert.equal(requests.at(-1).body.action, "get");
  status = 400; response = { error: "Feedback was not saved: disk full" };
  const failed = await submit(args);
  assert.equal(failed.isError, true); assert.match(failed.content[0].text, /not saved/);
});

test("feedback_update sends only its documented fields and reports a refused save", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-feedback-mcp-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requests = [];
  let status = 200, response = { result: { id: "report-one", status: "resolved", note: "Fixed in abc1234", revision: 3, updatedBy: { kind: "agent", chatId: "current", chatTitle: "Fix" } } };
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, body: JSON.parse(body) });
    res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(response));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  fs.writeFileSync(path.join(root, "web.json"), JSON.stringify({ port: server.address().port, token: "test-token" }));
  process.env.OCTIQ_HOOK_PORT = String(server.address().port);
  t.after(() => { delete process.env.OCTIQ_HOOK_PORT; });
  const update = args => call(root, "chat:current", "tools/call", { name: "feedback_update", arguments: args });
  const args = { id: "report-one", status: "resolved", note: "Fixed in abc1234", expectedRevision: 2 };
  // Who updated it is the host's to say: nothing the model adds crosses the hook.
  const saved = await update({ ...args, chatKey: "chat:other", source: { chatId: "other" }, updatedBy: { kind: "person" }, title: "Rewritten" });
  assert.equal(saved.isError, undefined);
  assert.deepEqual(JSON.parse(saved.content[0].text), response.result);
  assert.deepEqual(requests.at(-1), { url: "/hook/feedback", body: { chatKey: "chat:current", action: "update", args } });
  // An omitted note and revision stay omitted, so the host keeps the note.
  await update({ id: "report-one", status: "in_progress" });
  assert.deepEqual(requests.at(-1).body, { chatKey: "chat:current", action: "update", args: { id: "report-one", status: "in_progress" } });
  status = 400; response = { error: "This report is at revision 4, not the expected one. Read it again with feedback_get before updating." };
  const stale = await update(args);
  assert.equal(stale.isError, true); assert.match(stale.content[0].text, /revision 4/);
  // No chat, no call: a standalone MCP never reaches the host.
  const count = requests.length;
  assert.equal((await call(root, "", "tools/call", { name: "feedback_update", arguments: args })).isError, true);
  assert.equal(requests.length, count);
});
