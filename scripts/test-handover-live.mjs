// Live check: an agent hands its task over, the person confirms or declines
// on the card, and the new chat starts on the recipient's registered settings
// with the brief and a link back (handover.rs, components/HandoverCards).
//
// Evidence class: STUB PROVIDER, REAL SERVER, REAL BROWSER. This checkout's
// octiq-server runs under a throwaway HOME with a stand-in `claude` first on
// PATH. A source chat's stand-in, asked to hand over, POSTs /hook/handover
// itself with its own launch capability while its turn is in flight, exactly
// as the octiq MCP does, and prints the host's answer as its reply. Nothing
// here touches the person's profile, chats or service. No real model runs.
//
//   (cd src-tauri && cargo build --bin octiq-server)
//   (cd web && ./node_modules/.bin/vite build --outDir <srv>/v2 --emptyOutDir)
//   cp src-tauri/target/debug/octiq-server <srv>/octiq-server
//   OUT=<evidence dir> PLAYWRIGHT_MODULE=<playwright/index.mjs> \
//     node scripts/test-handover-live.mjs <srv>/octiq-server
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const SERVER = process.argv[2];
if (!SERVER) throw new Error("Pass the octiq-server to run, placed beside a v2/ client build.");
const OUT = process.env.OUT || fs.mkdtempSync(path.join(os.tmpdir(), "octiq-handover-evidence-"));
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-handover-"));
const HOME = path.join(DIR, "home");
const BIN = path.join(DIR, "bin");
const LOG = path.join(DIR, "stub.log");
const PORT = 17000 + Math.floor(Math.random() * 1000);
const TOKEN = "handover-live";
fs.mkdirSync(OUT, { recursive: true });

// The stand-in for `claude -p --input-format stream-json`. A message that
// starts with HANDOVER makes it call the hook the way the MCP tool does.
function stubClaude() {
  const fs = require("fs");
  const http = require("http");
  const readline = require("readline");
  const env = process.env;
  const key = env.OCTIQ_CHAT_KEY || "unknown";
  const log = (entry) => fs.appendFileSync(env.STUB_LOG, JSON.stringify({ at: Date.now(), key, ...entry }) + "\n");
  // `claude -p <prompt> …`: the one-shot read-only fork a handover's ask back
  // runs as the source chat's agent. It answers and exits; it is no chat.
  const argv = process.argv.slice(2);
  const prompt = argv[argv.indexOf("-p") + 1];
  if (argv.includes("-p") && prompt && !prompt.startsWith("--")) {
    log({ answering: true, argv, cwd: process.cwd(), octiq: Object.keys(env).filter((name) => name.startsWith("OCTIQ_")) });
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false,
      result: "The cookie path is set in auth.ts.\nKeep the cookie name: renaming it logs everyone out." }) + "\n");
    return;
  }
  log({ launch: true, argv, session: "stub-" + process.pid });
  const session = "stub-" + process.pid;
  const out = (event) => process.stdout.write(JSON.stringify({ session_id: session, ...event }) + "\n");
  const reply = (said) => {
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: said }] } });
    out({ type: "result", subtype: "success", is_error: false, result: said, duration_ms: 1, num_turns: 1 });
  };
  const handover = (args, route = "/hook/handover") => new Promise((resolve) => {
    const body = JSON.stringify({ chatKey: key, sessionKey: env.OCTIQ_SESSION_KEY || key,
      launchId: env.OCTIQ_LAUNCH_ID, wait: true, args });
    const req = http.request({ host: "127.0.0.1", port: Number(env.OCTIQ_HOOK_PORT), path: route, method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body),
        "x-octiq-chat-capability": env.OCTIQ_CHAT_CAPABILITY || "" } }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode, ...JSON.parse(text || "{}") }));
    });
    req.on("error", (error) => resolve({ status: 0, error: String(error) }));
    req.end(body);
  });
  out({ type: "system", subtype: "init", model: "stub", tools: [] });
  readline.createInterface({ input: process.stdin }).on("line", async (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === "control_request" && msg.request?.subtype === "initialize") {
      out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: {} } });
      return;
    }
    if (msg.type !== "user") return;
    const content = msg.message?.content;
    const text = typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("\n");
    log({ user: text });
    // The recipient of a handover, on its first turn: one question back to
    // the agent that handed it over, then the outcome, as the MCP tools do.
    if (text.startsWith("[OctiqFlow handover ")) {
      const ask = await handover({ question: "Where is the cookie path set, and may I rename the cookie?",
        contextPaths: ["auth.ts"], requestId: "ask-1" }, "/hook/handover/ask");
      log({ askBack: ask });
      const outcome = await handover({ status: "done", summary: "Cookie path fixed in auth.ts; the regression test passes.",
        requestId: "outcome-1" }, "/hook/handover/outcome");
      log({ outcomeBack: outcome });
      return reply(`Asked back and reported. ${ask.result?.text ?? ask.error}`);
    }
    const asked = text.match(/^HANDOVER (\S+) (\S+)/);
    if (!asked) return reply("Noted.");
    const answer = await handover({
      recipient: asked[1], requestId: asked[2],
      brief: {
        objective: "Finish the login fix: the session cookie must survive a reload.",
        doneSoFar: "Found the bug: the cookie is written without a path, so /settings never sees it.",
        remaining: "Write the regression test, then fix the cookie path in auth.ts.",
        decisions: "Keep the cookie name; renaming it logs everyone out.",
        openQuestions: "Should the fix also cover the mobile web view?",
        authorized: ["commit on this branch"],
        notAuthorized: ["push", "merge", "deploy", "restart"],
      },
    });
    log({ hook: answer });
    reply(answer.result?.text ?? `Refused: ${answer.error}`);
  });
}

fs.mkdirSync(BIN, { recursive: true });
fs.writeFileSync(path.join(BIN, "claude"), `#!/usr/bin/env node\n(${stubClaude.toString()})();\n`, { mode: 0o755 });
const repo = path.join(HOME, "code", "fixture");
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n");
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
const commit = ["-c", "user.email=t@example.invalid", "-c", "user.name=t"];
git("init", "-q", "-b", "develop");
git(...commit, "add", "README.md");
git(...commit, "commit", "-q", "-m", "fixture");
const second = path.join(HOME, "code", ".worktrees", "fixture-settings");
git("worktree", "add", "-q", "-b", "settings-refactor", second);
// Uncommitted work in the source checkout, which the card must report.
fs.writeFileSync(path.join(repo, "auth.ts"), "export const cookiePath = undefined;\n");

const ENV = { ...process.env, HOME, SHELL: "/bin/zsh", OCTIQ_WEB_PORT: String(PORT), OCTIQ_WEB_TOKEN: TOKEN,
  OCTIQ_CHAT_IDLE_MINS: "0", PATH: `${BIN}:${process.env.PATH}`, STUB_LOG: LOG };
for (const name of ["OCTIQ_CHAT_KEY", "OCTIQ_SESSION_KEY", "OCTIQ_LAUNCH_ID", "OCTIQ_CHAT_CAPABILITY", "OCTIQ_HOOK_PORT", "OCTIQ_ROOT"]) {
  delete ENV[name];
}
const stub = () => fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const wait = async (what, test, ms = 30_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const got = await test();
    if (got) return got;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
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

const results = { port: PORT, evidence: "stub provider, real server, real browser; no live model turn" };
let browser;
const shot = async (page, name) => page.screenshot({ path: path.join(OUT, name) });
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
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

  const project = await invoke("add_workspace", { name: "Fixture", primaryPath: repo });
  const mango = await invoke("team_save", { agent: { name: "Mango", role: "Builds the web app", agent: "claude",
    model: "sonnet", effort: "high", access: "edits", projectId: project.id } });
  results.recipient = { id: mango.id ?? mango.agent?.id, model: "sonnet", access: "edits", effort: "high" };

  const startChat = async (id, title, cwd, prompt) => {
    await invoke("chat_index_save", { meta: { id, projectId: project.id, title, customTitle: true, cwd,
      modelId: "claude:opus", access: "auto", createdAt: Date.now(), updatedAt: Date.now(), generation: 0 } });
    await invoke("chat_start", { key: `chat:${id}`, cwd, agent: "claude", model: "opus", access: "auto", useSandbox: false,
      prompt, turnId: `user-${id}-${Date.now()}` });
  };
  const handovers = () => invoke("handover_list");

  // ---- A: the source chat's agent asks to hand over; the turn waits.
  await startChat("source-a", "Fix the login bug", repo, "HANDOVER Mango req-a");
  const pending = await wait("a pending handover", async () => (await handovers()).find((h) => h.status === "pending"));
  results.pending = { id: pending.id, to: pending.to, settings: pending.settings, workspace: pending.workspace };
  assert.equal(pending.to.name, "Mango");
  assert.deepEqual([pending.settings.model, pending.settings.access, pending.settings.effort], ["sonnet", "edits", "high"]);
  assert.equal(pending.workspace.mode, "continue");
  assert.equal(pending.workspace.chosen, "source");
  assert.equal(pending.workspace.branch, "develop");
  assert.equal(pending.workspace.uncommitted, true, "git sees auth.ts");
  assert.ok(!JSON.stringify(pending).includes("OCTIQ"), "no private settings reach the browser");

  // No agent route reaches the decision.
  const forged = await fetch(`http://127.0.0.1:${PORT}/hook/orchestration`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chatKey: "chat:source-a", action: "handover_confirm", args: { id: pending.id } }) });
  results.hookCannotConfirm = forged.status;
  assert.notEqual(forged.status, 200);
  assert.equal((await handovers()).find((h) => h.id === pending.id).status, "pending");

  // ---- Browser: the card in the source chat.
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.addInitScript(() => {
    if (location.protocol.startsWith("http")) try { localStorage.setItem("octiq.v2.gitColumn", "0"); } catch {}
  });
  await page.goto(`http://127.0.0.1:${PORT}/?token=${TOKEN}`);
  await page.locator(".chat-btn", { hasText: "Fix the login bug" }).first().click();
  const card = page.locator(`.handover-card[data-handover="${pending.id}"]`);
  // The same handover once it has settled: a line, no longer the card at the
  // end of the chat. The incoming line carries the same id, so it is left out.
  const settled = (id) => page.locator(`.handover-line[data-handover="${id}"]:not([data-status="incoming"])`);
  await card.waitFor({ timeout: 20_000 });
  assert.equal(await card.getAttribute("data-status"), "pending");
  results.pendingText = (await card.innerText()).replace(/\s+/g, " ");
  assert.match(results.pendingText, /Hand this task to Mango\?/);
  assert.match(results.pendingText, /Uncommitted changes travel with it/);
  await card.scrollIntoViewIfNeeded();
  await shot(page, "1-source-pending-desktop.png");
  await card.locator("details.handover-brief > summary").click();
  await page.waitForTimeout(250);
  await card.scrollIntoViewIfNeeded();
  await shot(page, "2-source-pending-brief-desktop.png");
  await card.locator("details.handover-brief > summary").click();

  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(400);
  await card.scrollIntoViewIfNeeded();
  results.pendingPhoneNoSideways = await noSideways(page);
  await shot(page, "3-source-pending-phone-375.png");
  assert.equal(results.pendingPhoneNoSideways, true);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.waitForTimeout(300);

  // ---- The person confirms.
  await card.getByRole("button", { name: "Hand over to Mango" }).click();
  const line = settled(pending.id);
  await line.waitFor({ timeout: 30_000 });
  assert.equal(await line.getAttribute("data-status"), "confirmed");
  assert.equal(await card.count(), 0, "a confirmed handover no longer holds the end of the chat");
  const confirmed = (await handovers()).find((h) => h.id === pending.id);
  results.confirmed = { target: confirmed.targetChatKey, notice: confirmed.notice };
  assert.ok(confirmed.targetChatKey);
  const target = confirmed.targetChatKey;
  // The source agent's tool returned the decision.
  const toolAnswer = await wait("the source agent to hear it", () =>
    stub().find((e) => e.key === "chat:source-a" && e.hook)?.hook);
  results.sourceToolAnswer = toolAnswer.result?.text;
  assert.match(results.sourceToolAnswer, /confirmed handover/);
  assert.match(results.sourceToolAnswer, /Stop now/);
  assert.equal(confirmed.notice, "tool");
  // The recipient's chat: launched on its registered settings, with the brief.
  const launched = await wait("the recipient's launch", () => stub().find((e) => e.key === target && e.launch));
  results.targetArgv = launched.argv.join(" ");
  assert.match(results.targetArgv, /--model sonnet --permission-mode acceptEdits --effort high/);
  // The tool is pre-allowed, so the person sees one card, not a permission
  // prompt in front of it.
  assert.match(results.targetArgv, /mcp__octiq__handover/);
  const first = await wait("the recipient's first message", () => stub().find((e) => e.key === target && e.user));
  results.targetFirstMessage = first.user.slice(0, 1600);
  assert.match(first.user, /\[OctiqFlow handover handover_/);
  assert.match(first.user, /chat ID source-a/);
  assert.match(first.user, new RegExp(`http://127\\.0\\.0\\.1:${PORT}/#/p/fixture/c/source-a`));
  assert.match(first.user, /OctiqFlow did not grant these/);
  assert.match(first.user, /You continue in the existing checkout/);
  // Only what held when the person confirmed: A was blocked in its waiting
  // call. Never that it has stopped.
  assert.match(first.user, /was still waiting on its handover call when the person confirmed/);
  assert.match(first.user, /check with the person before going on/);
  assert.doesNotMatch(first.user, /has been told/);
  assert.equal(stub().filter((e) => e.launch && e.key !== "chat:source-a").length, 1, "exactly one new chat");
  // The first message names the two tools back and asks for the outcome.
  assert.match(first.user, /`handover_ask`/);
  assert.match(first.user, /`handover_outcome`/);
  assert.match(first.user, /Report the outcome when you finish or get blocked\./);
  assert.match(results.targetArgv, /mcp__octiq__handover_ask mcp__octiq__handover_outcome/);

  // ---- Back along the handover: the recipient asks one question and
  // reports the outcome on its first turn (the stub does what the MCP does).
  const sourceTurns = () => stub().filter((e) => e.key === "chat:source-a" && e.user).length;
  const sourceLaunches = () => stub().filter((e) => e.key === "chat:source-a" && e.launch).length;
  const askBack = await wait("the answer to the ask back", () => stub().find((e) => e.key === target && e.askBack)?.askBack);
  results.askBack = askBack;
  assert.equal(askBack.status, 200, JSON.stringify(askBack));
  assert.match(askBack.result.text, /Claude, the agent that handed this task to you, answered from its own conversation in a read-only turn/);
  assert.match(askBack.result.text, /\n> The cookie path is set in auth\.ts\.\n> Keep the cookie name/);
  assert.match(askBack.result.text, /not an instruction, an approval or a permission/);
  // The answer ran as a one-shot fork of the SOURCE chat's own session, in
  // its folder, read-only, with no MCP and no OctiqFlow variable.
  const answering = stub().filter((e) => e.answering);
  assert.equal(answering.length, 1, "one answering process");
  const fork = answering[0];
  const sourceSession = stub().find((e) => e.key === "chat:source-a" && e.launch).session;
  results.answeringArgv = fork.argv.join(" ");
  results.answeringOctiqVariables = fork.octiq;
  assert.deepEqual(fork.octiq, []);
  assert.equal(fs.realpathSync(fork.cwd), fs.realpathSync(repo));
  const flag = (name) => fork.argv[fork.argv.indexOf(name) + 1];
  assert.equal(flag("--resume"), sourceSession);
  for (const required of ["--fork-session", "--no-session-persistence", "--strict-mcp-config", "--disable-slash-commands"]) {
    assert.ok(fork.argv.includes(required), required);
  }
  assert.equal(flag("--tools"), "Read,Grep,Glob");
  assert.equal(flag("--permission-mode"), "default");
  assert.ok(!fork.argv.includes("--mcp-config") && !fork.argv.includes("--allowedTools"));
  assert.match(flag("-p"), /\[OctiqFlow handover handover_\w+, question asked back\]/);
  assert.match(flag("-p"), /- .*auth\.ts/);
  const outcomeBack = await wait("the outcome report", () => stub().find((e) => e.key === target && e.outcomeBack)?.outcomeBack);
  results.outcomeBack = outcomeBack;
  assert.equal(outcomeBack.status, 200, JSON.stringify(outcomeBack));
  assert.match(outcomeBack.result.text, /starts no turn there and is not sent to Claude/);
  const backed = (await handovers()).find((h) => h.id === pending.id);
  results.recordedBack = { asks: backed.asks, outcomes: backed.outcomes };
  assert.equal(backed.asks.length, 1);
  assert.equal(backed.asks[0].status, "answered");
  assert.deepEqual(backed.asks[0].contextPaths, ["auth.ts"]);
  assert.equal(backed.outcomes.at(-1).status, "done");
  // Neither started a turn in the source chat, or a new process for it.
  assert.equal(sourceTurns(), 1, "the source agent was never sent a message");
  assert.equal(sourceLaunches(), 1, "the source chat was never relaunched");

  // ---- Browser: the outcome and the question on the source chat's line.
  const outcomeLine = line.locator(".handover-outcome");
  await outcomeLine.waitFor({ timeout: 20_000 });
  results.sourceOutcomeLine = (await outcomeLine.innerText()).trim();
  assert.equal(results.sourceOutcomeLine, "Mango finished: Cookie path fixed in auth.ts; the regression test passes.");
  const asksLog = line.locator("details.handover-asks");
  assert.equal((await asksLog.locator("summary").innerText()).trim(), "1 question asked back");
  assert.equal(await asksLog.evaluate((d) => d.open), false, "folded until asked");
  assert.equal(await card.count(), 0);
  assert.equal(await page.locator(".handover-card").count(), 0, "never a card");
  await line.scrollIntoViewIfNeeded();
  await shot(page, "4-source-confirmed-desktop.png");
  await asksLog.locator("summary").click();
  await page.waitForTimeout(250);
  results.sourceAskText = (await asksLog.innerText()).replace(/\s+/g, " ");
  assert.match(results.sourceAskText, /Mango asked Claude · Answered/);
  assert.match(results.sourceAskText, /Keep the cookie name/);
  await line.scrollIntoViewIfNeeded();
  await shot(page, "4a-source-outcome-and-ask-desktop.png");
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(400);
  await line.scrollIntoViewIfNeeded();
  results.backPhoneNoSideways = await noSideways(page);
  await shot(page, "4b-source-outcome-and-ask-phone-375.png");
  assert.equal(results.backPhoneNoSideways, true);
  await asksLog.locator("summary").click();
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.waitForTimeout(300);

  // ---- Follow the link to the new chat; it links back.
  await line.getByRole("button", { name: "Open Mango's chat" }).click();
  const incoming = page.locator(`.handover-line[data-status="incoming"]`);
  await incoming.waitFor({ timeout: 20_000 });
  results.incomingText = (await incoming.innerText()).replace(/\s+/g, " ");
  assert.match(results.incomingText, /Handed over from Claude/);
  // The same outcome and question on the incoming line, at the head.
  assert.match(results.incomingText, /Mango finished: Cookie path fixed in auth\.ts; the regression test passes\./);
  assert.match(results.incomingText, /1 question asked back/);
  const incomingAsks = incoming.locator("details.handover-asks");
  await incomingAsks.locator("summary").click();
  await page.waitForTimeout(250);
  await incoming.scrollIntoViewIfNeeded();
  await shot(page, "5a-target-outcome-and-ask-desktop.png");
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(400);
  await incoming.scrollIntoViewIfNeeded();
  results.incomingBackPhoneNoSideways = await noSideways(page);
  await shot(page, "5b-target-outcome-and-ask-phone-375.png");
  assert.equal(results.incomingBackPhoneNoSideways, true);
  await incomingAsks.locator("summary").click();
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.waitForTimeout(300);
  // The source chat's title is in the facts under the line.
  await incoming.getByRole("button", { name: "Brief" }).click();
  assert.match((await incoming.innerText()).replace(/\s+/g, " "), /Fix the login bug/);
  await incoming.scrollIntoViewIfNeeded();
  await shot(page, "5-target-incoming-desktop.png");
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(400);
  await incoming.scrollIntoViewIfNeeded();
  results.incomingPhoneNoSideways = await noSideways(page);
  await shot(page, "6-target-incoming-phone-375.png");
  assert.equal(results.incomingPhoneNoSideways, true);

  // ---- A reload restores both, and the back link works.
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.reload();
  await page.locator(`.handover-line[data-status="incoming"]`).waitFor({ timeout: 20_000 });
  await page.locator(`.handover-line[data-status="incoming"]`).getByRole("button", { name: "Open the original chat" }).click();
  const restored = settled(pending.id);
  await restored.waitFor({ timeout: 20_000 });
  results.restoredStatus = await restored.getAttribute("data-status");
  assert.equal(results.restoredStatus, "confirmed");
  assert.match(await restored.locator(".handover-outcome").innerText(), /^Mango finished: /);
  assert.equal((await restored.locator("details.handover-asks > summary").innerText()).trim(), "1 question asked back");
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(400);
  await restored.scrollIntoViewIfNeeded();
  await shot(page, "7-source-confirmed-after-reload-phone-375.png");
  await page.setViewportSize({ width: 1440, height: 960 });

  // ---- B: one writer at a time. A and Mango are live in the primary
  // checkout, so another chat cannot hand it over too.
  await startChat("source-b", "Second chat in the same checkout", repo, "HANDOVER Mango req-b");
  const refusedB = await wait("B's refusal", () => stub().find((e) => e.key === "chat:source-b" && e.hook)?.hook);
  results.oneWriterRefusal = refusedB.error;
  assert.equal(refusedB.status, 400);
  assert.match(refusedB.error, /working folder of another live chat/);

  // ---- C: the person declines; nothing is created.
  const before = stub().filter((e) => e.launch).length;
  await startChat("source-c", "Refactor the settings page", second, "HANDOVER Mango req-c");
  const pendingC = await wait("C's pending handover", async () =>
    (await handovers()).find((h) => h.sourceChatKey === "chat:source-c" && h.status === "pending"));
  assert.equal(pendingC.workspace.branch, "settings-refactor");
  await page.locator(".chat-btn", { hasText: "Refactor the settings page" }).first().click();
  const cardC = page.locator(`.handover-card[data-handover="${pendingC.id}"]`);
  await cardC.waitFor({ timeout: 20_000 });
  await cardC.getByRole("button", { name: "Keep it here" }).click();
  const lineC = settled(pendingC.id);
  await lineC.waitFor({ timeout: 20_000 });
  assert.equal(await lineC.getAttribute("data-status"), "declined");
  assert.equal(await cardC.count(), 0, "a declined handover no longer holds the end of the chat");
  const declinedAnswer = await wait("C's agent to hear it", () => stub().find((e) => e.key === "chat:source-c" && e.hook)?.hook);
  results.declinedToolAnswer = declinedAnswer.result?.text;
  assert.match(results.declinedToolAnswer, /declined/);
  assert.equal(stub().filter((e) => e.launch).length, before + 1, "only C's own launch; no new chat");
  await lineC.scrollIntoViewIfNeeded();
  await shot(page, "8-source-declined-desktop.png");

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
  fs.writeFileSync(path.join(OUT, "handover-live.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(OUT, "server.log"), serverLog);
  fs.writeFileSync(path.join(OUT, "stub.log"), fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8") : "");
  await browser?.close();
  ws?.close();
  server.kill();
}
console.log(JSON.stringify({ pass: results.pass, evidence: OUT, error: results.error }, null, 2));
process.exit(results.pass ? 0 : 1);
