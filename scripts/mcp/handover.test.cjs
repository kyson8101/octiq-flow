"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

/** One JSON-RPC call to a fresh MCP process with `env` on top. */
function mcp(env, method, params, scriptArgs = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-handover-mcp-"));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "octiq-ask.cjs"), ...scriptArgs], {
      env: { ...process.env, OCTIQ_ROOT: root, OCTIQ_ORCHESTRATION_ATTEMPT: "", ...env },
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
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n");
  });
}

/** A stand-in host that records what reached /hook/handover. */
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

const BRIEF = {
  recipient: "Mango",
  requestId: "r1",
  project: "App",
  brief: {
    objective: "Finish the login fix",
    remaining: "Write the test",
    state: { branch: "fix/login", uncommitted: true },
    authorized: ["commit on the task branch"],
    notAuthorized: ["push"],
  },
  // Not in the schema: must never reach the host.
  model: "opus",
  access: "full",
};

test("handover is offered to ordinary chats and not to orchestration workers", async () => {
  const chat = await mcp({ OCTIQ_CHAT_KEY: "chat:one" }, "tools/list");
  const tool = chat.result.tools.find((t) => t.name === "handover");
  assert.ok(tool, "offered in a chat");
  assert.deepEqual(tool.inputSchema.required, ["recipient", "requestId", "brief"]);
  assert.ok(!("model" in tool.inputSchema.properties) && !("access" in tool.inputSchema.properties));
  assert.match(tool.description, /not for splitting work/);
  assert.match(tool.description, /nothing starts until THEY confirm/);

  const worker = await mcp({ OCTIQ_CHAT_KEY: "chat:orch-w", OCTIQ_ORCHESTRATION_ATTEMPT: "attempt_1" }, "tools/list");
  assert.ok(!worker.result.tools.some((t) => t.name === "handover"), "hidden from a worker");

  const standalone = await mcp({ OCTIQ_CHAT_KEY: "" }, "tools/list");
  assert.ok(!standalone.result.tools.some((t) => t.name === "handover"));
});

test("the call sends only the brief, as this chat, waiting on Claude and not on Codex", async () => {
  const fake = await host({ result: { id: "handover_1", text: "The person confirmed handover handover_1." } });
  try {
    const env = { OCTIQ_CHAT_KEY: "chat:one", OCTIQ_HOOK_PORT: String(fake.port), OCTIQ_CHAT_CAPABILITY: "cap" };
    const claude = await mcp(env, "tools/call", { name: "handover", arguments: BRIEF });
    assert.equal(claude.result.isError, undefined);
    assert.match(claude.result.content[0].text, /confirmed/);
    const codex = await mcp(env, "tools/call", { name: "handover", arguments: BRIEF }, ["--disable-ask-user"]);
    assert.equal(codex.result.isError, undefined);

    assert.equal(fake.seen.length, 2);
    const [first, second] = fake.seen;
    assert.equal(first.path, "/hook/handover");
    assert.equal(first.headers["x-octiq-chat-capability"], "cap");
    assert.equal(first.body.chatKey, "chat:one");
    assert.equal(first.body.wait, true);
    assert.equal(second.body.wait, false, "Codex hears the decision as a new turn");
    assert.deepEqual(Object.keys(first.body.args).sort(), ["brief", "project", "recipient", "requestId"]);
    assert.equal(first.body.args.brief.state.uncommitted, true);
    assert.deepEqual(first.body.args.brief.notAuthorized, ["push"]);
    assert.ok(!JSON.stringify(first.body).includes("opus"), "no settings cross");
  } finally {
    fake.close();
  }
});

test("a host refusal comes back as a tool error carrying its reason", async () => {
  const fake = await host({ error: "Orchestration workers cannot hand over their task." });
  try {
    const env = { OCTIQ_CHAT_KEY: "chat:orch-w", OCTIQ_HOOK_PORT: String(fake.port), OCTIQ_ORCHESTRATION_ATTEMPT: "attempt_1" };
    const refused = await mcp(env, "tools/call", { name: "handover", arguments: BRIEF });
    assert.equal(refused.result.isError, true);
    assert.match(refused.result.content[0].text, /cannot hand over/);
  } finally {
    fake.close();
  }
});
