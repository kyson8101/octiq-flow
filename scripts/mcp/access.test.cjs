"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

function call(env, method, params, flags = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "octiq-ask.cjs"), ...flags], {
      env: { ...process.env, OCTIQ_SESSION_KEY: "", OCTIQ_CHAT_CAPABILITY: "", OCTIQ_ORCHESTRATION_ATTEMPT: "", OCTIQ_FRONT_DESK: "", ...env },
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

const offered = result => result.tools.some(tool => tool.name === "request_access");

test("request_access is offered to a chat's own agent on both providers, and to no worker, desk or stranger", async () => {
  for (const flags of [[], ["--disable-ask-user"]]) {
    const listed = await call({ OCTIQ_CHAT_KEY: "chat:lead" }, "tools/list", {}, flags);
    const tool = listed.tools.find(candidate => candidate.name === "request_access");
    assert.ok(tool);
    assert.deepEqual(tool.inputSchema.required, ["level", "reason"]);
    // Asking for less is the picker's; asking for "read" would be no raise.
    assert.deepEqual(tool.inputSchema.properties.level.enum, ["manual", "edits", "auto", "full"]);
    assert.equal(tool.inputSchema.additionalProperties, false);
    for (const key of ["chatKey", "current", "wait"]) assert.ok(!(key in tool.inputSchema.properties), key);
    assert.match(tool.description, /calling this changes nothing by itself/);
  }
  assert.equal(offered(await call({ OCTIQ_CHAT_KEY: "chat:orch-w", OCTIQ_ORCHESTRATION_ATTEMPT: "attempt_1" }, "tools/list", {})), false);
  assert.equal(offered(await call({ OCTIQ_CHAT_KEY: "chat:desk", OCTIQ_FRONT_DESK: "1" }, "tools/list", {})), false);
  assert.equal(offered(await call({ OCTIQ_CHAT_KEY: "" }, "tools/list", {})), false);
});

test("a request goes to /hook/access with only the level and the reason, and hands back the host's words", async t => {
  const requests = [];
  let status = 200, response = { result: "The person raised this chat's access to Accept edits. It applies now: carry on with the work." };
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, body: JSON.parse(body), capability: req.headers["x-octiq-chat-capability"] });
    res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(response));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { OCTIQ_CHAT_KEY: "chat:lead", OCTIQ_HOOK_PORT: String(server.address().port), OCTIQ_CHAT_CAPABILITY: "cap-1" };

  const raised = await call(env, "tools/call", { name: "request_access", arguments: { level: "edits", reason: "Write the fix.", chatKey: "chat:other", current: "full" } });
  assert.equal(raised.isError, undefined);
  assert.equal(raised.content[0].text, response.result);
  assert.deepEqual(requests.at(-1), {
    url: "/hook/access",
    body: { chatKey: "chat:lead", action: "request", args: { level: "edits", reason: "Write the fix." } },
    capability: "cap-1",
  });

  status = 400; response = { error: "This chat already runs at Auto, which covers Accept edits. Nothing was asked; carry on.", outcome: { origin: "octiqflow", reasonClass: "validation", severity: "error" } };
  const refused = await call(env, "tools/call", { name: "request_access", arguments: { level: "edits", reason: "x" } });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /already runs at Auto/);
  assert.equal(refused._meta["octiq/outcome"].reasonClass, "validation");

  // A worker is refused here, before anything reaches the host.
  const count = requests.length;
  const worker = await call({ ...env, OCTIQ_ORCHESTRATION_ATTEMPT: "attempt_1" }, "tools/call", { name: "request_access", arguments: { level: "auto", reason: "x" } });
  assert.equal(worker.isError, true);
  assert.match(worker.content[0].text, /coordinator/);
  assert.equal(requests.length, count);
});
