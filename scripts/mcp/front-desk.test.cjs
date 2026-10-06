"use strict";
// The front desk's MCP: one tool, route_chat, and nothing else.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

/** One JSON-RPC call to a fresh MCP process with `env` on top. */
function mcp(env, method, params) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-front-desk-mcp-"));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "octiq-ask.cjs")], {
      env: { ...process.env, OCTIQ_ROOT: root, OCTIQ_ORCHESTRATION_ATTEMPT: "", OCTIQ_FRONT_DESK: "", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let errors = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.includes("\n")) {
        resolve(JSON.parse(out.split("\n")[0]));
        child.stdin.end();
      }
    });
    child.stderr.on("data", (chunk) => (errors += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (!out) reject(Error(`MCP exited ${code}: ${errors}`));
    });
    child.on("close", () => fs.rmSync(root, { recursive: true, force: true }));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n");
  });
}

/** A stand-in host that records what reached it. */
async function host(answer) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ path: req.url, headers: req.headers, body: JSON.parse(body) });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { seen, port: server.address().port, close: () => server.close() };
}

test("a front desk is offered route_chat and nothing else; other chats are not offered it", async () => {
  const desk = await mcp({ OCTIQ_CHAT_KEY: "chat:desk", OCTIQ_FRONT_DESK: "1" }, "tools/list");
  assert.deepEqual(desk.result.tools.map((t) => t.name), ["route_chat"]);
  const tool = desk.result.tools[0];
  assert.deepEqual(tool.inputSchema.required, ["agent", "brief", "requestId"]);
  assert.ok(!("model" in tool.inputSchema.properties) && !("access" in tool.inputSchema.properties));
  assert.match(tool.description, /nothing is created unless THEY confirm/);
  // Without it Claude's plan mode asks before the allow rule is consulted.
  assert.equal(tool.annotations?.readOnlyHint, true, "route_chat is read-only");

  const init = await mcp({ OCTIQ_CHAT_KEY: "chat:desk", OCTIQ_FRONT_DESK: "1" }, "initialize", {});
  assert.match(init.result.instructions, /You are a front desk/);
  assert.doesNotMatch(init.result.instructions, /orchestration/);

  const chat = await mcp({ OCTIQ_CHAT_KEY: "chat:one" }, "tools/list");
  assert.ok(!chat.result.tools.some((t) => t.name === "route_chat"), "not offered to an ordinary chat");
  assert.ok(chat.result.tools.some((t) => t.name === "handover"));
});

test("a front desk calling any other tool by name is refused before it reaches the host", async () => {
  const fake = await host({ result: { id: "x" } });
  try {
    const env = { OCTIQ_CHAT_KEY: "chat:desk", OCTIQ_FRONT_DESK: "1", OCTIQ_HOOK_PORT: String(fake.port), OCTIQ_CHAT_CAPABILITY: "cap" };
    for (const name of ["orchestration_run_create", "handover", "vault_write", "task_status"]) {
      const refused = await mcp(env, "tools/call", { name, arguments: {} });
      assert.equal(refused.result.isError, true, name);
      assert.match(refused.result.content[0].text, /only routes/);
    }
    assert.equal(fake.seen.length, 0);
  } finally {
    fake.close();
  }
});

test("route_chat sends only the documented fields to /hook/route, as this chat", async () => {
  const fake = await host({ result: { id: "handover_1", text: "The person now sees a card." } });
  try {
    const env = { OCTIQ_CHAT_KEY: "chat:desk", OCTIQ_FRONT_DESK: "1", OCTIQ_HOOK_PORT: String(fake.port), OCTIQ_CHAT_CAPABILITY: "cap" };
    const answer = await mcp(env, "tools/call", {
      name: "route_chat",
      arguments: {
        agent: "agent_mango",
        project: "App",
        brief: "Fix the login bug on phones.",
        attachments: ["/x/a.png", 7],
        requestId: "r1",
        // Not in the schema: must never reach the host.
        model: "opus",
        access: "full",
      },
    });
    assert.equal(answer.result.isError, undefined);
    assert.match(answer.result.content[0].text, /card/);
    assert.equal(fake.seen.length, 1);
    const [call] = fake.seen;
    assert.equal(call.path, "/hook/route");
    assert.equal(call.headers["x-octiq-chat-capability"], "cap");
    assert.equal(call.body.chatKey, "chat:desk");
    assert.equal(call.body.wait, undefined, "a route never holds the call open");
    assert.deepEqual(call.body.args, {
      agent: "agent_mango",
      project: "App",
      brief: "Fix the login bug on phones.",
      attachments: ["/x/a.png"],
      requestId: "r1",
    });
  } finally {
    fake.close();
  }
});
