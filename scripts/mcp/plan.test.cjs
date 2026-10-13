"use strict";
// A chat's plan, as the MCP server offers it to a chat agent: two tools
// (read it, change it), no tool that starts it, and how to keep one said in
// the descriptions, which are within the limit Claude Code has for one
// (`instructions.test.cjs` holds every description under it).
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

const names = result => result.tools.map(tool => tool.name);

test("the plan tools are offered to a chat's own agent, and to no worker, desk or stranger", async () => {
  for (const flags of [[], ["--disable-ask-user"]]) {
    const listed = await call({ OCTIQ_CHAT_KEY: "chat:lead" }, "tools/list", {}, flags);
    assert.ok(names(listed).includes("plan_read"));
    assert.ok(names(listed).includes("plan_update"));
  }
  for (const env of [
    { OCTIQ_CHAT_KEY: "chat:orch-w", OCTIQ_ORCHESTRATION_ATTEMPT: "attempt_1" },
    { OCTIQ_CHAT_KEY: "chat:desk", OCTIQ_FRONT_DESK: "1" },
    { OCTIQ_CHAT_KEY: "" },
  ]) {
    const offered = names(await call(env, "tools/list", {}));
    assert.ok(!offered.includes("plan_read"), JSON.stringify(env));
    assert.ok(!offered.includes("plan_update"), JSON.stringify(env));
  }
});

test("no tool starts a plan: Start is the person's", async () => {
  const listed = await call({ OCTIQ_CHAT_KEY: "chat:lead" }, "tools/list", {});
  for (const name of names(listed)) assert.doesNotMatch(name, /plan.*start|start.*plan/i, name);
  // Called by a name it might have had, it is no tool at all.
  const made_up = await call({ OCTIQ_CHAT_KEY: "chat:lead", OCTIQ_HOOK_PORT: "1" }, "tools/call", { name: "plan_begin", arguments: { revision: 1 } }).catch(error => error);
  assert.ok(made_up instanceof Error || made_up?.isError || made_up === undefined, JSON.stringify(made_up));
});

test("the descriptions say how to keep a plan, what Start is, and the limits", async () => {
  const listed = await call({ OCTIQ_CHAT_KEY: "chat:lead" }, "tools/list", {});
  const update = listed.tools.find(tool => tool.name === "plan_update");
  const read = listed.tools.find(tool => tool.name === "plan_read");
  for (const said of [
    /when the person says they will send several things before work starts, or asks for a plan/,
    /One item per piece of work/,
    /list every question still open under questions, and write each answer as a short decision/,
    /START IS THE PERSON'S/,
    /orchestration_run_create, orchestration_task_create, orchestration_worker_start, orchestration_dispatch_ready and orchestration_task_reopen/,
    /do not edit files or run the work in this chat/,
    /only the person's Start on the Plan panel starts it, and no tool does/,
    /link each item to its tasks \(tasks\) once they exist/,
    /Items added after Start do not wait for another Start/,
    /Nothing is removed: drop an item instead/,
    /a change based on an older revision is refused whole/,
    /Limits: 60 items, 12 decisions and 12 open questions an item, title 120 characters, a decision or question 240, a note 600/,
    /a worker, a front desk and an additional agent in a room are refused/,
  ]) assert.match(update.description, said);
  assert.match(read.description, /progress is counted by OctiqFlow from the run's ledger/);
  assert.match(read.description, /A chat with no plan answers revision 0/);

  // The schema is the host's bounds, and takes nothing the host would not read.
  const item = update.inputSchema.properties.add.items;
  assert.deepEqual(update.inputSchema.required, ["baseRevision"]);
  assert.equal(update.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(update.inputSchema.properties), ["baseRevision", "add", "update", "order"]);
  assert.deepEqual(item.required, ["title"]);
  assert.equal(item.additionalProperties, false);
  assert.equal(item.properties.title.maxLength, 120);
  assert.equal(item.properties.decisions.maxItems, 12);
  assert.equal(item.properties.decisions.items.maxLength, 240);
  assert.equal(item.properties.questions.maxItems, 12);
  assert.equal(item.properties.questions.items.maxLength, 240);
  assert.equal(item.properties.note.maxLength, 600);
  assert.equal(update.inputSchema.properties.add.maxItems, 60);
  assert.deepEqual(item.properties.status.enum, ["discussing", "decided", "in_progress", "done", "dropped"]);
  assert.deepEqual(update.inputSchema.properties.update.items.required, ["id"]);
  for (const key of ["progress", "linked", "started", "chatId", "remove"]) {
    assert.ok(!(key in item.properties), key);
    assert.ok(!(key in update.inputSchema.properties), key);
  }
  assert.equal(read.annotations.readOnlyHint, true);
  assert.equal(update.annotations.readOnlyHint, false);
  assert.equal(update.annotations.destructiveHint, false);
});

test("a read and a change go to /hook/plan with only the documented fields, and hand back the host's answer", async t => {
  const requests = [];
  let status = 200, response = { result: { chatId: "lead", revision: 1, items: [], awaitsStart: true, note: "Not started." } };
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, body: JSON.parse(body), capability: req.headers["x-octiq-chat-capability"] });
    res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(response));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { OCTIQ_CHAT_KEY: "chat:lead", OCTIQ_HOOK_PORT: String(server.address().port), OCTIQ_CHAT_CAPABILITY: "cap-1" };

  const read = await call(env, "tools/call", { name: "plan_read", arguments: { chatId: "other" } });
  assert.equal(read.isError, undefined);
  assert.deepEqual(JSON.parse(read.content[0].text), response.result);
  assert.equal(requests[0].url, "/hook/plan");
  assert.equal(requests[0].capability, "cap-1");
  assert.deepEqual(requests[0].body, { chatKey: "chat:lead", action: "read", args: {} });

  const changed = await call(env, "tools/call", { name: "plan_update", arguments: {
    baseRevision: 1,
    chatId: "other",
    started: true,
    add: [{ title: "A quieter composer", status: "decided", decisions: ["One line", 7], questions: ["Fold?"], note: "n", tasks: ["task_1"], before: "i2", progress: { done: 9 }, id: "i9" }],
    update: [{ id: "i1", status: "dropped", linked: [] }, { title: "no id" }],
    order: ["i2", "i1", 3],
  } });
  assert.equal(changed.isError, undefined);
  assert.equal(requests[1].url, "/hook/plan");
  assert.deepEqual(requests[1].body, { chatKey: "chat:lead", action: "update", args: {
    baseRevision: 1,
    add: [{ title: "A quieter composer", status: "decided", decisions: ["One line"], questions: ["Fold?"], note: "n", tasks: ["task_1"], before: "i2" }],
    update: [{ id: "i1", status: "dropped" }, { id: "", title: "no id" }],
    order: ["i2", "i1"],
  } });

  // An additional agent in a room sends its own process key; the host refuses its change.
  await call({ ...env, OCTIQ_SESSION_KEY: "chat:lead#2" }, "tools/call", { name: "plan_read", arguments: {} });
  assert.equal(requests[2].body.sessionKey, "chat:lead#2");

  // A change with no revision never leaves the process.
  const before = requests.length;
  const unbased = await call(env, "tools/call", { name: "plan_update", arguments: { add: [{ title: "A" }] } });
  assert.equal(unbased.isError, true);
  assert.match(unbased.content[0].text, /Give baseRevision/);
  assert.equal(requests.length, before);

  // The host's refusal is the tool's answer, in the host's words and kind.
  status = 400;
  response = { error: "This chat's plan has not been started.", outcome: { origin: "octiqflow", reasonClass: "scope-refused", severity: "error" } };
  const refused = await call(env, "tools/call", { name: "plan_update", arguments: { baseRevision: 0, add: [{ title: "A" }] } });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /This chat's plan has not been started\./);
});

test("a worker that calls a plan tool by name is refused before the host is asked", async () => {
  for (const name of ["plan_read", "plan_update"]) {
    const refused = await call({ OCTIQ_CHAT_KEY: "chat:orch-w", OCTIQ_ORCHESTRATION_ATTEMPT: "attempt_1", OCTIQ_HOOK_PORT: "1" }, "tools/call", { name, arguments: { baseRevision: 0 } });
    assert.equal(refused.isError, true, name);
    assert.match(refused.content[0].text, /An orchestration worker keeps no plan/);
  }
});
