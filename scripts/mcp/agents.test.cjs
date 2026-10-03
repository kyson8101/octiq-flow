"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

function call(env, method, params, flags = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "octiq-ask.cjs"), ...flags], {
      env: { ...process.env, OCTIQ_SESSION_KEY: "", OCTIQ_CHAT_CAPABILITY: "", OCTIQ_ORCHESTRATION_ATTEMPT: "", ...env },
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

const agentTools = result => result.tools.filter(tool => tool.name.startsWith("agent_")).map(tool => tool.name);

test("agent tools are offered to both providers, list-only for a worker, none outside a chat", async () => {
  for (const flags of [[], ["--disable-ask-user"]]) {
    const listed = await call({ OCTIQ_CHAT_KEY: "chat:lead" }, "tools/list", {}, flags);
    assert.deepEqual(agentTools(listed), ["agent_list", "agent_register", "agent_update"]);
    for (const tool of listed.tools.filter(tool => tool.name.startsWith("agent_"))) {
      assert.equal(tool.inputSchema.additionalProperties, false);
      // Identity and the card's deadline are never the agent's to say.
      for (const key of ["chatKey", "waitSeconds", "avatar", "id"]) assert.ok(!(key in tool.inputSchema.properties), `${tool.name}: ${key}`);
    }
    const register = listed.tools.find(tool => tool.name === "agent_register");
    assert.deepEqual(register.inputSchema.required, ["name", "provider", "model"]);
    assert.equal(register.annotations.readOnlyHint, false);
    assert.match(register.description, /approves or declines it on a card/);
  }
  const worker = await call({ OCTIQ_CHAT_KEY: "chat:orch-w", OCTIQ_ORCHESTRATION_ATTEMPT: "attempt_1" }, "tools/list", {});
  assert.deepEqual(agentTools(worker), ["agent_list"]);
  const desk = await call({ OCTIQ_CHAT_KEY: "chat:desk", OCTIQ_FRONT_DESK: "1" }, "tools/list", {});
  assert.deepEqual(agentTools(desk), []);
  const standalone = await call({ OCTIQ_CHAT_KEY: "" }, "tools/list", {});
  assert.deepEqual(agentTools(standalone), []);
  assert.equal((await call({ OCTIQ_CHAT_KEY: "" }, "tools/call", { name: "agent_list", arguments: {} })).isError, true);
});

test("agent calls go to /hook/agents with only documented fields and the provider's wait", async t => {
  const requests = [];
  let status = 200, response = { result: { status: "saved", text: "The person approved it: Nova is registered." } };
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, body: JSON.parse(body) });
    res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(response));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { OCTIQ_CHAT_KEY: "chat:lead", OCTIQ_HOOK_PORT: String(server.address().port) };

  const args = { name: "Nova", provider: "codex", model: "gpt-5.5", project: "Starfall", reportsTo: "Potato" };
  const claude = await call(env, "tools/call", { name: "agent_register", arguments: { ...args, chatKey: "chat:other", avatar: "data:x", waitSeconds: 1 } });
  assert.equal(claude.isError, undefined);
  assert.deepEqual(JSON.parse(claude.content[0].text), response.result);
  assert.deepEqual(requests.at(-1), { url: "/hook/agents", body: { chatKey: "chat:lead", action: "register", args: { ...args, waitSeconds: 180 } } });

  await call(env, "tools/call", { name: "agent_update", arguments: { agent: "Nova", role: "Leads." } }, ["--disable-ask-user"]);
  assert.deepEqual(requests.at(-1).body, { chatKey: "chat:lead", action: "update", args: { agent: "Nova", role: "Leads.", waitSeconds: 50 } });

  await call(env, "tools/call", { name: "agent_list", arguments: { project: "Starfall" } });
  assert.deepEqual(requests.at(-1).body, { chatKey: "chat:lead", action: "list", args: { project: "Starfall" } });

  status = 400; response = { error: "The person declined this change, so nothing was changed." };
  const declined = await call(env, "tools/call", { name: "agent_update", arguments: { agent: "Nova", role: "x" } });
  assert.equal(declined.isError, true);
  assert.match(declined.content[0].text, /declined/);

  // A worker may read the roster but not propose a change; nothing is sent.
  const count = requests.length;
  const worker = await call({ ...env, OCTIQ_ORCHESTRATION_ATTEMPT: "attempt_1" }, "tools/call", { name: "agent_register", arguments: args });
  assert.equal(worker.isError, true);
  assert.equal(requests.length, count);
});
