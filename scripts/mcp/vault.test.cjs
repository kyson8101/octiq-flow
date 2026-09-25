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

test("both providers discover native vault tools without another MCP server", async () => {
  for (const flags of [[], ["--disable-ask-user"]]) {
    const result = await call("", "chat:current", "tools/list", {}, flags);
    const tools = result.tools.filter(tool => tool.name.startsWith("vault_"));
    assert.equal(tools.length, 11);
    assert.ok(tools.some(tool => tool.name === "vault_search"));
    assert.ok(tools.some(tool => tool.name === "vault_agent_memory_read"));
    assert.ok(tools.some(tool => tool.name === "vault_agent_memory_append"));
    assert.ok(tools.some(tool => tool.name === "vault_patch"));
    assert.ok(!tools.some(tool => /config|delete/.test(tool.name)));
    for (const tool of tools) {
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.ok(!("chatKey" in tool.inputSchema.properties));
      assert.ok(!("root" in tool.inputSchema.properties));
    }
  }
  const standalone = await call("", "", "tools/list", {});
  assert.ok(!standalone.tools.some(tool => tool.name.startsWith("vault_")));
  const rejected = await call("", "", "tools/call", { name: "vault_read", arguments: { path: "a.md" } });
  assert.equal(rejected.isError, true);
});

test("vault calls route to the native host with process identity and bounded schemas", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-vault-mcp-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requests = [];
  let status = 200;
  let response = { result: { status: "saved", id: "receipt", revision: "new" } };
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, body: JSON.parse(body) });
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  fs.writeFileSync(path.join(root, "web.json"), JSON.stringify({ port: server.address().port, token: "test-token" }));
  const write = args => call(root, "chat:current", "tools/call", { name: "vault_write", arguments: args });
  const args = { path: "project/progress.md", content: "共享 memory", mode: "append", expectedRevision: "old", requestId: "one" };
  const saved = await write({ ...args, chatKey: "chat:other", root: "/etc", writable: true, actor: "browser" });
  assert.equal(saved.isError, undefined);
  assert.deepEqual(JSON.parse(saved.content[0].text), response.result);
  assert.deepEqual(requests[0], { url: "/hook/vault?token=test-token", body: { chatKey: "chat:current", action: "write", args } });
  response = { result: { status: "needs_review", id: "receipt" } };
  assert.equal((await write(args)).isError, true);
  status = 400; response = { error: "Revision conflict: read the current note before retrying." };
  const conflict = await write(args);
  assert.equal(conflict.isError, true);
  assert.match(conflict.content[0].text, /Revision conflict/);
  const count = requests.length;
  assert.equal((await call(root, "chat:current", "tools/call", { name: "vault_configure", arguments: { path: "/" } })).isError, true);
  assert.equal(requests.length, count);
});
