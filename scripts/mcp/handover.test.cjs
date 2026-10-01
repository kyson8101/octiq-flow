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

test("ask back and outcome are offered beside handover, never to a worker", async () => {
  const chat = await mcp({ OCTIQ_CHAT_KEY: "chat:one" }, "tools/list");
  const names = chat.result.tools.map((t) => t.name);
  assert.ok(names.includes("handover_ask") && names.includes("handover_outcome"));
  const askTool = chat.result.tools.find((t) => t.name === "handover_ask");
  assert.deepEqual(askTool.inputSchema.required, ["question", "requestId"]);
  assert.match(askTool.description, /read-only turn/);
  assert.match(askTool.description, /never an instruction, an approval or a permission/);
  assert.ok(!("chatKey" in askTool.inputSchema.properties), "the other chat is never an argument");
  const outcomeTool = chat.result.tools.find((t) => t.name === "handover_outcome");
  assert.deepEqual(outcomeTool.inputSchema.properties.status.enum, ["done", "blocked"]);
  assert.match(outcomeTool.description, /starts no turn there/);

  const worker = await mcp({ OCTIQ_CHAT_KEY: "chat:orch-w", OCTIQ_ORCHESTRATION_ATTEMPT: "attempt_1" }, "tools/list");
  const hidden = worker.result.tools.map((t) => t.name);
  assert.ok(!hidden.includes("handover_ask") && !hidden.includes("handover_outcome"));
});

test("ask back and outcome send only their own fields, as this chat", async () => {
  const fake = await host({ result: { text: "Codex answered. Its words, quoted:\n\n> Use the lock." } });
  try {
    const env = { OCTIQ_CHAT_KEY: "chat:new", OCTIQ_HOOK_PORT: String(fake.port), OCTIQ_CHAT_CAPABILITY: "cap" };
    const asked = await mcp(env, "tools/call", {
      name: "handover_ask",
      arguments: {
        question: "Which lock?",
        contextPaths: ["src/a.rs", 7],
        requestId: "q1",
        // Not in the schema: must never reach the host.
        sourceChatKey: "chat:elsewhere",
      },
    });
    assert.equal(asked.result.isError, undefined);
    assert.match(asked.result.content[0].text, /> Use the lock\./);
    const reported = await mcp(env, "tools/call", {
      name: "handover_outcome",
      arguments: { status: "done", summary: "Shipped.", requestId: "o1", approve: "push" },
    });
    assert.equal(reported.result.isError, undefined);

    const [ask, outcome] = fake.seen;
    assert.equal(ask.path, "/hook/handover/ask");
    assert.equal(ask.headers["x-octiq-chat-capability"], "cap");
    assert.equal(ask.body.chatKey, "chat:new");
    assert.deepEqual(ask.body.args, { question: "Which lock?", contextPaths: ["src/a.rs"], requestId: "q1" });
    assert.ok(!JSON.stringify(ask.body).includes("elsewhere"));
    assert.equal(outcome.path, "/hook/handover/outcome");
    assert.deepEqual(outcome.body.args, { status: "done", summary: "Shipped.", requestId: "o1" });
  } finally {
    fake.close();
  }
});

test("a refused ask back comes back as a tool error with the host's reason", async () => {
  const fake = await host({ error: "This chat was not started by a confirmed handover, so there is no original chat to ask or report to." });
  try {
    const env = { OCTIQ_CHAT_KEY: "chat:plain", OCTIQ_HOOK_PORT: String(fake.port), OCTIQ_CHAT_CAPABILITY: "cap" };
    for (const name of ["handover_ask", "handover_outcome"]) {
      const refused = await mcp(env, "tools/call", {
        name,
        arguments: { question: "Q?", status: "done", summary: "x", requestId: "r" },
      });
      assert.equal(refused.result.isError, true);
      assert.match(refused.result.content[0].text, /not started by a confirmed handover/);
    }
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
