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
      env: { ...process.env, OCTIQ_ROOT: root, OCTIQ_CHAT_KEY: chatKey }, stdio: ["pipe", "pipe", "pipe"],
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

test("feedback tools are chat-bound, discoverable by both providers, and exclude triage", async () => {
  for (const flags of [[], ["--disable-ask-user"]]) {
    const result = await call("", "chat:current", "tools/list", {}, flags);
    const tools = result.tools.filter(tool => tool.name.startsWith("feedback_"));
    assert.deepEqual(tools.map(tool => tool.name), ["feedback_submit", "feedback_list", "feedback_get"]);
    for (const tool of tools) {
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.ok(!("chatKey" in tool.inputSchema.properties));
      assert.ok(!("source" in tool.inputSchema.properties));
    }
    const initialized = await call("", "chat:current", "initialize", {}, flags);
    assert.match(initialized.instructions, /feedback_submit/);
  }
  const standalone = await call("", "", "tools/list", {});
  assert.ok(!standalone.tools.some(tool => tool.name.startsWith("feedback_")));
  const rejected = await call("", "", "tools/call", { name: "feedback_submit", arguments: {} });
  assert.equal(rejected.isError, true);
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
  fs.writeFileSync(path.join(root, "web.json"), JSON.stringify({ port: server.address().port, token: "test-token" }));
  const submit = args => call(root, "chat:current", "tools/call", { name: "feedback_submit", arguments: args });
  const args = { requestId: "stable-retry", title: "Queue stalls", kind: "bug", severity: "high", description: "After Stop", actual: "No next turn" };
  const result = await submit({ ...args, chatKey: "chat:other", source: { appVersion: "fake" }, status: "resolved" });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), response.result);
  await submit(args);
  assert.deepEqual(requests, Array(2).fill({ url: "/hook/feedback?token=test-token", body: { chatKey: "chat:current", action: "submit", args } }));
  await call(root, "chat:current", "tools/call", { name: "feedback_list", arguments: { query: "Queue", limit: 5 } });
  assert.equal(requests.at(-1).body.action, "list");
  await call(root, "chat:current", "tools/call", { name: "feedback_get", arguments: { id: "report-one" } });
  assert.equal(requests.at(-1).body.action, "get");
  status = 400; response = { error: "Feedback was not saved: disk full" };
  const failed = await submit(args);
  assert.equal(failed.isError, true); assert.match(failed.content[0].text, /not saved/);
  const count = requests.length;
  assert.equal((await call(root, "chat:current", "tools/call", { name: "feedback_update", arguments: { id: "report-one", status: "resolved" } })).isError, true);
  assert.equal(requests.length, count);
});
