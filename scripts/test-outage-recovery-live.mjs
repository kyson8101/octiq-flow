// Live end-to-end: a call Claude refused because its classifier was
// unavailable is recovered from the card — "Always allow in this project",
// "Always allow everywhere" and "Retry once" — through the real server and the
// real client.
//
// Evidence class: STUB PROVIDER, REAL SERVER, REAL CLIENT. A debug
// octiq-server runs in a throwaway HOME with a stand-in `claude` first on
// PATH, and serves a client built from this tree (`<exe dir>/v2`). Playwright
// drives the page. No model and no real classifier are involved:
//
// - The stand-in emits the refusal exactly as claude 2.1.x does
//   (`permission_denied`, `decision_reason: "Classifier unavailable"`, the
//   verbatim message) for any call its "classifier" cannot judge.
// - Before EVERY call it re-reads the settings files real Claude reads — the
//   project's `.claude/settings.local.json` and `$HOME/.claude/settings.json`
//   — and runs a call a `permissions.allow` rule covers without asking the
//   classifier. That is how Claude's auto mode treats allow rules, and a live
//   probe on claude 2.1.284 (2026-09-30) showed a running `claude -p` picks up
//   a rule written to settings.local.json between two turns.
// - `git push …` and the MCP upload are "classifier down" until a rule covers
//   them; `ls | wc -l` is down only on its first try (a transient outage), so
//   "Retry once" is what brings it through.
//
// A "ran" call appends one line to a counter file, so every claim below is a
// count, not a reading of prose.
//
//   cd src-tauri && cargo build --bin octiq-server && cd ..
//   (cd web && npx vite build --outDir <dir>/v2) && cp src-tauri/target/debug/octiq-server <dir>/
//   PLAYWRIGHT_MODULE=… node scripts/test-outage-recovery-live.mjs <dir>/octiq-server
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SERVER = process.argv[2] || path.join(ROOT, "src-tauri/target/debug/octiq-server");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-outage-recovery-"));
const SHOTS = process.env.OCTIQ_EVIDENCE_DIR || path.join(DIR, "shots");
const HOME = path.join(DIR, "home");
const BIN = path.join(DIR, "bin");
const LOG = path.join(DIR, "stub.log");
const COUNTER = path.join(DIR, "ran.txt");
const PORT = 15000 + Math.floor(Math.random() * 1000);
const TOKEN = "outage-recovery-token";
fs.mkdirSync(SHOTS, { recursive: true });

function stubClaude() {
  const fs = require("fs");
  const path = require("path");
  const readline = require("readline");
  const log = (entry) => fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ at: Date.now(), pid: process.pid, ...entry }) + "\n");
  const argv = process.argv.slice(2);
  log({ argv, cwd: process.cwd() });
  const resumed = argv.indexOf("--resume");
  const session = resumed >= 0 ? argv[resumed + 1] : "stub-" + process.pid;
  const out = (event) => process.stdout.write(JSON.stringify({ session_id: session, ...event }) + "\n");
  out({ type: "system", subtype: "init", model: "stub", tools: [] });
  const MESSAGE = (tool) => `The server-side auto mode classifier gave no verdict (error), so auto mode cannot determine the safety of ${tool}. This is a transient failure of the check, not a judgment about the action: a later response may get a verdict. You may try the action again once, as-is.`;
  // The allow rules Claude would read right now.
  const allowRules = () => {
    const files = [
      path.join(process.cwd(), ".claude", "settings.local.json"),
      path.join(process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, ".claude"), "settings.json"),
    ];
    return files.flatMap((file) => {
      try { return JSON.parse(fs.readFileSync(file, "utf8")).permissions?.allow ?? []; } catch { return []; }
    });
  };
  const covered = (tool, command) => allowRules().some((rule) => {
    if (rule === tool && tool !== "Bash") return true;
    const prefix = /^Bash\((.*):\*\)$/.exec(rule);
    return tool === "Bash" && prefix && (command === prefix[1] || command.startsWith(prefix[1] + " "));
  });
  const seen = new Set();
  // Down for good: until a rule covers the call. Transient: only the first try.
  const classifierDown = (tool, command) => {
    if (tool !== "Bash" || command.startsWith("git push")) return true;
    const first = !seen.has(command);
    seen.add(command);
    return first;
  };
  let n = 0;
  const call = (tool, input) => {
    const id = "toolu_" + process.pid + "_" + ++n;
    const command = input.command ?? "";
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: tool, input }] } });
    const rule = covered(tool, command);
    if (rule || !classifierDown(tool, command)) {
      fs.appendFileSync(process.env.STUB_COUNTER, `${tool} ${command}\n`);
      log({ ran: id, tool, command, byRule: rule });
      out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
    } else {
      log({ refused: id, tool, command });
      out({ type: "system", subtype: "permission_denied", tool_name: tool, tool_use_id: id, decision_reason: "Classifier unavailable",
        decision_reason_type: "classifier", message: MESSAGE(tool) });
      out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: MESSAGE(tool) }] } });
    }
  };
  const CALLS = {
    PUSH: ["Bash", { command: "git push origin main" }],
    UPLOAD: ["mcp__claude_ai_Higgfield__media_upload", { path: "hero.png" }],
    COUNT: ["Bash", { command: "ls | wc -l" }],
  };
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === "control_request" && msg.request?.subtype === "initialize") {
      out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: {} } });
      return;
    }
    if (msg.type !== "user") return;
    const text = JSON.stringify(msg.message?.content ?? "");
    log({ userText: text.slice(0, 3000) });
    // A fresh ask names the call by keyword; the card's retry turn names it
    // by the exact line in backticks.
    for (const [word, [tool, input]] of Object.entries(CALLS)) {
      const line = input.command ?? tool;
      if (text.includes(word) || text.includes("`" + line + "`")) call(tool, input);
    }
    const said = "done";
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: said }] } });
    out({ type: "result", subtype: "success", is_error: false, result: said, duration_ms: 1, num_turns: 1 });
  });
}

fs.mkdirSync(BIN, { recursive: true });
const STUB = path.join(BIN, "claude");
fs.writeFileSync(STUB, `#!/usr/bin/env node\n(${stubClaude.toString()})();\n`, { mode: 0o755 });
const repo = path.join(HOME, "code", "alpha");
fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# alpha\n");
execFileSync("git", ["init", "-q", "-b", "develop"], { cwd: repo });
// Existing project settings the write must keep, in their order.
const PROJECT_SETTINGS = path.join(repo, ".claude", "settings.local.json");
const SHARED_SETTINGS = path.join(repo, ".claude", "settings.json");
// The host names the person's own file by its canonical path (on macOS the
// temp folder is /var → /private/var).
const USER_SETTINGS = path.join(fs.realpathSync(HOME), ".claude", "settings.json");
fs.writeFileSync(PROJECT_SETTINGS, '{\n  "env": { "ALPHA": "1" },\n  "permissions": { "deny": ["Bash(rm:*)"] }\n}\n');
fs.writeFileSync(SHARED_SETTINGS, '{ "model": "sonnet" }\n');

const ENV = { ...process.env, HOME, SHELL: "/bin/zsh", OCTIQ_WEB_PORT: String(PORT), OCTIQ_WEB_TOKEN: TOKEN,
  OCTIQ_CHAT_IDLE_MINS: "0", PATH: `${BIN}:${process.env.PATH}`, STUB_LOG: LOG, STUB_COUNTER: COUNTER };
delete ENV.CLAUDE_CONFIG_DIR;

const ran = () => fs.existsSync(COUNTER) ? fs.readFileSync(COUNTER, "utf8").trim().split("\n").filter(Boolean) : [];
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

let server;
let serverLog = "";
const events = [];
let ws;
let seq = 0;
const replies = new Map();
const invoke = (cmd, args = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  replies.set(id, { resolve, reject });
  ws.send(JSON.stringify({ t: "invoke", id, cmd, args }));
});
async function connect() {
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
}

const results = {};
let browser;
try {
  server = spawn(SERVER, [], { env: ENV, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => { serverLog += d; });
  server.stderr.on("data", (d) => { serverLog += d; });
  await connect();
  const project = await invoke("add_workspace", { name: "Alpha", primaryPath: repo });
  const chatId = "recovery";
  const key = `chat:${chatId}`;
  await invoke("chat_index_save", { meta: { id: chatId, projectId: project.id, title: "Recovery", customTitle: true, cwd: repo,
    modelId: "claude:sonnet", access: "auto", createdAt: Date.now(), updatedAt: Date.now(), generation: 0 } });
  const cards = () => events.filter((e) => e.event === "safety-blocked" && e.payload.chatKey === key);
  const userTexts = () => stub().filter((e) => e.userText).map((e) => e.userText);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  await context.addInitScript(() => {
    if (location.protocol === "about:") return;
    localStorage.setItem("octiq.v2.gitColumn", "0");
  });
  const page = await context.newPage();
  // Fault injection for the review findings on 5bf9f85 and 2f71bc6: while
  // `failNextSend` is set, the page's next `chat_send` still REACHES the
  // server, but with an argument the host refuses after the call has arrived
  // (`to`, which chat_send_with_user_turn rejects) — a send the host did not
  // take. Before 2f71bc6's follow-up the host had already superseded the card
  // by then. Every other frame passes through untouched; the page's own
  // commands are counted.
  let failNextSend = false;
  const injected = [];
  const pageCmds = [];
  await page.routeWebSocket(/\/ws/, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      let frame;
      try { frame = JSON.parse(message); } catch { server.send(message); return; }
      if (frame.t === "invoke") pageCmds.push({ cmd: frame.cmd, safetyBlock: frame.args?.safetyBlock });
      if (failNextSend && frame.t === "invoke" && frame.cmd === "chat_send") {
        failNextSend = false;
        injected.push({ text: frame.args?.text?.slice(0, 80), safetyBlock: frame.args?.safetyBlock });
        server.send(JSON.stringify({ ...frame, args: { ...frame.args, to: "injected-refusal" } }));
        return;
      }
      server.send(message);
    });
  });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error.stack ?? error)));
  page.setDefaultTimeout(30_000);
  await page.goto(`http://127.0.0.1:${PORT}/?token=${TOKEN}#/c/${chatId}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  const card = page.locator(".safety-card.is-outage");

  // 1. git push is refused: the card names the rule and both files.
  await invoke("chat_start", { key, cwd: repo, agent: "claude", model: "sonnet", access: "auto", useSandbox: false, prompt: "PUSH", turnId: "user-1" });
  const pushCard = await wait("push card", async () => cards().at(-1));
  results.pushCard = {
    command: pushCard.payload.commands?.[0],
    allow: pushCard.payload.allow,
    ranBefore: ran().length,
  };
  assert.equal(ran().length, 0, "the refused push did not run");
  assert.equal(pushCard.payload.commands[0].rule, "Bash(git push:*)");
  assert.equal(pushCard.payload.commands[0].words, "git push");
  assert.equal(pushCard.payload.allow.project, PROJECT_SETTINGS);
  assert.equal(pushCard.payload.allow.user, USER_SETTINGS);
  await card.waitFor();
  const text = await card.innerText();
  results.pushCard.buttons = await card.locator("button").allInnerTexts();
  assert.deepEqual(results.pushCard.buttons, ["Retry once", "Always allow in this project", "Always allow everywhere", "Technical details", "Dismiss"]);
  assert.match(text, /Always allow adds Bash\(git push:\*\) to Claude's settings/);
  assert.doesNotMatch(text, /gave no verdict/, "the harness notice starts collapsed");
  await card.screenshot({ path: path.join(SHOTS, "1-push-card.png") });
  await card.getByRole("button", { name: "Technical details" }).click();
  const open = await card.innerText();
  assert.match(open, /gave no verdict \(error\), so auto mode cannot determine the safety of Bash/);
  assert(open.includes(`This project: ${PROJECT_SETTINGS}`));
  await card.screenshot({ path: path.join(SHOTS, "2-push-card-details.png") });
  // A phone: all five choices fit, with no sideways scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  await card.scrollIntoViewIfNeeded();
  results.pushCard.phone = {
    noSideScroll: await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    width: (await card.boundingBox())?.width,
  };
  assert.equal(results.pushCard.phone.noSideScroll, true);
  assert(results.pushCard.phone.width <= 390);
  await card.screenshot({ path: path.join(SHOTS, "2b-push-card-phone.png") });
  await page.setViewportSize({ width: 1280, height: 900 });

  // 2. "Always allow in this project": the rule lands in settings.local.json,
  //    the shared file is untouched, and the retry turn runs the push.
  //
  //    First, the send of the retry turn fails after the rule is written.
  //    The card must stay up and undecided — before the fix it came down,
  //    and the host recorded "allowed_project", with the agent never asked to
  //    retry. A reload brings it back saying the rule is already written.
  const sharedBefore = fs.readFileSync(SHARED_SETTINGS, "utf8");
  failNextSend = true;
  await card.getByRole("button", { name: "Always allow in this project" }).click();
  await card.locator(".safety-card-error").waitFor();
  results.sendFailure = {
    injected: injected.length,
    error: await card.locator(".safety-card-error").innerText(),
    ruleWritten: JSON.parse(fs.readFileSync(PROJECT_SETTINGS, "utf8")).permissions.allow,
    pushRan: ran().includes("Bash git push origin main"),
    decided: events.some((e) => e.event === "safety-block-expired" && e.payload.id === pushCard.payload.id),
    stillPending: (await invoke("safety_block_pending")).some((b) => b.id === pushCard.payload.id),
  };
  assert.equal(results.sendFailure.injected, 1, "the retry turn's send was the one that failed");
  assert.equal(injected[0].safetyBlock, pushCard.payload.id, "the retry turn names its card");
  assert.match(results.sendFailure.error, /retry could not be sent/);
  assert.deepEqual(results.sendFailure.ruleWritten, ["Bash(git push:*)"]);
  assert.equal(results.sendFailure.pushRan, false, "no retry reached the agent");
  assert.equal(results.sendFailure.decided, false, "the card was not decided");
  assert.equal(results.sendFailure.stillPending, true, "the host keeps the card");
  await card.screenshot({ path: path.join(SHOTS, "2c-send-failed-card-stays.png") });
  await page.reload({ waitUntil: "domcontentloaded" });
  await card.waitFor();
  results.sendFailure.afterReload = await card.innerText();
  assert.match(results.sendFailure.afterReload, /allow rule is already in this project's settings/);
  await card.screenshot({ path: path.join(SHOTS, "2d-after-reload-rule-written.png") });
  // Answered again: the rule is only "present", and now the retry goes.
  await card.getByRole("button", { name: "Always allow in this project" }).click();
  await wait("push ran on retry", async () => ran().some((line) => line === "Bash git push origin main"));
  const written = fs.readFileSync(PROJECT_SETTINGS, "utf8");
  results.project = {
    written,
    retryTurn: userTexts().find((t) => t.includes("I added the Claude permission allow rule")),
    ran: ran(),
    sharedUntouched: fs.readFileSync(SHARED_SETTINGS, "utf8") === sharedBefore,
    userFileExists: fs.existsSync(USER_SETTINGS),
  };
  const parsed = JSON.parse(written);
  assert.deepEqual(Object.keys(parsed), ["env", "permissions"], "key order kept");
  assert.deepEqual(parsed.permissions, { deny: ["Bash(rm:*)"], allow: ["Bash(git push:*)"] });
  assert.equal(parsed.env.ALPHA, "1");
  assert(results.project.retryTurn?.includes("`git push origin main`"), "the retry names the exact call");
  assert.equal(results.project.sharedUntouched, true, "never the shared settings.json");
  assert.equal(results.project.userFileExists, false, "project scope does not touch user settings");
  await wait("card gone", async () => (await card.count()) === 0);
  const decided = events.filter((e) => e.event === "safety-block-expired" && e.payload.id === pushCard.payload.id);
  assert.equal(decided.length, 1);
  results.project.decision = decided[0].payload.decision;
  assert.equal(results.project.decision, "allowed_project", "recorded as the allow, not superseded");
  // A later push in the same live process runs by the rule, with no card.
  const cardsBefore = cards().length;
  await invoke("chat_send", { key, text: "PUSH", turnId: "user-3" });
  await wait("second push ran", async () => ran().filter((l) => l === "Bash git push origin main").length === 2);
  results.project.laterPushNoCard = cards().length === cardsBefore;
  assert.equal(results.project.laterPushNoCard, true);

  // 3. The MCP upload: "Always allow everywhere" writes the exact tool name
  //    to the user's own settings.json.
  await invoke("chat_send", { key, text: "UPLOAD", turnId: "user-4" });
  const uploadCard = await wait("upload card", async () => cards().find((c) => c.payload.commands?.[0]?.tool?.startsWith("mcp__")));
  assert.equal(uploadCard.payload.commands[0].rule, "mcp__claude_ai_Higgfield__media_upload");
  await card.waitFor();
  await card.screenshot({ path: path.join(SHOTS, "3-mcp-card.png") });
  await card.getByRole("button", { name: "Always allow everywhere" }).click();
  await wait("upload ran on retry", async () => ran().some((line) => line.startsWith("mcp__claude_ai_Higgfield__media_upload")));
  results.user = { written: JSON.parse(fs.readFileSync(USER_SETTINGS, "utf8")), ran: ran() };
  assert.deepEqual(results.user.written, { permissions: { allow: ["mcp__claude_ai_Higgfield__media_upload"] } });
  assert.deepEqual(JSON.parse(fs.readFileSync(PROJECT_SETTINGS, "utf8")).permissions.allow, ["Bash(git push:*)"], "project file unchanged by user scope");
  const expiredAs = (id) => wait(`decision for ${id}`, async () =>
    events.find((e) => e.event === "safety-block-expired" && e.payload.id === id)?.payload.decision);
  results.user.decision = await expiredAs(uploadCard.payload.id);
  assert.equal(results.user.decision, "allowed_user");

  // 4. A piped line has no narrow rule: Retry once only, and the retry runs
  //    it once the (transient) outage has passed. Nothing is written.
  const beforeFiles = [PROJECT_SETTINGS, USER_SETTINGS].map((f) => fs.readFileSync(f, "utf8"));
  await wait("card gone", async () => (await card.count()) === 0);
  await invoke("chat_send", { key, text: "COUNT", turnId: "user-6" });
  const countCard = await wait("count card", async () => cards().find((c) => c.payload.commands?.[0]?.action === "ls | wc -l"));
  assert.equal(countCard.payload.commands[0].rule, undefined, "no rule for a piped line");
  await card.waitFor();
  results.retry = { buttons: await card.locator("button").allInnerTexts() };
  assert.deepEqual(results.retry.buttons, ["Retry once", "Technical details", "Dismiss"]);
  await card.screenshot({ path: path.join(SHOTS, "4-retry-only-card.png") });
  await card.getByRole("button", { name: "Retry once" }).click();
  await wait("count ran on retry", async () => ran().some((line) => line === "Bash ls | wc -l"));
  results.retry.turn = userTexts().find((t) => t.includes("Retry it once") && t.includes("ls | wc -l"));
  results.retry.filesUnchanged = [PROJECT_SETTINGS, USER_SETTINGS].every((f, i) => fs.readFileSync(f, "utf8") === beforeFiles[i]);
  assert(results.retry.turn, "the retry turn reached the agent");
  assert.equal(results.retry.filesUnchanged, true, "Retry once writes nothing");
  results.retry.decision = await expiredAs(countCard.payload.id);
  assert.equal(results.retry.decision, "retried");
  // The page closes no card itself: each retry turn named its card, and the
  // host closed it in the call that took the turn.
  results.retryTurnsNamed = pageCmds.filter((c) => c.safetyBlock).map((c) => c.cmd);
  assert.equal(pageCmds.filter((c) => c.cmd === "safety_block_retry").length, 0);
  assert.equal(results.retryTurnsNamed.length, 4, "failed push retry, push retry, upload retry, count retry");

  // 5. Only clicks wrote anything: three allow/retry calls, one rule each.
  results.stubLaunches = stub().filter((e) => e.argv).length;
  assert.equal(results.stubLaunches, 1, "one live process throughout: the rule was picked up without a restart");

  // 6. Review finding (5bf9f85): a project whose CLAUDE_CONFIG_DIR is its own
  //    .claude folder (absolute, or relative to the launch folder) must never
  //    get "Always allow everywhere": that settings.json is the SHARED file.
  results.sharedConfigDir = {};
  for (const [label, dir] of [["absolute", path.join(repo, ".claude")], ["relative", ".claude"]]) {
    const id = `shared-config-${label}`;
    const sharedKey = `chat:${id}`;
    await invoke("chat_index_save", { meta: { id, projectId: project.id, title: `Shared config ${label}`, customTitle: true, cwd: repo,
      modelId: "claude:sonnet", access: "auto", createdAt: Date.now(), updatedAt: Date.now(), generation: 0 } });
    await invoke("chat_start", { key: sharedKey, cwd: repo, agent: "claude", model: "sonnet", access: "auto", useSandbox: false,
      // The upload: the push is allowed in this project by now (step 2), and
      // with the config dir moved, no settings file this chat reads allows it.
      env: { CLAUDE_CONFIG_DIR: dir }, prompt: "UPLOAD", turnId: `user-${label}` });
    const shared = await wait(`${label} card`, async () =>
      events.filter((e) => e.event === "safety-blocked" && e.payload.chatKey === sharedKey).at(-1));
    results.sharedConfigDir[label] = { allow: shared.payload.allow };
    assert.equal(shared.payload.allow.project, PROJECT_SETTINGS, "this project stays offered");
    assert.equal(shared.payload.allow.user, undefined, "everywhere is not offered");
    await assert.rejects(invoke("safety_block_allow_rule", { id: shared.payload.id, scope: "user" }), /not your own/);
    if (label === "absolute") {
      await page.goto("about:blank");
      await page.goto(`http://127.0.0.1:${PORT}/?token=${TOKEN}#/c/${id}`, { waitUntil: "domcontentloaded" });
      await card.waitFor();
      results.sharedConfigDir[label].buttons = await card.locator("button").allInnerTexts();
      assert.deepEqual(results.sharedConfigDir[label].buttons, ["Retry once", "Always allow in this project", "Technical details", "Dismiss"]);
      await card.screenshot({ path: path.join(SHOTS, "5-shared-config-dir-card.png") });
    }
  }
  assert.equal(fs.readFileSync(SHARED_SETTINGS, "utf8"), sharedBefore, "the shared settings.json was never written");
  assert.deepEqual(pageErrors, []);
  results.passed = true;
  results.evidence = "stub claude (no model, no real classifier); real debug octiq-server; real client in headless Chromium";
  results.shots = SHOTS;
} catch (error) {
  results.error = String(error.stack || error);
  results.serverLog = serverLog.split("\n").filter((l) => /perm|safety|chat:|error/i.test(l)).slice(-40);
  results.stub = stub().slice(-20);
  process.exitCode = 1;
} finally {
  console.log(JSON.stringify(results, null, 2));
  await browser?.close();
  ws?.close();
  server?.kill("SIGTERM");
  if (!results.passed) console.log(`kept ${DIR}`);
}
