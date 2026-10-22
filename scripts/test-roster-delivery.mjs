// Real OctiqFlow server/socket and a deterministic Codex app-server stand-in.
// Failed sends must retain roster context; successful provider writes deduplicate it.
// node scripts/test-roster-delivery.mjs [octiq-server] [evidence-dir]
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binary = process.argv[2] || path.join(root, "src-tauri/target/debug/octiq-server");
const evidence = process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), "octiq-bookkeeping-evidence-"));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-bookkeeping-"));
const taskHome = path.join(fixture, "home"), bin = path.join(fixture, "bin"), repo = path.join(fixture, "repo");
for (const dir of [taskHome, bin, repo, evidence]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# Isolated Codex fixture\n");
for (const args of [["init", "-q", "-b", "develop"], ["add", "README.md"], ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]]) execFileSync("git", args, { cwd: repo });
const wireLog = path.join(evidence, "wire.jsonl");
function cli() {
  const fs = require("node:fs"), readline = require("node:readline");
  if (process.argv.includes("--version")) { console.log("codex-cli stub"); return; }
  const out = value => process.stdout.write(JSON.stringify(value) + "\n");
  readline.createInterface({input: process.stdin}).on("line", line => {
    const m = JSON.parse(line);
    fs.appendFileSync(process.env.BOOKKEEPING_WIRE, JSON.stringify({received:m}) + "\n");
    if (m.method === "initialize") out({id:m.id, result:{userAgent:"fixture"}});
    if (m.method === "thread/start" || m.method === "thread/resume") out({id:m.id, result:{thread:{id:"fixture-thread"}}});
    if (m.method === "turn/start") {
      out({id:m.id, result:{turn:{id:"fixture-turn"}}});
      out({method:"turn/started", params:{threadId:"fixture-thread", turn:{id:"fixture-turn"}}});
      out({method:"turn/completed", params:{threadId:"fixture-thread", turn:{id:"fixture-turn", status:"completed"}}});
    }
  });
}
fs.writeFileSync(path.join(bin, "codex"), `#!${process.execPath}\n(${cli.toString()})();\n`, { mode: 0o755 });
const shell = path.join(bin, "fixture-shell");
fs.writeFileSync(shell, "#!/bin/sh\nif [ \"$1\" = '-lc' ]; then shift; exec /bin/sh -c \"$@\"; fi\nif [ \"$1\" = '-l' ]; then shift; fi\nexec /bin/sh \"$@\"\n", { mode: 0o755 });
const port = 19000 + Math.floor(Math.random() * 1000), token = "isolated-bookkeeping";
const env = { ...process.env, HOME: taskHome, SHELL: shell, PATH: `${bin}:${process.env.PATH}`, BOOKKEEPING_WIRE: wireLog, OCTIQ_WEB_PORT: String(port), OCTIQ_WEB_TOKEN: token, OCTIQ_CHAT_IDLE_MINS: "0" };
const server = spawn(binary, [], { env, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "", ws, sequence = 0;
const rosterChat = "chat:roster-offline";
server.stdout.on("data", data => { serverLog += data; }); server.stderr.on("data", data => { serverLog += data; });
const events = [], replies = new Map();
const wait = async (label, test, ms = 15000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { const value = await test(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(`Timed out: ${label}`);
};
const invoke = (cmd, args = {}) => new Promise((resolve, reject) => {
  const id = ++sequence; replies.set(id, { resolve, reject }); ws.send(JSON.stringify({ t: "invoke", id, cmd, args }));
});
const wire = () => fs.existsSync(wireLog) ? fs.readFileSync(wireLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
try {
  await wait("server", async () => { try { return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch { return false; } });
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ({data}) => {
    const frame = JSON.parse(data);
    if (frame.t === "event") events.push(frame);
    else if (frame.t === "reply") {
      const pending = replies.get(frame.id);
      if (pending) { replies.delete(frame.id); frame.ok ? pending.resolve(frame.result) : pending.reject(new Error(frame.error)); }
    }
  };
  const project = await invoke("add_workspace", {name:"Roster fixture", primaryPath:repo});
  const draft = (name, reportsTo) => ({name, role:"Fixture", agent:"codex", model:"gpt-6.1-sol", access:"auto", projectId:project.id, reportsTo});
  const lead = await invoke("team_save", {agent:draft("Fixture Lead", null)});
  await invoke("team_brief", {chatKey:rosterChat, projectId:project.id, leadId:lead.id, task:"Fixture roster"});
  await invoke("team_save", {agent:draft("New Report", lead.id)});
  let failedSend;
  try { await invoke("chat_send", {key:rosterChat, text:"First attempt"}); } catch (error) { failedSend = error.message; }
  assert.equal(failedSend, "no such chat");
  await invoke("chat_start", {key:rosterChat, cwd:repo, agent:"codex", model:"gpt-6.1-sol", access:"auto", prompt:"Retry after known failure", turnId:"roster-retry"});
  const received = await wait("roster retry", () => wire().find(x => x.received?.method === "turn/start" && JSON.stringify(x.received).includes("Retry after known failure")));
  const result = {failedSend, received:received.received.params.input, containsNewReport:JSON.stringify(received).includes("New Report")};
  fs.writeFileSync(path.join(evidence, "roster-probe.json"), JSON.stringify(result, null, 2));
  assert.equal(result.containsNewReport, true, "retry must carry the roster never written by the failed send");
  await wait("roster completed", () => events.some(e => e.payload?.key === rosterChat && e.payload.event?.type === "turn.completed"));
  await invoke("chat_send", {key:rosterChat, text:"Unchanged after delivery", turnId:"roster-unchanged"});
  const unchanged = await wait("unchanged follow-up", () => wire().find(x => x.received?.method === "turn/start" && JSON.stringify(x.received).includes("Unchanged after delivery")));
  assert.equal(JSON.stringify(unchanged).includes("New Report"), false, "unchanged delivered roster must not repeat");
  fs.writeFileSync(path.join(evidence, "unchanged-probe.json"), JSON.stringify(unchanged.received, null, 2));
  console.log("PASS: failed send retains roster; successful provider write deduplicates it");
} finally {
  fs.writeFileSync(path.join(evidence, "server.log"), serverLog);
  fs.writeFileSync(path.join(evidence, "events.json"), JSON.stringify(events, null, 2));
  if (ws) { try { await invoke("chat_stop", {key:rosterChat}); } catch {} ws.close(); }
  server.kill("SIGTERM");
  await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once("exit", resolve); });
  fs.rmSync(fixture, { recursive: true, force: true });
}
