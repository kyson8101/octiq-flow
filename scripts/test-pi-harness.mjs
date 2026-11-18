// Real `pi --mode rpc` against OctiqFlow's Pi extension (scripts/mcp/octiq-pi.ts),
// with a fake Anthropic API and a fake host gate. No account, no paid call, and
// nothing under ~/.pi is read or written (PI_CODING_AGENT_DIR is a scratch folder).
// It proves the parts of the Pi harness that only the real CLI can answer:
//   - OctiqFlow's MCP server is registered per launch and its tools reach the model;
//   - every tool call asks the host gate, carrying the launch capability;
//   - a denial reaches the model as the tool's result, and an allowed call runs;
//   - Stop (`abort`) leaves the process alive and the next prompt works;
//   - a prompt with no login is answered as a failed `response`, not a run.
// Usage: node scripts/test-pi-harness.mjs [record-dir]
// With a record-dir, each scene's raw stdout is saved there as pi-rpc-<scene>.jsonl
// (the fixtures under web/src/lib/__fixtures__ are recorded this way, never edited).
// Skips (exit 0) when `pi` is not installed.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const record = process.argv[2];
if (spawnSync("pi", ["--version"], { encoding: "utf8" }).status !== 0) {
  console.log(JSON.stringify({ skipped: "pi is not installed" }));
  process.exit(0);
}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-pi-harness-"));
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const read = (req) => new Promise((resolve) => { let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => resolve(body)); });

// Fake Anthropic Messages API. `TOOL <name> <json>` in the prompt asks for a
// tool call; the turn after a tool result says what the tool said; `SLOW`
// streams until the client goes away.
const requests = [];
const anthropic = http.createServer(async (req, res) => {
  const body = JSON.parse((await read(req)) || "{}");
  requests.push({ model: body.model, tools: (body.tools || []).map((t) => t.name), system: JSON.stringify(body.system || "") });
  const messages = (body.messages || []).filter((m) => m.role !== "system");
  const last = messages.at(-1) || {};
  const content = Array.isArray(last.content) ? last.content : [{ type: "text", text: String(last.content || "") }];
  const toolResult = content.find((b) => b.type === "tool_result");
  const text = content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  res.writeHead(200, { "content-type": "text/event-stream" });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const start = () => ev("message_start", { message: { id: "msg_fake", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  const say = (words, stop) => {
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: words } });
    ev("content_block_stop", { index: 0 });
    ev("message_delta", { delta: { stop_reason: stop }, usage: { output_tokens: 5 } });
    ev("message_stop", {});
    res.end();
  };
  start();
  const call = /TOOL (\S+) (\{.*\})/.exec(text);
  if (/SLOW/.test(text)) {
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    const timer = setInterval(() => ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "tick " } }), 200);
    res.on("close", () => clearInterval(timer));
  } else if (toolResult) {
    const said = Array.isArray(toolResult.content) ? toolResult.content.map((c) => c.text).join("") : String(toolResult.content);
    say(`tool said: ${said.slice(0, 300)}`, "end_turn");
  } else if (call) {
    ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_fake1", name: call[1], input: {} } });
    ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: call[2] } });
    ev("content_block_stop", { index: 0 });
    ev("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } });
    ev("message_stop", {});
    res.end();
  } else say(`fake says: ${text.slice(0, 200)}`, "end_turn");
});

// Fake host: the gate's endpoint. A `bash` call is refused, everything else allowed.
const asked = [];
const host = http.createServer(async (req, res) => {
  const body = JSON.parse((await read(req)) || "{}");
  asked.push({ url: req.url, capability: req.headers["x-octiq-chat-capability"], tool: body.toolName, input: body.toolInput, chatKey: body.chatKey, launchId: body.launchId });
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body.toolName === "bash" ? { decision: "deny", reason: "No shell here (fake host)" } : { decision: "allow", reason: "" }));
});

const anthropicPort = await listen(anthropic);
const hostPort = await listen(host);

// The layout `prepare_launch` writes: <mcp>/octiq-ask.cjs beside <mcp>/pi/octiq-pi.ts.
const mcp = path.join(scratch, "mcp");
fs.mkdirSync(path.join(mcp, "pi"), { recursive: true });
for (const file of ["octiq-ask.cjs", "artifact.cjs", "question-media.cjs"]) fs.copyFileSync(path.join(root, "scripts/mcp", file), path.join(mcp, file));
fs.copyFileSync(path.join(root, "scripts/mcp/octiq-pi.ts"), path.join(mcp, "pi/octiq-pi.ts"));
const fakeProvider = path.join(scratch, "fake-anthropic.ts");
fs.writeFileSync(fakeProvider, `export default function (pi: any) { pi.registerProvider("anthropic", { baseUrl: process.env.PI_FAKE_ANTHROPIC }); }\n`);
const prompt = path.join(scratch, "prompt.md");
fs.writeFileSync(prompt, "OCTIQ-TEST-PROMPT-MARKER: you are inside OctiqFlow.\n");
const work = path.join(scratch, "work");
fs.mkdirSync(work);

const launchArgs = (extra = [], extension = path.join(mcp, "pi/octiq-pi.ts")) => [
  "--mode", "rpc", "-e", fakeProvider, "-e", extension,
  "--session-dir", path.join(scratch, "sessions"), "--model", "anthropic/claude-sonnet-5-5", "--thinking", "low",
  "--tools", "read,bash,edit,write,grep,find,ls,mcp__*", "--append-system-prompt", prompt,
  "--no-skills", "--no-prompt-templates", "--no-context-files", ...extra,
];
const launchEnv = (extra = {}) => ({
  ...process.env,
  PI_CODING_AGENT_DIR: path.join(scratch, "pi-home"), PI_OFFLINE: "1", ANTHROPIC_API_KEY: "sk-ant-fake",
  PI_FAKE_ANTHROPIC: `http://127.0.0.1:${anthropicPort}`, OCTIQ_HOOK_PORT: String(hostPort), OCTIQ_CHAT_CAPABILITY: "secret-cap",
  OCTIQ_CHAT_KEY: "chat:e2e", OCTIQ_SESSION_KEY: "chat:e2e", OCTIQ_LAUNCH_ID: "launch-1", OCTIQ_ACCESS: "edits", ...extra,
});

// Drive one pi process: each step is a command; a prompt is awaited to its
// `agent_settled`, and a rejected prompt to its failed `response`.
async function scene(name, steps, { env = {}, args = [], extension } = {}) {
  const lines = [];
  const child = spawn("pi", launchArgs(args, extension), { cwd: work, env: launchEnv(env), stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "", stderr = "";
  const waiting = [];
  child.stderr.on("data", (d) => { stderr += d; });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let i; (i = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      let event; try { event = JSON.parse(line); } catch { continue; }
      lines.push(event); lines.raw = (lines.raw || []).concat(line);
      if (event.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(event.method)) child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true }) + "\n");
      waiting.splice(0).forEach((wake) => wake());
    }
  });
  const until = async (label, test, ms = 60_000) => {
    const stop = Date.now() + ms;
    while (!test()) {
      if (Date.now() > stop) throw new Error(`${name}: timed out waiting for ${label}\n${stderr}`);
      await new Promise((resolve) => { waiting.push(resolve); setTimeout(resolve, 200); });
    }
  };
  const count = (type) => lines.filter((e) => e.type === type).length;
  const send = (command) => child.stdin.write(JSON.stringify(command) + "\n");
  await steps({ send, until, lines, count, stderr: () => stderr });
  child.stdin.end();
  await new Promise((resolve) => { const t = setTimeout(() => { child.kill(); resolve(); }, 5000); child.on("exit", () => { clearTimeout(t); resolve(); }); });
  if (record) { fs.mkdirSync(record, { recursive: true }); fs.writeFileSync(path.join(record, `pi-rpc-${name}.jsonl`), (lines.raw || []).join("\n") + "\n"); }
  return lines;
}
const settledAfter = (api, n) => api.until(`${n} full stops`, () => api.count("agent_settled") >= n);
const assistantTexts = (lines) => lines.filter((e) => e.type === "message_end" && e.message?.role === "assistant").flatMap((e) => e.message.content.filter((b) => b.type === "text").map((b) => b.text));
const toolResults = (lines) => lines.filter((e) => e.type === "tool_execution_end").map((e) => JSON.stringify(e.result));

// The same extension with the MCP script missing beside it: the server cannot start.
fs.mkdirSync(path.join(scratch, "broken/pi"), { recursive: true });
const brokenExtension = path.join(scratch, "broken/pi/octiq-pi.ts");
fs.copyFileSync(path.join(root, "scripts/mcp/octiq-pi.ts"), brokenExtension);

const results = {};
try {
  // 1. A plain turn, a gated shell call, an allowed call, and an OctiqFlow MCP tool.
  const normal = await scene("turn", async (api) => {
    api.send({ id: "octiq-hello-1", type: "get_state" });
    await api.until("get_state", () => api.lines.some((e) => e.command === "get_state"));
    api.send({ id: "octiq-prompt-a", type: "prompt", message: "hello there" });
    await settledAfter(api, 1);
    api.send({ id: "octiq-prompt-b", type: "prompt", message: 'TOOL bash {"command":"echo hi"}' });
    await settledAfter(api, 2);
    api.send({ id: "octiq-prompt-c", type: "prompt", message: 'TOOL read {"path":"/etc/hosts"}' });
    await settledAfter(api, 3);
    api.send({ id: "octiq-prompt-d", type: "prompt", message: 'TOOL mcp__octiq__task_status {"objective":"o"}' });
    await settledAfter(api, 4);
  });
  const state = normal.find((e) => e.command === "get_state");
  assert.equal(state.success, true);
  assert.match(state.data.sessionId, /[0-9a-f-]{8,}/, "the session id comes from get_state");
  assert(!normal.some((e) => e.type === "session"), "rpc mode has no session header: the host speaks it");
  assert.equal(normal.filter((e) => e.type === "agent_settled").length, 4, "exactly one full stop per prompt");
  assert.deepEqual(assistantTexts(normal)[0], "fake says: hello there");
  // The shell call was refused by the host and the model was told why.
  assert(assistantTexts(normal).some((t) => t.includes("No shell here (fake host)")), JSON.stringify(assistantTexts(normal)));
  // Every call went to the host with the launch's capability, and nothing else did.
  // (The MCP server's own `task_status` call also reaches the host, at /hook/task.)
  const gated = asked.filter((c) => c.url === "/hook/pi-tool");
  assert(gated.length >= 3 && gated.every((c) => c.capability === "secret-cap" && c.chatKey === "chat:e2e" && c.launchId === "launch-1"), JSON.stringify(asked));
  assert(asked.filter((c) => c.url !== "/hook/pi-tool").every((c) => c.url === "/hook/task" && c.capability === "secret-cap"));
  assert(gated.some((c) => c.tool === "bash" && c.input.command === "echo hi"));
  assert(gated.some((c) => c.tool === "read"));
  assert(gated.some((c) => c.tool === "mcp__octiq__task_status"), "OctiqFlow's MCP tool is gated by name");
  assert(toolResults(normal).some((r) => r.includes("localhost")), "the allowed read ran");
  // The MCP tools are offered to the model, named as Claude's are, and the prompt file reached it.
  assert(requests.at(-1).tools.includes("mcp__octiq__task_status") && requests.at(-1).tools.includes("mcp__octiq__ask_user"), requests.at(-1).tools.join());
  assert(requests.every((r) => r.model === "claude-sonnet-5-5"), "the model is the upstream's id, not the ref");
  assert(requests[0].system.includes("OCTIQ-TEST-PROMPT-MARKER"), "the appended system prompt file was read");
  results.turn = { prompts: 4, gated: gated.length, tools: requests.at(-1).tools.length };

  // 2. Stop: abort ends the turn, the process lives, the next prompt works.
  asked.length = 0;
  const aborted = await scene("abort", async (api) => {
    api.send({ id: "octiq-hello-1", type: "get_state" });
    api.send({ id: "octiq-prompt-s", type: "prompt", message: "SLOW please keep going" });
    await api.until("streaming", () => api.lines.some((e) => e.type === "message_update"));
    api.send({ id: "octiq-abort-1", type: "abort" });
    await settledAfter(api, 1);
    api.send({ id: "octiq-prompt-t", type: "prompt", message: "hello again" });
    await settledAfter(api, 2);
  });
  const settles = aborted.filter((e) => e.type === "agent_settled");
  assert.equal(settles.length, 2);
  assert.equal(settles[0].aborted, true, "the first full stop is the cut-off turn's");
  assert.notEqual(settles[1].aborted, true);
  const order = aborted.map((e) => e.type);
  assert(order.indexOf("agent_end") < order.indexOf("agent_settled"), "agent_end comes first, so it must not end the turn");
  assert(assistantTexts(aborted).includes("fake says: hello again"));
  results.abort = { fullStops: settles.length };

  // 3. No login: the prompt is refused as a response and no run starts.
  const refused = await scene("no-login", async (api) => {
    api.send({ id: "octiq-prompt-n", type: "prompt", message: "hello" });
    await api.until("the refusal", () => api.lines.some((e) => e.command === "prompt" && e.success === false));
    await new Promise((resolve) => setTimeout(resolve, 800));
  }, { env: { ANTHROPIC_API_KEY: "" } });
  const no = refused.find((e) => e.command === "prompt" && e.success === false);
  assert.match(no.error, /No API key found for anthropic/);
  assert(!refused.some((e) => e.type === "agent_settled" || e.type === "agent_start"), "a refused prompt starts no run and never settles");
  results.noLogin = { error: no.error.split("\n")[0] };

  // 4. An OctiqFlow MCP server that cannot start is said in words, not silently absent.
  const broken = await scene("mcp-failure", async (api) => {
    api.send({ id: "octiq-hello-1", type: "get_state" });
    await api.until("the notice", () => api.lines.some((e) => e.method === "notify" && /MCP/.test(e.message || "")));
  }, { extension: brokenExtension });
  const notice = broken.find((e) => e.method === "notify" && /MCP/.test(e.message || ""));
  assert(notice, "the MCP failure arrives as a notify the host forwards");
  results.mcpFailure = { notify: notice.message.split("\n")[0] };
  results.pass = true;
} catch (error) {
  results.pass = false; results.error = String(error.stack ?? error);
} finally {
  anthropic.close(); host.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(JSON.stringify(results, null, 2));
process.exit(results.pass ? 0 : 1);
