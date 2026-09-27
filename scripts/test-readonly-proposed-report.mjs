// Live check: a REAL read-only Codex worker (feedback e15fabde) reports
// through the host's proposed report, and nothing else can settle it.
//
// Evidence class: REAL PROVIDER. A real octiq-server runs in a throwaway HOME
// (CODEX_HOME points at the person's own Codex sign-in, read-only use) and
// starts a real `codex app-server` worker with Read access on a benign
// fixture repository. What it shows:
//   - the worker's own orchestration_worker_report is refused inside Codex
//     (read-only + approval_policy=never), and its source write is refused;
//   - its closing words become attempt.proposedReport, attributed to that
//     attempt, and the task is NOT settled by them;
//   - the worker itself, another chat, a wrong attempt, a wrong proposal and
//     a missing verdict cannot settle it; the coordinator can, once, with the
//     verdict it states; a repeat changes nothing;
//   - a relay between two runs of the same coordinator is recorded once, and
//     one to another coordinator's run, or from a worker, is refused.
// What it does NOT show: the capability-bound hook identity (not on this
// base), or any model's judgement beyond this one run.
//
//   cd src-tauri && cargo build --bin octiq-server && cd ..
//   node scripts/test-readonly-proposed-report.mjs [path/to/octiq-server] [evidence-dir]
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SERVER = process.argv[2] || path.join(ROOT, "src-tauri/target/debug/octiq-server");
const OUT = process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), "octiq-readonly-evidence-"));
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-readonly-"));
const HOME = path.join(DIR, "home");
const PORT = 15000 + Math.floor(Math.random() * 1000);
const TOKEN = "readonly-token";
const COORD = "chat:coord-readonly";
const OTHER = "chat:other-coordinator";
fs.mkdirSync(OUT, { recursive: true });

const repo = path.join(HOME, "code", "fixture");
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n\nThis project says hello.\n");
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
git("init", "-q", "-b", "develop");
git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "add", "README.md");
git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "-m", "fixture");
const fixtureHead = git("rev-parse", "HEAD").trim();

const ENV = { ...process.env, HOME, CODEX_HOME: path.join(os.homedir(), ".codex"), SHELL: "/bin/zsh",
  OCTIQ_WEB_PORT: String(PORT), OCTIQ_WEB_TOKEN: TOKEN, OCTIQ_CHAT_IDLE_MINS: "0" };

const wait = async (what, test, ms = 30_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const got = await test();
    if (got) return got;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
};

let serverLog = "";
const server = spawn(SERVER, [], { env: ENV, stdio: ["ignore", "pipe", "pipe"] });
server.stdout.on("data", (d) => { serverLog += d; });
server.stderr.on("data", (d) => { serverLog += d; });

const events = [];
let ws;
let seq = 0;
const replies = new Map();
const invoke = (cmd, args = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  replies.set(id, { resolve, reject });
  ws.send(JSON.stringify({ t: "invoke", id, cmd, args }));
});
const hook = async (chatKey, action, args) => {
  const response = await fetch(`http://127.0.0.1:${PORT}/hook/orchestration?token=${TOKEN}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chatKey, action, args }),
  });
  const body = await response.json();
  return { status: response.status, ...body };
};

const results = { fixtureHead, codex: execFileSync("codex", ["--version"], { encoding: "utf8" }).trim() };
try {
  await wait("server", async () => {
    try { return (await fetch(`http://127.0.0.1:${PORT}/`)).status > 0; } catch { return false; }
  });
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (m) => {
    const frame = JSON.parse(m.data);
    if (frame.t === "reply") {
      const waiting = replies.get(frame.id);
      if (!waiting) return;
      replies.delete(frame.id);
      frame.ok ? waiting.resolve(frame.result) : waiting.reject(new Error(frame.error));
    } else if (frame.t === "event") events.push(frame);
  };

  const project = await invoke("add_workspace", { name: "Fixture", primaryPath: repo });
  const run = await invoke("orchestration_run_create", { actorChatKey: COORD, objective: "Review the fixture read-only",
    workspaceId: project.id, rootPath: repo, maxConcurrent: 2 });
  const review = await invoke("orchestration_task_create", { actorChatKey: COORD, runId: run.id, dependsOn: [], kind: "review",
    title: "Review the README read-only",
    spec: "Read README.md and review it. Then run exactly this shell command once: printf x > WRITE_ATTEMPT.txt (it is expected to be refused; do not try any other way to write). Then settle with orchestration_worker_report. If that call is refused, do not retry it: end your turn with your findings and the verdict you reached as your final message." });
  const after = await invoke("orchestration_task_create", { actorChatKey: COORD, runId: run.id, dependsOn: [review.id],
    title: "Ship after the review", spec: "Held until the review passes." });
  await invoke("orchestration_worker_start", { actorChatKey: COORD, taskId: review.id, agent: "codex",
    model: "gpt-5.6-luna", effort: "low", access: "read", newWorktree: false });

  const snapshot = () => invoke("orchestration_snapshot", { runId: run.id });
  const live = async () => (await snapshot()).attempts.find((a) => a.taskId === review.id);
  // The bug itself, on a server without the fix: the turn ends, nothing can
  // report, and the attempt sits "awaiting report" with its findings lost.
  let endedAt = null;
  const held = await wait("the worker's turn to end with a proposed report", async () => {
    const attempt = await live();
    if (attempt?.status === "failed") throw new Error(`attempt failed: ${JSON.stringify(attempt.execution)}`);
    if (attempt?.proposedReport) return attempt;
    if (attempt?.execution?.state === "awaiting_report") {
      endedAt ??= Date.now();
      if (Date.now() - endedAt > 20_000) {
        results.stuck = { attemptId: attempt.id, execution: attempt.execution };
        throw new Error("The read-only worker's turn ended without a report and the host held nothing: the task cannot settle.");
      }
    }
    return null;
  }, 600_000);
  const workerKey = held.workerChatKey;
  const proposal = held.proposedReport;
  const workerEvents = events.filter((e) => e.event === "chat-event" && e.payload.key === workerKey).map((e) => e.payload.event);
  const mcpCalls = workerEvents.filter((e) => e.item?.type === "mcp_tool_call" && e.type === "item.completed").map((e) => ({
    tool: e.item.tool, status: e.item.status, error: e.item.error?.message ?? null }));
  const commands = workerEvents.filter((e) => e.item?.type === "command_execution" && e.type === "item.completed").map((e) => ({
    command: e.item.command, exit: e.item.exit_code, status: e.item.status }));
  results.worker = { attemptId: held.id, access: held.access, execution: held.execution.state, mcpCalls, commands };
  results.proposal = { id: proposal.id, truncated: !!proposal.truncated, chars: proposal.text.length, text: proposal.text };
  results.sourceUntouched = {
    writeAttemptExists: fs.existsSync(path.join(repo, "WRITE_ATTEMPT.txt")),
    head: git("rev-parse", "HEAD").trim(),
    porcelain: git("status", "--porcelain"),
  };
  assert.equal(held.access, "read");
  assert(mcpCalls.some((c) => c.tool === "orchestration_worker_report" && c.status === "failed"),
    "the worker's own report was refused inside Codex");
  assert.equal(results.sourceUntouched.writeAttemptExists, false, "the source write was refused");
  assert.equal(results.sourceUntouched.head, fixtureHead);
  assert.equal(results.sourceUntouched.porcelain, "");
  let s = await snapshot();
  assert.equal(s.tasks.find((t) => t.id === review.id).status, "running", "holding words settles nothing");
  assert.equal(s.tasks.find((t) => t.id === after.id).status, "pending");
  results.coordinatorNotice = s.notifications.find((n) => n.source === `proposal:${proposal.id}`)?.body.slice(0, 400) ?? null;
  assert(results.coordinatorNotice, "the coordinator was told");

  // Every way that must not settle it.
  const confirm = (actor, args) => hook(actor, "report_confirm", { attemptId: held.id, proposalId: proposal.id, outcome: "completed", verdict: "pass", ...args });
  results.refusals = {
    worker: await confirm(workerKey, {}),
    otherChat: await confirm(OTHER, {}),
    wrongAttempt: await confirm(COORD, { attemptId: "attempt_does_not_exist" }),
    wrongProposal: await confirm(COORD, { proposalId: "proposal_forged" }),
    noVerdict: await confirm(COORD, { verdict: undefined }),
  };
  for (const [name, reply] of Object.entries(results.refusals)) {
    assert.equal(reply.status, 400, `${name} must be refused: ${JSON.stringify(reply)}`);
  }
  s = await snapshot();
  assert.equal(s.tasks.find((t) => t.id === review.id).status, "running", "refusals changed nothing");

  // The coordinator's own judgement settles it, once.
  results.confirmed = await confirm(COORD, {});
  assert.equal(results.confirmed.status, 200, JSON.stringify(results.confirmed));
  results.duplicate = await confirm(COORD, { verdict: "fail" });
  assert.equal(results.duplicate.status, 400);
  s = await snapshot();
  const settled = s.tasks.find((t) => t.id === review.id);
  const attempt = s.attempts.find((a) => a.id === held.id);
  results.settled = { status: settled.status, verdict: settled.verdict, resultIsWords: settled.result === proposal.text,
    confirmedBy: attempt.proposedReport.confirmedBy, filesModified: attempt.filesModified, dependant: s.tasks.find((t) => t.id === after.id).status };
  assert.equal(settled.status, "completed");
  assert.equal(settled.verdict, "pass");
  assert.equal(results.settled.resultIsWords, true);
  assert.equal(results.settled.confirmedBy, COORD);
  assert.deepEqual(attempt.filesModified, []);
  assert.equal(results.settled.dependant, "ready");

  // Relay: same coordinator on both runs only.
  const sibling = await invoke("orchestration_run_create", { actorChatKey: COORD, objective: "A sibling run", workspaceId: project.id, rootPath: repo });
  const foreign = await invoke("orchestration_run_create", { actorChatKey: OTHER, objective: "Another coordinator's run", workspaceId: project.id, rootPath: repo });
  const relay = (actor, from, to, extra = {}) => hook(actor, "relay_send", { fromRunId: from, toRunId: to, subject: "Shared file", body: "Both runs touch README.md.", ...extra });
  results.relay = {
    sent: await relay(COORD, run.id, sibling.id, { originAttemptId: held.id }),
    repeat: await relay(COORD, run.id, sibling.id, { originAttemptId: held.id }),
    toOtherCoordinator: await relay(COORD, run.id, foreign.id),
    fromOtherCoordinator: await relay(OTHER, foreign.id, run.id),
    asWorker: await relay(workerKey, run.id, sibling.id),
  };
  assert.equal(results.relay.sent.status, 200);
  assert.equal(results.relay.repeat.result.id, results.relay.sent.result.id, "recorded once");
  for (const name of ["toOtherCoordinator", "fromOtherCoordinator", "asWorker"]) assert.equal(results.relay[name].status, 400, name);
  const siblingView = await invoke("orchestration_snapshot", { runId: sibling.id });
  results.relay.siblingMessages = siblingView.messages.map((m) => ({ kind: m.kind, relay: m.relay }));
  assert.equal(siblingView.messages.filter((m) => m.kind === "relay").length, 1);
  assert.equal(siblingView.attempts.length, 0, "the receiving run sees no worker of the origin run");
  results.pass = true;
} catch (error) {
  results.pass = false;
  results.error = String(error?.stack ?? error);
} finally {
  fs.writeFileSync(path.join(OUT, "readonly-proposed-report.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(OUT, "readonly-server.log"), serverLog);
  ws?.close();
  server.kill("SIGTERM");
}
console.log(JSON.stringify({ pass: results.pass, evidence: OUT, error: results.error }, null, 2));
process.exit(results.pass ? 0 : 1);
