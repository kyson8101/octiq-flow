// A refused Pi tool call must keep standing plan approval from firing.
// Real server and socket, a stub `pi --mode rpc`; no model calls, no accounts.
// The stub parks its turn until a plan is pending, then asks the real
// `/hook/pi-tool` gate about one call and settles cleanly. Scenes:
//   refused  a Read lead's `bash` is denied   -> the plan stays pending
//   allowed  a Read lead's `read` is allowed  -> the plan is approved (control:
//            proves the scene can see an approval at all)
// Usage: node scripts/test-pi-plan-refusal.mjs [octiq-server] [evidence-dir]
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binary = process.argv[2] || path.join(root, "src-tauri/target/debug/octiq-server");
const evidence = process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), "octiq-pi-plan-evidence-"));

function cli() {
  const fs = require("node:fs"), readline = require("node:readline");
  const log = (data) => fs.appendFileSync(process.env.PLAN_TEST_LOG, JSON.stringify({ pid: process.pid, ...data }) + "\n");
  const out = (data) => process.stdout.write(JSON.stringify(data) + "\n");
  if (process.argv.includes("--version")) { console.log("stub 1.0.0"); return; }
  if (process.argv.includes("auth")) { console.log(JSON.stringify({ status: "ready" })); return; }
  if (process.argv.includes("--list-models")) { console.log("provider   model              context  max-out  thinking  images\nanthropic  claude-opus-5-5    1M       64K      yes       yes"); return; }
  if (process.argv.includes("mcp") && process.argv.includes("list")) { console.log("[]"); return; }
  const thread = `new-pi-${process.pid}`;
  readline.createInterface({ input: process.stdin }).on("line", async (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === "get_state") return out({ id: msg.id, type: "response", command: "get_state", success: true, data: { sessionId: thread } });
    if (msg.type === "abort") return out({ id: msg.id, type: "response", command: "abort", success: true });
    if (msg.type !== "prompt") return;
    out({ id: msg.id, type: "response", command: "prompt", success: true });
    out({ type: "agent_start" });
    const scene = ["REFUSED", "ALLOWED"].find((word) => msg.message.includes(`PLAN_${word}`));
    if (scene) {
      while (!fs.existsSync(process.env.PLAN_RELEASE)) await new Promise((r) => setTimeout(r, 30));
      const call = scene === "REFUSED"
        ? { toolName: "bash", toolInput: { command: "echo denied" } }
        : { toolName: "read", toolInput: { path: process.env.PLAN_READABLE } };
      const answer = await fetch(`http://127.0.0.1:${process.env.OCTIQ_HOOK_PORT}/hook/pi-tool`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-octiq-chat-capability": process.env.OCTIQ_CHAT_CAPABILITY },
        body: JSON.stringify({ chatKey: process.env.OCTIQ_CHAT_KEY, sessionKey: process.env.OCTIQ_SESSION_KEY, launchId: process.env.OCTIQ_LAUNCH_ID, toolUseId: "call-1", hostServer: false, ...call }),
      }).then((r) => r.json());
      log({ gateAnswer: answer });
    }
    const message = { role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" };
    out({ type: "message_end", message });
    out({ type: "agent_end", willRetry: false, messages: [message] });
    return out({ type: "agent_settled", aborted: false });
  });
}

async function run(scene, expectApproved) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-pi-plan-"));
  const home = path.join(fixture, "home"), bin = path.join(fixture, "bin"), repo = path.join(fixture, "repo"), ordinary = path.join(fixture, "ordinary");
  for (const folder of [home, bin, repo, ordinary]) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# Fixture\n");
  fs.writeFileSync(path.join(ordinary, "note.txt"), "readable\n");
  for (const args of [["init", "-q", "-b", "develop"], ["add", "README.md"], ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]]) execFileSync("git", args, { cwd: repo });
  fs.writeFileSync(path.join(bin, "pi"), `#!${process.execPath}\n(${cli.toString()})();\n`, { mode: 0o755 });
  const shell = path.join(bin, "fixture-shell");
  fs.writeFileSync(shell, "#!/bin/sh\nif [ \"$1\" = '-lc' ]; then shift; exec /bin/sh -c \"$@\"; fi\nif [ \"$1\" = '-l' ]; then shift; fi\nexec /bin/sh \"$@\"\n", { mode: 0o755 });
  const log = path.join(fixture, "calls.jsonl"), release = path.join(fixture, "release");
  const port = 18000 + Math.floor(Math.random() * 1000), token = "isolated-pi-plan-test";
  const env = { ...process.env, HOME: home, SHELL: shell, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, PLAN_TEST_LOG: log, PLAN_RELEASE: release, PLAN_READABLE: path.join(ordinary, "note.txt"),
    OCTIQ_WEB_PORT: String(port), OCTIQ_WEB_TOKEN: token, OCTIQ_CHAT_IDLE_MINS: "0" };
  const server = spawn(binary, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  let serverLog = "", ws, sequence = 0;
  server.stdout.on("data", (d) => { serverLog += d; }); server.stderr.on("data", (d) => { serverLog += d; });
  const events = [], replies = new Map(), results = { scene };
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  const wait = async (label, test, timeout = 45_000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) { const value = await test(); if (value) return value; await new Promise((r) => setTimeout(r, 100)); }
    throw new Error(`Timed out: ${label}`);
  };
  const invoke = (cmd, args = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; replies.set(id, { resolve, reject }); ws.send(JSON.stringify({ t: "invoke", id, cmd, args }));
  });
  try {
    await wait("server", async () => { try { return (await fetch(`http://127.0.0.1:${port}/healthz`)).status === 200; } catch { return false; } });
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    ws.onmessage = ({ data }) => { const f = JSON.parse(data); if (f.t === "event") events.push(f); else if (f.t === "reply") { const p = replies.get(f.id); if (p) { replies.delete(f.id); f.ok ? p.resolve(f.result) : p.reject(new Error(f.error)); } } };
    const project = await invoke("add_workspace", { name: "plan refusal fixture", primaryPath: repo });
    const key = "chat:pi-plan";
    await invoke("chat_index_save", { meta: { id: "pi-plan", projectId: project.id, title: "Pi plan", cwd: ordinary, modelId: "pi:anthropic-opus-5-5", access: "read", effort: "high" } });
    const profile = path.join(home, ".octiqflow/profiles/default"), now = Date.now();
    const agent = (id, name, reportsTo) => ({ id, name, role: "fixture", agent: "pi", model: "anthropic/claude-opus-5-5", access: "read", projectId: project.id, reportsTo, createdAt: now, updatedAt: now });
    fs.writeFileSync(path.join(profile, "team.json"), JSON.stringify({ agents: [agent("lead", "Lead", null), agent("child", "Child", "lead")], leads: [{ chatKey: key, leadId: "lead", leadName: "Lead", projectId: project.id, createdAt: now }] }));
    await invoke("orchestration_auto_plan_set", { chatKey: key, enabled: true });
    await invoke("chat_start", { key, cwd: ordinary, agent: "pi", model: "anthropic/claude-opus-5-5", effort: "high", access: "read", prompt: `PLAN_${scene.toUpperCase()}`, turnId: "first" });
    await wait("turn started", () => events.some((e) => e.payload?.key === key && e.payload?.event?.type === "agent_start"));
    const created = await invoke("orchestration_run_create", { actorChatKey: key, objective: "plan approval vs a refused call", workspaceId: project.id, rootPath: repo, maxConcurrent: 1, workspaceMode: "direct" });
    await invoke("orchestration_task_create", { actorChatKey: key, runId: created.id, title: "Review", spec: "Check only", dependsOn: [], assignee: "child" });
    fs.writeFileSync(release, "go");
    await wait("turn settled", () => events.some((e) => e.payload?.key === key && e.payload?.event?.type === "agent_settled"));
    await new Promise((r) => setTimeout(r, 1500));
    const snapshot = await invoke("orchestration_snapshot", { runId: created.id });
    const plan = snapshot.runs.find((r) => r.id === created.id)?.planApproval;
    results.gate = calls().find((c) => c.gateAnswer)?.gateAnswer;
    results.plan = plan;
    const approved = plan?.status === "approved";
    results.pass = results.gate?.decision === (expectApproved ? "allow" : "deny") && approved === expectApproved
      && (!expectApproved || plan?.consent?.via === "standing");
    await invoke("chat_stop", { key });
  } catch (e) { results.pass = false; results.error = String(e.stack ?? e); }
  finally {
    fs.mkdirSync(evidence, { recursive: true });
    fs.writeFileSync(path.join(evidence, `${scene}.json`), JSON.stringify(results, null, 2));
    fs.writeFileSync(path.join(evidence, `${scene}-server.log`), serverLog);
    ws?.close(); server.kill("SIGTERM");
    await new Promise((resolve) => server.exitCode !== null ? resolve() : server.once("exit", resolve));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
  console.log(`${results.pass ? "PASS" : "FAIL"} ${scene}: gate=${results.gate?.decision} plan=${results.plan?.status}${results.error ? ` error=${results.error}` : ""}`);
  return results.pass;
}

const refused = await run("refused", false);
const allowed = await run("allowed", true);
console.log(`evidence: ${evidence}`);
process.exit(refused && allowed ? 0 : 1);
