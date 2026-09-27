// Live regression: an agent OctiqFlow launches holds its launch capability and
// nothing of the person's, and its own MCP reaches the hooks on that alone.
//
// Evidence class: STUB PROVIDER. A real octiq-server runs in a throwaway HOME,
// started WITH `OCTIQ_WEB_TOKEN` in its environment, with a stand-in `claude`
// first on PATH; no model is involved. On launch the stand-in records which
// OctiqFlow variables it was given (names and presence only). Asked "MCP", it
// starts the MCP server named in its own `--mcp-config` — the script the host
// wrote from its embedded copy — and calls two tools through it:
// `set_chat_title` (/hook/task) and `orchestration_snapshot`
// (/hook/orchestration). The person's socket then checks the title landed on
// this chat, and that a hook call carrying only the person's token is refused.
//
//   cd src-tauri && cargo build --bin octiq-server && cd ..
//   node scripts/test-agent-hook-credentials.mjs [path/to/octiq-server]
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SERVER = process.argv[2] || path.join(ROOT, "src-tauri/target/debug/octiq-server");
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-hook-credentials-"));
const HOME = path.join(DIR, "home");
const BIN = path.join(DIR, "bin");
const LOG = path.join(DIR, "stub.log");
const PORT = 14000 + Math.floor(Math.random() * 1000);
const TOKEN = "hook-credentials-token";

// The stand-in for `claude -p --input-format stream-json`.
function stubClaude() {
  const fs = require("fs");
  const readline = require("readline");
  const { spawn } = require("child_process");
  const log = (entry) => fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ at: Date.now(), pid: process.pid, ...entry }) + "\n");
  const argv = process.argv.slice(2);
  const env = process.env;
  log({
    launch: true,
    mcp: argv.includes("--mcp-config"),
    webToken: "OCTIQ_WEB_TOKEN" in env,
    hookPort: env.OCTIQ_HOOK_PORT || null,
    capability: Boolean(env.OCTIQ_CHAT_CAPABILITY),
    chatKey: env.OCTIQ_CHAT_KEY || null,
  });
  const session = "stub-" + process.pid;
  const out = (event) => process.stdout.write(JSON.stringify({ session_id: session, ...event }) + "\n");
  out({ type: "system", subtype: "init", model: "stub", tools: [] });
  const finish = (said) => {
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: said }] } });
    out({ type: "result", subtype: "success", is_error: false, result: said, duration_ms: 1, num_turns: 1 });
  };
  // One JSON-RPC call to the MCP server this launch was configured with.
  const mcpCall = (name, args) => new Promise((resolve) => {
    const config = JSON.parse(fs.readFileSync(argv[argv.indexOf("--mcp-config") + 1], "utf8")).mcpServers.octiq;
    const child = spawn(config.command, config.args, { env, stdio: ["pipe", "pipe", "inherit"] });
    let buffered = "";
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      if (!buffered.includes("\n")) return;
      const reply = JSON.parse(buffered.split("\n")[0]);
      child.kill();
      resolve(reply.result);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) + "\n");
  });
  readline.createInterface({ input: process.stdin }).on("line", async (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === "control_request" && msg.request?.subtype === "initialize") {
      out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: {} } });
      return;
    }
    if (msg.type !== "user") return;
    const text = JSON.stringify(msg.message?.content ?? "");
    if (text.includes("MCP")) {
      const title = await mcpCall("set_chat_title", { title: "Hook credential check", chatKey: "chat:someone-else" });
      log({ tool: "set_chat_title", isError: Boolean(title?.isError), text: title?.content?.[0]?.text });
      const snapshot = await mcpCall("orchestration_snapshot", {});
      log({ tool: "orchestration_snapshot", isError: Boolean(snapshot?.isError), text: String(snapshot?.content?.[0]?.text ?? "").slice(0, 200) });
    }
    finish("done");
  });
}

fs.mkdirSync(BIN, { recursive: true });
const STUB = path.join(BIN, "claude");
fs.writeFileSync(STUB, `#!/usr/bin/env node\n(${stubClaude.toString()})();\n`, { mode: 0o755 });
const repo = path.join(HOME, "code", "alpha");
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# alpha\n");
execFileSync("git", ["init", "-q", "-b", "develop"], { cwd: repo });

const ENV = { ...process.env, HOME, SHELL: "/bin/zsh", OCTIQ_WEB_PORT: String(PORT), OCTIQ_WEB_TOKEN: TOKEN,
  OCTIQ_CHAT_IDLE_MINS: "0", PATH: `${BIN}:${process.env.PATH}`, STUB_LOG: LOG };
// The stand-in must learn everything from the server, not from this shell.
for (const name of ["OCTIQ_CHAT_KEY", "OCTIQ_SESSION_KEY", "OCTIQ_LAUNCH_ID", "OCTIQ_CHAT_CAPABILITY", "OCTIQ_HOOK_PORT", "OCTIQ_ROOT"]) {
  delete ENV[name];
}

const stub = () => fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
const wait = async (what, test, ms = 30_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const got = await test();
    if (got) return got;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
};

let serverLog = "";
const server = spawn(SERVER, [], { env: ENV, stdio: ["ignore", "pipe", "pipe"] });
server.stdout.on("data", (d) => { serverLog += d; });
server.stderr.on("data", (d) => { serverLog += d; });
process.on("exit", () => server.kill());

let ws;
let seq = 0;
const replies = new Map();
const invoke = (cmd, args = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  replies.set(id, { resolve, reject });
  ws.send(JSON.stringify({ t: "invoke", id, cmd, args }));
});

const key = "chat:hook-credentials";
const results = {};
try {
  await wait("server", async () => {
    try { return (await fetch(`http://127.0.0.1:${PORT}/`)).status > 0; } catch { return false; }
  });
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (m) => {
    const frame = JSON.parse(m.data);
    if (frame.t !== "reply") return;
    const waiting = replies.get(frame.id);
    if (!waiting) return;
    replies.delete(frame.id);
    frame.ok ? waiting.resolve(frame.result) : waiting.reject(new Error(frame.error));
  };
  const project = await invoke("add_workspace", { name: "Alpha", primaryPath: repo });
  await invoke("chat_index_save", { meta: { id: "hook-credentials", projectId: project.id, title: "hook credentials", cwd: repo,
    modelId: "claude:sonnet", access: "auto", createdAt: Date.now(), updatedAt: Date.now(), generation: 0 } });

  await invoke("chat_start", { key, cwd: repo, agent: "claude", model: "sonnet", access: "auto", useSandbox: false, prompt: "MCP", turnId: "user-1" });
  const snapshot = await wait("both tool calls", async () => stub().find((e) => e.tool === "orchestration_snapshot"));
  const launch = stub().find((e) => e.launch);
  const title = stub().find((e) => e.tool === "set_chat_title");
  results.launch = launch;
  results.tools = { title, snapshot };

  assert.equal(launch.mcp, true, "the launch carries the MCP config");
  assert.equal(launch.webToken, false, "the person's token is not passed down, though the server was started with it");
  assert.equal(launch.hookPort, String(PORT), "the launch is told where the hooks are");
  assert.equal(launch.capability, true, "the launch has its capability");
  assert.equal(launch.chatKey, key);
  assert.equal(title.isError, false, `set_chat_title through /hook/task: ${title.text}`);
  assert.equal(snapshot.isError, false, `orchestration_snapshot through /hook/orchestration: ${snapshot.text}`);

  // The title landed on THIS chat, whatever the tool arguments named.
  const chats = await invoke("chat_index_list");
  const mine = (Array.isArray(chats) ? chats : chats.chats ?? []).find((c) => c.id === "hook-credentials");
  results.savedTitle = mine?.title;
  results.agentTitle = mine?.agentTitle;
  assert.equal(results.savedTitle, "Hook credential check");

  // The person's token on a hook, without a capability: not an agent.
  const refused = await fetch(`http://127.0.0.1:${PORT}/hook/task?token=${TOKEN}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chatKey: key, action: "title", args: { title: "Forged" } }),
  });
  results.tokenOnlyHook = refused.status;
  assert.equal(refused.status, 401);

  console.log(JSON.stringify(results, null, 2));
  console.log("agent hook credentials live check passed");
} catch (error) {
  console.error(serverLog.slice(-4000));
  console.error(JSON.stringify(stub(), null, 2));
  throw error;
} finally {
  ws?.close();
  server.kill();
}
