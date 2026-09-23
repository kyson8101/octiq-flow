"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

function mcp(root, chatKey, method, params, scriptArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "octiq-ask.cjs"), ...scriptArgs], {
      env: { ...process.env, OCTIQ_ROOT: root, OCTIQ_CHAT_KEY: chatKey },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error("MCP timed out")); }, 5000);
    let out = "";
    child.on("error", reject);
    child.on("exit", () => { clearTimeout(timer); if (!out) reject(new Error("MCP exited without a response")); });
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.includes("\n")) {
        clearTimeout(timer);
        resolve(JSON.parse(out.split("\n")[0]).result);
        child.stdin.end();
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n");
  });
}

test("title tool is chat-bound and offered to both Claude and Codex", async () => {
  for (const flags of [[], ["--disable-ask-user"]]) {
    const bound = await mcp("", "chat:current", "tools/list", {}, flags);
    const tool = bound.tools.find((tool) => tool.name === "set_chat_title");
    assert.deepEqual(tool.inputSchema.required, ["title"]);
    assert.deepEqual(Object.keys(tool.inputSchema.properties), ["title"]);
  }
  const standalone = await mcp("", "", "tools/list");
  assert.ok(!standalone.tools.some((tool) => tool.name === "set_chat_title"));
  const denied = await mcp("", "", "tools/call", {
    name: "set_chat_title", arguments: { title: "No chat" },
  });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /requires an OctiqFlow chat/);
});

test("title calls use the process chat, propagate kept titles and surface host errors", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-title-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requests = [];
  let response = { result: { title: "Fix chat titles", updated: true, reason: "Title updated." } };
  let status = 200;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, body: JSON.parse(body) });
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  fs.writeFileSync(path.join(root, "web.json"), JSON.stringify({ port: server.address().port, token: "test-token" }));
  const call = (args) => mcp(root, "chat:current", "tools/call", { name: "set_chat_title", arguments: args });

  const updated = await call({ title: "Fix chat titles", chatId: "other", chatKey: "chat:other" });
  assert.ok(!updated.isError);
  assert.deepEqual(JSON.parse(updated.content[0].text), response.result);
  assert.deepEqual(requests, [{
    url: "/hook/task?token=test-token",
    body: { chatKey: "chat:current", action: "title", args: { title: "Fix chat titles" } },
  }]);

  response = { result: { title: "My chosen title", updated: false, reason: "The user chose this title; it has been kept." } };
  const kept = await call({ title: "Agent suggestion" });
  assert.ok(!kept.isError);
  assert.deepEqual(JSON.parse(kept.content[0].text), response.result);

  status = 400;
  response = { error: "This chat is not in the active chat index." };
  const failed = await call({ title: "Missing chat" });
  assert.equal(failed.isError, true);
  assert.equal(failed.content[0].text, response.error);

  const before = requests.length;
  for (const title of [undefined, 42, " \n "]) {
    assert.equal((await call({ title })).isError, true);
  }
  assert.equal(requests.length, before, "invalid titles must not be sent to the host");
});
