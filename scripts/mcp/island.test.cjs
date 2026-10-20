"use strict";
// The island's tools (docs/island.md), as the MCP server offers them: to a
// chat's agent, and to no worker, front desk or chat-less copy; each posts
// to /hook/island with only its documented fields, and island_look hands the
// building guide back as text of its own.
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

const NAMES = ["island_look", "island_build", "island_grant", "island_propose", "island_style", "island_place"];
const islandTools = result => result.tools.filter(tool => tool.name.startsWith("island_"));

test("the island tools are offered to a chat, and to no worker, front desk or stranger", async () => {
  for (const flags of [[], ["--disable-ask-user"]]) {
    const listed = await call({ OCTIQ_CHAT_KEY: "chat:lead" }, "tools/list", {}, flags);
    const tools = islandTools(listed);
    assert.deepEqual(tools.map(tool => tool.name), NAMES);
    for (const tool of tools) {
      // Short: the guide is island_look's answer, not anyone's description.
      assert.ok(tool.description.length <= 600, `${tool.name} is ${tool.description.length} characters`);
      assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
      for (const key of ["chatKey", "by", "agentId"]) assert.ok(!(key in tool.inputSchema.properties), `${tool.name}: ${key}`);
    }
    const [look, build, grant, propose, style, place] = tools;
    assert.match(look.description, /building guide/);
    assert.match(look.description, /Call it first/);
    assert.equal(look.annotations.readOnlyHint, true);
    assert.deepEqual(Object.keys(look.inputSchema.properties), ["wishId"]);
    assert.deepEqual(build.inputSchema.required, ["name", "kind", "parts"]);
    const part = build.inputSchema.properties.parts.items;
    assert.deepEqual(part.properties.shape.enum, ["box", "round", "cylinder", "cone", "sphere", "torus", "wedge"]);
    assert.deepEqual(part.properties.finish.enum, ["matte", "soft", "shiny", "metal", "glass", "glow"]);
    assert.equal(part.properties.color.pattern, "^#[0-9a-fA-F]{6}$");
    for (const key of ["size", "at", "turn"]) {
      assert.equal(part.properties[key].minItems, 3, key);
      assert.equal(part.properties[key].maxItems, 3, key);
    }
    assert.deepEqual(part.required, ["shape", "size", "at", "color"]);
    assert.deepEqual(build.inputSchema.properties.slot.enum, ["head", "face", "neck", "back", "hand"]);
    assert.deepEqual(grant.inputSchema.required, ["wishId"]);
    assert.deepEqual(Object.keys(grant.inputSchema.properties), ["wishId", "assetId", "look", "x", "z", "turn"]);
    assert.ok(!("worn" in grant.inputSchema.properties.look.properties), "a look wish is paint, not clothes");
    assert.deepEqual(style.inputSchema.properties.eyes.enum, ["pill", "round", "happy", "sleepy", "star", "heart", "visor", "chevron"]);
    assert.deepEqual(style.inputSchema.properties.antenna.enum, ["ball", "halo", "crown", "star", "leaf", "moon", "twin", "sun", "spark", "bar", "sprout", "none"]);
    assert.deepEqual(Object.keys(style.inputSchema.properties.worn.properties), ["head", "face", "neck", "back", "hand"]);
    assert.deepEqual(Object.keys(place.inputSchema.properties), ["assetId", "placementId", "x", "z", "y", "turn", "remove"]);
  }
  for (const env of [
    { OCTIQ_CHAT_KEY: "chat:orch-w", OCTIQ_ORCHESTRATION_ATTEMPT: "attempt_1" },
    { OCTIQ_CHAT_KEY: "chat:desk", OCTIQ_FRONT_DESK: "1" },
    { OCTIQ_CHAT_KEY: "" },
  ]) {
    assert.deepEqual(islandTools(await call(env, "tools/list", {})), [], JSON.stringify(env));
  }
});

test("island calls go to /hook/island with only their documented fields", async t => {
  const requests = [];
  let status = 200, response = { result: { assetId: "a_1", rev: 1 } };
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, body: JSON.parse(body) });
    res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(response));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { OCTIQ_CHAT_KEY: "chat:lead", OCTIQ_HOOK_PORT: String(server.address().port) };
  const parts = [{ shape: "round", size: [0.7, 0.12, 0.5], at: [0, 0, 0], color: "#e9c46a" }];

  // Who built it is the host's to say: nothing the model adds crosses.
  const built = await call(env, "tools/call", { name: "island_build", arguments: { name: "Scarf", kind: "accessory", slot: "neck", parts, chatKey: "chat:other", by: { name: "Someone" } } });
  assert.equal(built.isError, undefined);
  assert.deepEqual(JSON.parse(built.content[0].text), response.result);
  assert.deepEqual(requests.at(-1), { url: "/hook/island", body: { chatKey: "chat:lead", action: "build", args: { name: "Scarf", kind: "accessory", slot: "neck", parts } } });

  await call(env, "tools/call", { name: "island_grant", arguments: { wishId: "w_1", assetId: "a_1", x: 1, z: 2, wisher: "b_1" } }, ["--disable-ask-user"]);
  assert.deepEqual(requests.at(-1).body, { chatKey: "chat:lead", action: "grant", args: { wishId: "w_1", assetId: "a_1", x: 1, z: 2 } });

  await call(env, "tools/call", { name: "island_propose", arguments: { text: "a riverside stage", agentId: "someone-else" } });
  assert.deepEqual(requests.at(-1).body, { chatKey: "chat:lead", action: "propose", args: { text: "a riverside stage" } });

  await call(env, "tools/call", { name: "island_style", arguments: { frame: "slim", worn: { neck: "a_1", head: null } } });
  assert.deepEqual(requests.at(-1).body, { chatKey: "chat:lead", action: "style", args: { frame: "slim", worn: { neck: "a_1", head: null } } });

  await call(env, "tools/call", { name: "island_place", arguments: { assetId: "a_2", x: 2, z: 3, turn: 90 } });
  assert.deepEqual(requests.at(-1).body, { chatKey: "chat:lead", action: "place", args: { assetId: "a_2", x: 2, z: 3, turn: 90 } });
  // Taking a placement away sends what names it, and nothing else.
  await call(env, "tools/call", { name: "island_place", arguments: { placementId: "pl_1", remove: true, x: 3 } });
  assert.deepEqual(requests.at(-1).body, { chatKey: "chat:lead", action: "place", args: { placementId: "pl_1", remove: true } });

  // The guide comes back as text of its own, the rest as JSON.
  response = { result: { guide: "# Building for the island\n\nMetres.", you: { name: "Chat" } } };
  const looked = await call(env, "tools/call", { name: "island_look", arguments: { wishId: "w_1" } });
  assert.equal(looked.content[0].text, "# Building for the island\n\nMetres.");
  assert.deepEqual(JSON.parse(looked.content[1].text), { you: { name: "Chat" } });
  assert.deepEqual(requests.at(-1).body, { chatKey: "chat:lead", action: "look", args: { wishId: "w_1" } });

  // A refusal is an error in the host's words, of the host's kind.
  status = 400;
  response = { error: "Island buildings have no roof, so the person can watch inside: part 8 …", outcome: { origin: "octiqflow", reasonClass: "validation", severity: "error" } };
  const refused = await call(env, "tools/call", { name: "island_build", arguments: { name: "Hut", kind: "building", parts } });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /no roof/);
  assert.equal(refused._meta["octiq/outcome"].reasonClass, "validation");

  // A worker's call, and one with no chat, never reach the host; nor does a
  // name the island has no tool for.
  const count = requests.length;
  const worker = await call({ ...env, OCTIQ_ORCHESTRATION_ATTEMPT: "attempt_1" }, "tools/call", { name: "island_build", arguments: { name: "Scarf", kind: "accessory", slot: "neck", parts } });
  assert.equal(worker.isError, true);
  assert.equal(worker._meta["octiq/outcome"].reasonClass, "scope-refused");
  assert.equal((await call({ OCTIQ_CHAT_KEY: "" }, "tools/call", { name: "island_look", arguments: {} })).isError, true);
  assert.equal((await call(env, "tools/call", { name: "island_demolish", arguments: {} })).isError, true);
  assert.equal(requests.length, count);
});

test("a background present maker sees only island tools and cannot register an agent or ask a person", async () => {
  const env = { OCTIQ_CHAT_KEY: "chat:island-wish-w_1" };
  const listed = await call(env, "tools/list", {});
  assert.deepEqual(listed.tools.map(tool => tool.name), ["island_look", "island_build", "island_grant"]);
  for (const name of ["ask_user", "request_access", "agent_register", "orchestration_run_create"]) {
    const refused = await call(env, "tools/call", { name, arguments: {} });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /cannot register agents/);
  }
});
