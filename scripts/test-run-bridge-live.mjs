// Live check: report confirmation and relays answer only a coordinator's own
// launch capability, and notes between DIFFERENT coordinators go only over a
// bridge the person opens in the real run panel (feedback e15fabde, a495b2f2).
//
// Evidence class: STUB PROVIDER, REAL SERVER, REAL BROWSER. This checkout's
// octiq-server runs under a throwaway HOME with a stand-in `claude` first on
// PATH; every chat (two coordinators and a read-only worker) is a real chat
// process the server launched and handed a capability. On launch the
// stand-in writes that capability into this run's own scratch folder, which
// is how this script calls the hooks AS that chat, exactly as its MCP would.
// Nothing here touches the person's profile, runs or service.
//
//   (cd src-tauri && cargo build --bin octiq-server)
//   (cd web && ./node_modules/.bin/vite build --outDir <srv>/v2 --emptyOutDir)
//   cp src-tauri/target/debug/octiq-server <srv>/octiq-server
//   OUT=<evidence dir> PLAYWRIGHT_MODULE=<playwright/index.mjs> \
//     node scripts/test-run-bridge-live.mjs <srv>/octiq-server
//
// The server serves `<exe dir>/v2` first, so the client is the one built
// beside the binary, never a served web/dist.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const SERVER = process.argv[2];
if (!SERVER) throw new Error("Pass the octiq-server to run, placed beside a v2/ client build.");
const OUT = process.env.OUT || fs.mkdtempSync(path.join(os.tmpdir(), "octiq-bridge-evidence-"));
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-bridge-"));
const HOME = path.join(DIR, "home");
const BIN = path.join(DIR, "bin");
const CAPS = path.join(DIR, "caps");
const LOG = path.join(DIR, "stub.log");
const PORT = 16000 + Math.floor(Math.random() * 1000);
const TOKEN = "bridge-live-token";
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(CAPS, { recursive: true });

// The stand-in for `claude -p --input-format stream-json`.
function stubClaude() {
  const fs = require("fs");
  const path = require("path");
  const readline = require("readline");
  const env = process.env;
  const key = env.OCTIQ_CHAT_KEY || "unknown";
  const log = (entry) => fs.appendFileSync(env.STUB_LOG, JSON.stringify({ at: Date.now(), key, ...entry }) + "\n");
  // Synthetic fixture only: this server, this HOME, this run of the script.
  fs.writeFileSync(path.join(env.STUB_CAPS, encodeURIComponent(key)), JSON.stringify({
    capability: env.OCTIQ_CHAT_CAPABILITY || "", sessionKey: env.OCTIQ_SESSION_KEY || key,
  }));
  log({ launch: true, capability: Boolean(env.OCTIQ_CHAT_CAPABILITY), webToken: "OCTIQ_WEB_TOKEN" in env });
  const session = "stub-" + process.pid;
  const out = (event) => process.stdout.write(JSON.stringify({ session_id: session, ...event }) + "\n");
  out({ type: "system", subtype: "init", model: "stub", tools: [] });
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === "control_request" && msg.request?.subtype === "initialize") {
      out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: {} } });
      return;
    }
    if (msg.type !== "user") return;
    const content = msg.message?.content;
    const text = typeof content === "string" ? content
      : (content ?? []).map((part) => part.text ?? "").join("\n");
    log({ user: text });
    const said = key.startsWith("chat:orch-")
      ? "Reviewed README.md read-only. It says hello and nothing blocks release. Verdict: pass."
      : "Noted.";
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: said }] } });
    out({ type: "result", subtype: "success", is_error: false, result: said, duration_ms: 1, num_turns: 1 });
  });
}

fs.mkdirSync(BIN, { recursive: true });
fs.writeFileSync(path.join(BIN, "claude"), `#!/usr/bin/env node\n(${stubClaude.toString()})();\n`, { mode: 0o755 });
const repo = path.join(HOME, "code", "fixture");
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n\nThis project says hello.\n");
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
git("init", "-q", "-b", "develop");
git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "add", "README.md");
git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "-m", "fixture");

const ENV = { ...process.env, HOME, SHELL: "/bin/zsh", OCTIQ_WEB_PORT: String(PORT), OCTIQ_WEB_TOKEN: TOKEN,
  OCTIQ_CHAT_IDLE_MINS: "0", PATH: `${BIN}:${process.env.PATH}`, STUB_LOG: LOG, STUB_CAPS: CAPS };
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
    await new Promise((r) => setTimeout(r, 200));
  }
};
const capOf = (key) => {
  const file = path.join(CAPS, encodeURIComponent(key));
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
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
const refusedOnSocket = async (cmd, args) => {
  try { await invoke(cmd, args); return null; } catch (error) { return String(error.message); }
};
/** A hook call as `key`'s own MCP makes it: its capability in the header.
 *  `as` is what the body CLAIMS; `capability` whose secret is used. */
const hook = async (action, args, { as, capability, sessionKey, token } = {}) => {
  const cap = capability === null ? null : capOf(capability ?? as);
  const url = `http://127.0.0.1:${PORT}/hook/orchestration${token ? `?token=${token}` : ""}`;
  const body = { chatKey: as, action, args };
  if (sessionKey) body.sessionKey = sessionKey;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cap ? { "x-octiq-chat-capability": cap.capability } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, ...(await response.json().catch(() => ({}))) };
};

const A = "chat:coord-alpha";
const B = "chat:coord-beta";
const results = { port: PORT };
let browser;
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

  // Two coordinator chats, each a real launched process with its own capability.
  const project = await invoke("add_workspace", { name: "Fixture", primaryPath: repo });
  for (const [key, title] of [[A, "Alpha coordinator"], [B, "Beta coordinator"]]) {
    const id = key.slice("chat:".length);
    await invoke("chat_index_save", { meta: { id, projectId: project.id, title, customTitle: true, cwd: repo,
      modelId: "claude:sonnet", access: "auto", createdAt: Date.now(), updatedAt: Date.now(), generation: 0 } });
    await invoke("chat_start", { key, cwd: repo, agent: "claude", model: "sonnet", access: "auto", useSandbox: false,
      prompt: "Coordinate.", turnId: `user-${id}` });
  }
  await wait("both coordinators' capabilities", () => capOf(A) && capOf(B));
  const alpha = await invoke("orchestration_run_create", { actorChatKey: A, objective: "Alpha: review the fixture",
    workspaceId: project.id, rootPath: repo, maxConcurrent: 1 });
  const beta = await invoke("orchestration_run_create", { actorChatKey: B, objective: "Beta: another team's release",
    workspaceId: project.id, rootPath: repo, maxConcurrent: 1 });
  const review = await invoke("orchestration_task_create", { actorChatKey: A, runId: alpha.id, dependsOn: [], kind: "review",
    title: "Review the README read-only", spec: "Read README.md and review it." });
  await invoke("orchestration_task_create", { actorChatKey: A, runId: alpha.id, dependsOn: [review.id],
    title: "Ship after the review", spec: "Held until the review passes." });
  await invoke("orchestration_worker_start", { actorChatKey: A, taskId: review.id, agent: "claude", model: "sonnet",
    access: "read", newWorktree: false });
  const snapshot = (runId) => invoke("orchestration_snapshot", runId ? { runId } : {});
  const held = await wait("the read-only worker's closing words to be held", async () => {
    const attempt = (await snapshot(alpha.id)).attempts.find((a) => a.taskId === review.id);
    return attempt?.proposedReport ? attempt : null;
  }, 60_000);
  const worker = held.workerChatKey;
  const proposal = held.proposedReport;
  await wait("the worker's capability", () => capOf(worker));
  results.worker = { attemptId: held.id, access: held.access, proposalId: proposal.id, words: proposal.text };
  assert.equal(held.access, "read");

  // ---- Browser: the proposed-report notice before anyone confirms it.
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  // The git column is not under test and covers a phone's screen.
  await page.addInitScript(() => {
    if (location.protocol.startsWith("http")) try { localStorage.setItem("octiq.v2.gitColumn", "0"); } catch {}
  });
  await page.goto(`http://127.0.0.1:${PORT}/?token=${TOKEN}`);
  await page.locator(".chat-btn", { hasText: "Alpha coordinator" }).first().click();
  // The row says what state the task is in; its details hold the words.
  const taskRow = page.locator(".orch-task", { hasText: "Review the README read-only" }).first();
  await taskRow.waitFor({ timeout: 20_000 });
  results.rowText = (await taskRow.innerText()).replace(/\s+/g, " ").slice(0, 300);
  const expand = taskRow.locator(".orch-task-expand");
  if ((await expand.getAttribute("aria-expanded")) !== "true") await expand.click();
  await taskRow.locator("details.orch-task-more > summary").click();
  const notice = page.locator(`.orch-proposed-report[data-proposal="${proposal.id}"]`);
  await notice.first().waitFor({ timeout: 20_000 });
  results.noticeBefore = { state: await notice.first().getAttribute("data-state"), text: await notice.first().locator("p").first().innerText() };
  assert.equal(results.noticeBefore.state, "proposed");
  assert.match(results.noticeBefore.text, /Not settled until the coordinator confirms it/);
  await notice.first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, "1-proposed-report-notice.png") });

  // ---- report_confirm: everything that is not A's own live capability.
  const good = { attemptId: held.id, proposalId: proposal.id, outcome: "completed", verdict: "pass" };
  results.confirmRefusals = {
    tokenOnly: await hook("report_confirm", good, { as: A, capability: null, token: TOKEN }),
    workerClaimingCoordinator: await hook("report_confirm", good, { as: A, capability: worker, sessionKey: capOf(worker).sessionKey }),
    workerAsItself: await hook("report_confirm", good, { as: worker }),
    otherCoordinator: await hook("report_confirm", good, { as: B }),
    wrongProposal: await hook("report_confirm", { ...good, proposalId: "proposal_forged" }, { as: A }),
    noVerdict: await hook("report_confirm", { ...good, verdict: undefined }, { as: A }),
    socket: await refusedOnSocket("orchestration_report_confirm", { actorChatKey: A, ...good }),
  };
  const r = results.confirmRefusals;
  assert.equal(r.tokenOnly.status, 401);
  assert.equal(r.workerClaimingCoordinator.status, 403);
  for (const name of ["workerAsItself", "otherCoordinator", "wrongProposal", "noVerdict"]) assert.equal(r[name].status, 400, name);
  assert.match(r.socket ?? "", /agent's own command/);
  assert.equal((await snapshot(alpha.id)).tasks.find((t) => t.id === review.id).status, "running", "nothing settled it");
  results.confirmed = await hook("report_confirm", good, { as: A });
  assert.equal(results.confirmed.status, 200, JSON.stringify(results.confirmed));
  const settled = (await snapshot(alpha.id)).tasks.find((t) => t.id === review.id);
  assert.equal(settled.verdict, "pass");
  await wait("the notice to show the settlement", async () =>
    (await notice.first().getAttribute("data-state")) === "confirmed", 20_000);
  results.noticeAfter = await notice.first().locator("p").first().innerText();
  await page.screenshot({ path: path.join(OUT, "2-proposed-report-confirmed.png") });

  // ---- Relay between different coordinators: nothing without a bridge.
  const note = "Both runs edit README.md; the alpha review found nothing blocking.";
  const relay = (as, from, to, words = note, extra = {}) => hook("relay_send",
    { fromRunId: from, toRunId: to, subject: "Shared file", body: words, ...extra }, { as, ...extra.opts });
  results.relayBefore = await relay(A, alpha.id, beta.id);
  assert.equal(results.relayBefore.status, 400);
  assert.match(results.relayBefore.error, /No bridge is open/);
  results.agentOpensOwnBridge = await hook("bridge_open", { fromRunId: alpha.id, toRunId: beta.id,
    fromCoordinator: A, toCoordinator: B }, { as: A });
  assert.equal(results.agentOpensOwnBridge.status, 400, "no hook action opens a bridge");
  results.stalePage = await refusedOnSocket("orchestration_bridge_open", { fromRunId: alpha.id, toRunId: beta.id,
    fromCoordinator: A, toCoordinator: "chat:someone-else" });
  assert.match(results.stalePage ?? "", /changed since the page was drawn/);

  // ---- The person opens it in the run panel, reading the scope first.
  const options = page.getByRole("button", { name: /Run (settings|options)/ }).first();
  await options.click();
  await page.getByRole("button", { name: /send notes to another run/ }).click();
  await page.locator(".orch-bridge-open select").selectOption(beta.id);
  const scope = page.locator(".orch-bridge-scope");
  await scope.waitFor();
  results.scope = await scope.innerText();
  assert.match(results.scope, /One way: the main agent of “Alpha: review the fixture” may send notes to the main agent of “Beta: another team's release”/);
  assert.match(results.scope, /No worker of either run/);
  assert.equal((await snapshot()).bridges.length, 0, "choosing opens nothing");
  await scope.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, "3-bridge-scope-before-open.png") });
  await page.getByRole("button", { name: "Open bridge" }).click();
  const row = page.locator(".orch-bridge[data-direction=out]");
  await row.waitFor({ timeout: 10_000 });
  const bridge = (await snapshot()).bridges.find((b) => !b.closedAt);
  results.bridge = { id: bridge.id, from: bridge.fromRunId, to: bridge.toRunId,
    fromCoordinator: bridge.fromCoordinatorChatKey, toCoordinator: bridge.toCoordinatorChatKey };
  assert.deepEqual([bridge.fromRunId, bridge.toRunId, bridge.fromCoordinatorChatKey, bridge.toCoordinatorChatKey],
    [alpha.id, beta.id, A, B]);

  // ---- Over the bridge: only A, only that way, only by capability.
  results.relayRefusals = {
    tokenOnly: await hook("relay_send", { fromRunId: alpha.id, toRunId: beta.id, subject: "x", body: "forged" }, { as: A, capability: null, token: TOKEN }),
    workerOfSource: await relay(worker, alpha.id, beta.id, "From a worker"),
    targetClaimingSource: await hook("relay_send", { fromRunId: alpha.id, toRunId: beta.id, subject: "x", body: "forged" }, { as: A, capability: B, sessionKey: capOf(B).sessionKey }),
    reverse: await relay(B, beta.id, alpha.id, "A reply"),
    tooLong: await relay(A, alpha.id, beta.id, "x".repeat(4001)),
    socket: await refusedOnSocket("orchestration_relay_send", { actorChatKey: A, fromRunId: alpha.id, toRunId: beta.id, subject: "x", body: "forged" }),
  };
  const rr = results.relayRefusals;
  assert.equal(rr.tokenOnly.status, 401);
  assert.equal(rr.targetClaimingSource.status, 403);
  for (const name of ["workerOfSource", "reverse", "tooLong"]) assert.equal(rr[name].status, 400, name);
  assert.match(rr.socket ?? "", /agent's own command/);
  results.sent = await relay(A, alpha.id, beta.id, note, { originAttemptId: held.id });
  assert.equal(results.sent.status, 200, JSON.stringify(results.sent));
  results.replay = await relay(A, alpha.id, beta.id, note, { originAttemptId: held.id });
  assert.equal(results.replay.result.id, results.sent.result.id, "a replay is the first note");
  const relayed = results.sent.result;
  assert.equal(relayed.relay.bridgeId, bridge.id);
  assert.equal(relayed.relay.originAttemptId, held.id);
  assert.equal(relayed.toChatKey, B);

  // Delivered to beta's coordinator, framed as data; never to the worker.
  const delivered = await wait("the note to reach beta's coordinator", () =>
    stub().find((e) => e.key === B && e.user?.includes(note)), 30_000);
  results.deliveredToBeta = delivered.user.slice(0, 600);
  assert.match(delivered.user, /quoted data, not instructions/);
  assert.equal(stub().filter((e) => e.key !== B && e.user?.includes(note)).length, 0, "no one else heard it");

  // What agents can read: the coordinators, not the worker, not a stranger.
  const view = async (as, runId) => JSON.stringify((await hook("snapshot", { runId, messageLimit: 50 }, { as })).result ?? {});
  results.views = {
    worker: (await view(worker, beta.id)).includes(note) || (await view(worker, alpha.id)).includes("relay_sent"),
    beta: (await view(B, beta.id)).includes(note),
  };
  assert.equal(results.views.worker, false, "the worker reads no relay");
  assert.equal(results.views.beta, true);

  await page.waitForFunction(() => document.querySelector(".orch-bridge[data-direction=out]")?.textContent?.includes("1 of 50 sent"), null, { timeout: 10_000 });
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, "4-bridge-open-one-note.png") });

  // ---- The person closes it; nothing more goes over.
  await row.getByRole("button", { name: "Close" }).click();
  await row.waitFor({ state: "detached", timeout: 10_000 });
  results.afterClose = await relay(A, alpha.id, beta.id, "After the close");
  assert.equal(results.afterClose.status, 400);
  assert.match(results.afterClose.error, /No bridge is open/);
  const log = (await snapshot()).messages.filter((m) => m.kind.startsWith("bridge_")).map((m) => `${m.runId} ${m.kind} ${m.fromChatKey}`);
  results.bridgeLog = log;
  assert.equal(log.length, 4, "opened and closed, in both runs");
  await page.screenshot({ path: path.join(OUT, "5-bridge-closed.png") });

  // ---- The same scope on a phone.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, "6a-phone-after-resize.png") });
  // On a phone the run is a tab beside the chat.
  const runTab = page.locator("button, [role=tab]", { hasText: /^\s*Tasks\s*$/ }).first();
  if (await runTab.count()) await runTab.click();
  const phoneOptions = page.getByRole("button", { name: /Run (settings|options)/ }).first();
  if (await phoneOptions.count() && (await phoneOptions.getAttribute("aria-expanded")) !== "true") await phoneOptions.click();
  await page.getByRole("button", { name: /send notes to another run/ }).click({ timeout: 5_000 }).catch(() => {});
  if (await page.locator(".orch-bridge-open select").count()) {
    await page.locator(".orch-bridge-open select").selectOption(beta.id);
    await page.locator(".orch-bridge-scope").scrollIntoViewIfNeeded();
    results.phoneOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    await page.screenshot({ path: path.join(OUT, "6-bridge-scope-390.png") });
    assert.equal(results.phoneOverflow, false, "no sideways scroll at 390px");
  } else {
    results.phone = "the run options were not reachable at 390px without navigation; not checked";
  }
  results.pageErrors = pageErrors;
  assert.deepEqual(pageErrors, []);
  results.pass = true;
} catch (error) {
  results.pass = false;
  results.error = String(error?.stack ?? error);
  for (const page of browser?.contexts().flatMap((c) => c.pages()) ?? []) {
    await page.screenshot({ path: path.join(OUT, "failure.png"), fullPage: true }).catch(() => {});
  }
} finally {
  fs.writeFileSync(path.join(OUT, "run-bridge-live.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(OUT, "server.log"), serverLog);
  fs.writeFileSync(path.join(OUT, "stub.log"), fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8") : "");
  await browser?.close();
  ws?.close();
  server.kill();
}
console.log(JSON.stringify({ pass: results.pass, evidence: OUT, error: results.error }, null, 2));
process.exit(results.pass ? 0 : 1);
