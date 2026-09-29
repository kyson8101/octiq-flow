// Live check: an agent's memory write is shown in its chat by the host, from
// the vault's receipt — saved, failed or unconfirmed — once per write, across
// reloads and a server restart; a worker's coordinator sees that it happened
// and a link to the worker chat, not the words. An undated entry takes the
// server's LOCAL date — the server runs in a zone whose date differs from the
// UTC date at the time of the run (Kiritimati, UTC+14, or Pago Pago, UTC-11;
// one of them always does) — and its receipt keeps that date. A
// save whose activity a crash lost is recovered by a next-day retry without a
// date, from a receipt that kept none; different words under its requestId are
// a refused line beside the saved one, never "not updated". A line lost from
// a transcript — worker's and coordinator's — or never confirmed is written
// back once by the restart itself, with no retry; and past the ledger's KEEP
// the transcripts still dedupe.
//
// Evidence class: STUB PROVIDER, REAL SERVER, REAL BROWSER, DISPOSABLE VAULT.
// This checkout's octiq-server runs under a throwaway HOME with a stand-in
// `claude` first on PATH. Every chat is a real chat process the server
// launched and handed a capability; the stand-in writes that capability into
// this run's scratch folder, and this script calls /hook/vault AS that chat,
// exactly as its MCP would. The vault is a temporary folder: nothing here
// reads or writes the person's own profile, vault or memory.
//
//   (cd src-tauri && cargo build --bin octiq-server)
//   (cd web && ./node_modules/.bin/vite build --outDir <srv>/v2 --emptyOutDir)
//   cp src-tauri/target/debug/octiq-server <srv>/octiq-server
//   OUT=<evidence dir> PLAYWRIGHT_MODULE=<playwright/index.mjs> \
//     node scripts/test-memory-activity-live.mjs <srv>/octiq-server
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const SERVER = process.argv[2];
if (!SERVER) throw new Error("Pass the octiq-server to run, placed beside a v2/ client build.");
const OUT = process.env.OUT || fs.mkdtempSync(path.join(os.tmpdir(), "octiq-memory-evidence-"));
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-memory-live-"));
const HOME = path.join(DIR, "home");
const BIN = path.join(DIR, "bin");
const CAPS = path.join(DIR, "caps");
const VAULT = path.join(DIR, "vault");
const LOG = path.join(DIR, "stub.log");
const PORT = 17000 + Math.floor(Math.random() * 1000);
const TOKEN = "memory-live-token";
for (const dir of [OUT, CAPS, VAULT, BIN]) fs.mkdirSync(dir, { recursive: true });

// The stand-in for `claude -p --input-format stream-json`.
function stubClaude() {
  const fs = require("fs");
  const path = require("path");
  const readline = require("readline");
  const env = process.env;
  const key = env.OCTIQ_CHAT_KEY || "unknown";
  const log = (entry) => fs.appendFileSync(env.STUB_LOG, JSON.stringify({ at: Date.now(), key, ...entry }) + "\n");
  fs.writeFileSync(path.join(env.STUB_CAPS, encodeURIComponent(key)), JSON.stringify({
    capability: env.OCTIQ_CHAT_CAPABILITY || "", sessionKey: env.OCTIQ_SESSION_KEY || key,
  }));
  log({ launch: true });
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
    // A reply that CLAIMS a memory update: it must draw nothing by itself.
    const said = "Working on it. I have noted this in my memory.";
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: said }] } });
    out({ type: "result", subtype: "success", is_error: false, result: said, duration_ms: 1, num_turns: 1 });
  });
}
fs.writeFileSync(path.join(BIN, "claude"), `#!/usr/bin/env node\n(${stubClaude.toString()})();\n`, { mode: 0o755 });

const repo = path.join(HOME, "code", "fixture");
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n");
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
git("init", "-q", "-b", "develop");
git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "add", "README.md");
git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "-m", "fixture");

const dateIn = (zone, at = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(at);
const ZONE = ["Pacific/Kiritimati", "Pacific/Pago_Pago"].find((zone) => dateIn(zone) !== dateIn("UTC"));
const ENV = { ...process.env, HOME, SHELL: "/bin/zsh", OCTIQ_WEB_PORT: String(PORT), OCTIQ_WEB_TOKEN: TOKEN,
  OCTIQ_CHAT_IDLE_MINS: "0", PATH: `${BIN}:${process.env.PATH}`, STUB_LOG: LOG, STUB_CAPS: CAPS, TZ: ZONE };
for (const name of ["OCTIQ_CHAT_KEY", "OCTIQ_SESSION_KEY", "OCTIQ_LAUNCH_ID", "OCTIQ_CHAT_CAPABILITY", "OCTIQ_HOOK_PORT", "OCTIQ_ROOT"]) {
  delete ENV[name];
}

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
let server;
const startServer = async () => {
  server = spawn(SERVER, [], { env: ENV, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => { serverLog += d; });
  server.stderr.on("data", (d) => { serverLog += d; });
  await wait("server", async () => {
    try { return (await fetch(`http://127.0.0.1:${PORT}/`)).status > 0; } catch { return false; }
  });
};
const stopServer = async () => {
  if (!server) return;
  const gone = new Promise((r) => server.once("exit", r));
  server.kill("SIGTERM");
  await gone;
  server = null;
};
process.on("exit", () => server?.kill());

let ws;
let seq = 0;
const replies = new Map();
const connect = async () => {
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
};
const invoke = (cmd, args = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  replies.set(id, { resolve, reject });
  ws.send(JSON.stringify({ t: "invoke", id, cmd, args }));
});
/** A memory call as `as`'s own MCP makes it: its capability in the header. */
const memory = async (as, action, args, claim = as) => {
  const cap = capOf(as);
  const body = { chatKey: claim, action, args };
  if (claim !== as) body.sessionKey = cap.sessionKey;
  const response = await fetch(`http://127.0.0.1:${PORT}/hook/vault`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-octiq-chat-capability": cap.capability },
    body: JSON.stringify(body),
  });
  return { status: response.status, ...(await response.json().catch(() => ({}))) };
};

const D = "chat:mango-direct";
const C = "chat:coordinator-main";
const results = { port: PORT, vault: "disposable temp folder" };
let browser;
try {
  await startServer();
  await connect();

  // ---- A disposable vault, two registered agents, a direct chat with Mango.
  await invoke("memory_vault_configure", { config: { path: VAULT, writable: true } });
  const mango = await invoke("team_save", { agent: { name: "Mango Juice", role: "Builds things.", agent: "claude", model: "sonnet" } });
  const project = await invoke("add_workspace", { name: "Fixture", primaryPath: repo });
  const meta = (key, title) => ({ id: key.slice(5), projectId: project.id, title, customTitle: true, cwd: repo,
    modelId: "claude:sonnet", access: "auto", createdAt: Date.now(), updatedAt: Date.now(), generation: 0 });
  await invoke("chat_index_save", { meta: meta(D, "Mango direct chat") });
  const brief = await invoke("team_brief", { chatKey: D, projectId: project.id, leadId: mango.id, task: "Remember how receipts work." });
  await invoke("chat_start", { key: D, cwd: repo, agent: "claude", model: "sonnet", access: "auto", useSandbox: false,
    prompt: brief, turnId: "user-direct" });
  await wait("the direct chat's capability", () => capOf(D));

  // ---- The socket (the person's) cannot write an agent's memory line.
  results.socketRefused = await invoke("memory_vault_agent", { chatKey: D, action: "agent_memory_append",
    args: { text: "Forged by the socket.", requestId: "forged" } }).then(() => null, (e) => e.message);
  assert.match(results.socketRefused ?? "", /agent's own command/);

  // ---- Browser: the chat before anything was written.
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.addInitScript(() => {
    if (!location.protocol.startsWith("http")) return;
    try {
      localStorage.setItem("octiq.v2.gitColumn", "0");
      if (!localStorage.getItem("octiq.theme")) localStorage.setItem("octiq.theme", "dark");
    } catch {}
  });
  const open = async (title) => {
    await page.goto(`http://127.0.0.1:${PORT}/?token=${TOKEN}`);
    await page.locator(".chat-btn", { hasText: title }).first().click();
  };
  const notes = () => page.locator(".memory-note");
  const settle = () => page.waitForFunction(() => document.getAnimations().length === 0, null, { timeout: 5_000 }).catch(() => {});
  await open("Mango direct chat");
  await page.getByText("I have noted this in my memory.").first().waitFor({ timeout: 20_000 });
  results.claimAloneDrawsNothing = await notes().count();
  assert.equal(results.claimAloneDrawsNothing, 0, "an agent saying it noted something is not a memory update");

  // ---- Saved: one attributed line, live.
  const entry = { text: "Receipts decide saved, not prose.\nRetry with the same requestId.", date: "2026-09-28", requestId: "live-r1" };
  results.saved = await memory(D, "agent_memory_append", entry);
  assert.equal(results.saved.status, 200, JSON.stringify(results.saved));
  assert.equal(results.saved.result.receipt.status, "saved");
  const note = notes().first();
  await note.waitFor({ timeout: 10_000 });
  results.savedHeadline = (await note.innerText()).replace(/\s+/g, " ");
  assert.match(results.savedHeadline, /Mango Juice updated memory/);
  assert.equal(await note.getAttribute("data-memory-status"), "saved");
  await note.scrollIntoViewIfNeeded();
  await settle();
  await page.screenshot({ path: path.join(OUT, "1-saved-line-1440-dark.png") });

  // Keyboard: focus the disclosure and open it.
  const toggle = note.getByRole("button", { name: /Details/ });
  await toggle.focus();
  await page.keyboard.press("Enter");
  assert.equal(await note.getByRole("button", { name: /Hide/ }).getAttribute("aria-expanded"), "true");
  const shown = await note.locator(".memory-note-details").innerText();
  results.details = shown;
  assert.match(shown, /Receipts decide saved, not prose\.\nRetry with the same requestId\./);
  assert.match(shown, /agent-zone\/agents\/mango-juice\/memory\.md/);
  assert.ok(!shown.includes(VAULT) && !shown.includes(fs.realpathSync(VAULT)), "no host path");
  await settle();
  await page.screenshot({ path: path.join(OUT, "2-saved-details-focused-1440-dark.png") });

  // ---- The same write again, twice: one note in the vault, one line.
  results.retry = await memory(D, "agent_memory_append", entry);
  results.retry2 = await memory(D, "agent_memory_append", entry);
  assert.equal(results.retry.result.alreadySaved, true);
  const noteFile = fs.readFileSync(path.join(VAULT, "agent-zone/agents/mango-juice/memory.md"), "utf8");
  results.entriesInNote = noteFile.split("Receipts decide saved, not prose.").length - 1;
  assert.equal(results.entriesInNote, 1);
  await page.waitForTimeout(500);
  assert.equal(await notes().count(), 1);

  // ---- Reading memory draws nothing.
  results.read = (await memory(D, "agent_memory_read", {})).status;
  await page.waitForTimeout(300);
  assert.equal(await notes().count(), 1);

  // ---- Reload: still exactly one line, replayed from the transcript.
  await open("Mango direct chat");
  await notes().first().waitFor({ timeout: 10_000 });
  results.afterReload = await notes().count();
  assert.equal(results.afterReload, 1);

  // ---- Refused: vault writes off. A failed line, never a saved one.
  await invoke("memory_vault_configure", { config: { path: VAULT, writable: false } });
  results.failed = await memory(D, "agent_memory_append", { text: "Written while writes are off.", date: "2026-09-28", requestId: "live-r2" });
  assert.equal(results.failed.status, 400);
  await invoke("memory_vault_configure", { config: { path: VAULT, writable: true } });
  const failed = page.locator('.memory-note[data-memory-status="failed"]');
  await failed.waitFor({ timeout: 10_000 });
  results.failedHeadline = (await failed.innerText()).replace(/\s+/g, " ");
  assert.match(results.failedHeadline, /Mango Juice's memory was not updated/);
  assert.doesNotMatch(results.failedHeadline, /updated memory/);
  await failed.getByRole("button", { name: /Details/ }).click();
  await failed.scrollIntoViewIfNeeded();
  await settle();
  await page.screenshot({ path: path.join(OUT, "3-failed-line-1440-dark.png") });

  // ---- Unconfirmed: the note's folder refuses the write after its receipt.
  const folder = path.join(VAULT, "agent-zone/agents/mango-juice");
  fs.chmodSync(folder, 0o555);
  results.uncertain = await memory(D, "agent_memory_append", { text: "Maybe written.", date: "2026-09-28", requestId: "live-r3" });
  fs.chmodSync(folder, 0o755);
  assert.equal(results.uncertain.status, 400);
  const unsure = page.locator('.memory-note[data-memory-status="uncertain"]');
  await unsure.waitFor({ timeout: 10_000 });
  results.uncertainHeadline = (await unsure.innerText()).replace(/\s+/g, " ");
  assert.match(results.uncertainHeadline, /memory update is unconfirmed/);
  await unsure.scrollIntoViewIfNeeded();
  await settle();
  await page.screenshot({ path: path.join(OUT, "4-uncertain-line-1440-dark.png") });

  // ---- Another chat cannot draw into this one.
  await invoke("chat_index_save", { meta: meta(C, "Coordinator main chat") });
  await invoke("chat_start", { key: C, cwd: repo, agent: "claude", model: "sonnet", access: "auto", useSandbox: false,
    prompt: "Coordinate.", turnId: "user-coordinator" });
  await wait("the coordinator's capability", () => capOf(C));
  results.spoof = await memory(C, "agent_memory_append", { text: "Spoofed.", requestId: "spoof" }, D);
  assert.equal(results.spoof.status, 403);

  // ---- A worker of the coordinator's run, assigned to Mango.
  const run = await invoke("orchestration_run_create", { actorChatKey: C, objective: "Show memory updates",
    workspaceId: project.id, rootPath: repo, maxConcurrent: 1 });
  const task = await invoke("orchestration_task_create", { actorChatKey: C, runId: run.id, dependsOn: [],
    title: "Record what was learned", spec: "Save one memory entry.", assignee: "Mango Juice" });
  assert.equal(task.assignee?.name, "Mango Juice");
  await invoke("orchestration_worker_start", { actorChatKey: C, taskId: task.id, agent: "claude", model: "sonnet",
    access: "auto", newWorktree: true });
  const attempt = await wait("the worker", async () => {
    const found = (await invoke("orchestration_snapshot", { runId: run.id })).attempts.find((a) => a.taskId === task.id);
    return found?.workerChatKey && capOf(found.workerChatKey) ? found : null;
  }, 60_000);
  const W = attempt.workerChatKey;
  results.worker = W;
  results.workerSaved = await memory(W, "agent_memory_append", { text: "Workers report memory through the host.", date: "2026-09-28", requestId: "live-w1" });
  assert.equal(results.workerSaved.status, 200, JSON.stringify(results.workerSaved));
  await memory(W, "agent_memory_append", { text: "Workers report memory through the host.", date: "2026-09-28", requestId: "live-w1" });
  // No date: the server's local date, kept on the receipt.
  const localBefore = dateIn(ZONE);
  const utcBefore = dateIn("UTC");
  results.localDate = await memory(W, "agent_memory_append", { text: "Dated by the host's local clock.", requestId: "live-w2" });
  const localAfter = dateIn(ZONE);
  const utcAfter = dateIn("UTC");
  assert.equal(results.localDate.status, 200, JSON.stringify(results.localDate));
  results.localDate = { zone: ZONE, utc: utcAfter, local: localAfter,
    entryDate: results.localDate.result.receipt.entryDate, receipt: results.localDate.result.receipt.id };
  assert.ok([localBefore, localAfter].includes(results.localDate.entryDate), JSON.stringify(results.localDate));
  // The UTC date would have been wrong here: that is what makes this a check.
  assert.ok(![utcBefore, utcAfter].includes(results.localDate.entryDate), JSON.stringify(results.localDate));

  await open("Coordinator main chat");
  const relayed = notes().first();
  await relayed.waitFor({ timeout: 10_000 });
  results.coordinatorLine = (await relayed.innerText()).replace(/\s+/g, " ");
  assert.match(results.coordinatorLine, /Mango Juice updated memory · Record what was learned/);
  assert.doesNotMatch(results.coordinatorLine, /Workers report memory through the host/);
  assert.equal(await notes().count(), 2);
  const link = relayed.getByRole("link", { name: "Open chat" });
  results.link = await link.getAttribute("href");
  assert.equal(results.link, `#/c/${W.slice(5)}`);
  await relayed.scrollIntoViewIfNeeded();
  await settle();
  await page.screenshot({ path: path.join(OUT, "5-coordinator-line-1440-dark.png") });
  await link.click();
  const workerNote = page.locator(".memory-note", { hasText: "Mango Juice updated memory" }).first();
  await workerNote.waitFor({ timeout: 10_000 });
  await workerNote.getByRole("button", { name: /Details/ }).click();
  results.workerDetails = await workerNote.locator(".memory-note-details").innerText();
  assert.match(results.workerDetails, /Workers report memory through the host\./);
  await workerNote.scrollIntoViewIfNeeded();
  await settle();
  await page.screenshot({ path: path.join(OUT, "6-worker-chat-from-link-1440-dark.png") });

  // ---- A server restart: the lines are still there, still one each.
  await stopServer();
  await startServer();
  await open("Mango direct chat");
  await notes().first().waitFor({ timeout: 20_000 });
  results.afterRestart = {
    direct: await notes().count(),
    statuses: await notes().evaluateAll((els) => els.map((e) => e.getAttribute("data-memory-status"))),
  };
  assert.deepEqual(results.afterRestart.statuses, ["saved", "failed", "uncertain"]);

  // A restarted server has no agent running for the chat, so its old
  // capability is refused: resume the chat, as the next message would.
  const revive = async (key) => {
    fs.rmSync(path.join(CAPS, encodeURIComponent(key)), { force: true });
    await connect();
    await invoke("chat_start", { key, cwd: repo, agent: "claude", model: "sonnet", access: "auto", useSandbox: false,
      prompt: "Carry on.", turnId: `user-revive-${Date.now()}` });
    await wait(`${key}'s capability`, () => capOf(key));
  };
  await revive(D);

  // ---- Saved, then the server died before any activity was recorded, and
  // the retry comes after midnight without a date. A raw write of the exact
  // append leaves exactly that: the note and its receipt, no activity.
  const MEMORY_NOTE = "agent-zone/agents/mango-juice/memory.md";
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const crossText = "Written before midnight, retried after it.";
  const before = await memory(D, "read", { path: MEMORY_NOTE, lineCount: 1 });
  assert.equal(before.status, 200, JSON.stringify(before));
  const raw = await memory(D, "write", { path: MEMORY_NOTE, mode: "append",
    content: `\n## ${yesterday}\n\n${crossText}\n`, expectedRevision: before.result.revision, requestId: "live-x1" });
  const retried = await memory(D, "agent_memory_append", { text: crossText, requestId: "live-x1" });
  const noteNow = fs.readFileSync(path.join(VAULT, MEMORY_NOTE), "utf8");
  results.crossDayCrashGap = {
    rawReceipt: raw.result?.status,
    retryStatus: retried.status,
    alreadySaved: retried.result?.alreadySaved,
    retryError: retried.error,
    entriesInNote: noteNow.split(crossText).length - 1,
  };
  assert.equal(raw.result?.status, "saved", JSON.stringify(raw));
  assert.equal(retried.status, 200, JSON.stringify(retried));
  assert.equal(retried.result.alreadySaved, true);
  assert.equal(results.crossDayCrashGap.entriesInNote, 1);
  const crossLine = page.locator(".memory-note", { hasText: "Mango Juice updated memory" }).last();
  await open("Mango direct chat");
  await wait("the recovered saved line", async () => (await notes().count()) === 4);
  results.crossDayCrashGap.statuses = await notes().evaluateAll((els) => els.map((e) => e.getAttribute("data-memory-status")));
  assert.deepEqual(results.crossDayCrashGap.statuses, ["saved", "failed", "uncertain", "saved"]);
  await crossLine.getByRole("button", { name: /Details/ }).click();
  results.crossDayCrashGap.details = await crossLine.locator(".memory-note-details").innerText();
  assert.match(results.crossDayCrashGap.details, new RegExp(`Dated\\s+${yesterday}`));
  // A different payload under the same id is refused, as its own line — and
  // that line says the earlier entry is saved, never "not updated".
  const other = await memory(D, "agent_memory_append", { text: "Different words.", requestId: "live-x1" });
  results.crossDayCrashGap.differentPayload = { status: other.status, error: other.error };
  assert.equal(other.status, 400);
  assert.match(other.error, /refused and wrote nothing/);
  assert.match(other.error, /earlier entry is saved/);
  const refusedNote = page.locator('.memory-note[data-memory-status="refused"]');
  await refusedNote.waitFor({ timeout: 10_000 });
  results.crossDayCrashGap.refusedLine = (await refusedNote.innerText()).replace(/\s+/g, " ");
  assert.match(results.crossDayCrashGap.refusedLine, /Mango Juice's repeated memory request was refused/);
  assert.match(results.crossDayCrashGap.refusedLine, /Earlier entry under this request is saved/);
  assert.doesNotMatch(results.crossDayCrashGap.refusedLine, /not updated/);
  await refusedNote.scrollIntoViewIfNeeded();
  await settle();
  await page.screenshot({ path: path.join(OUT, "4b-refused-beside-saved-1440-dark.png") });

  // ---- Durable delivery, checked on disk.
  const find = (dir, name) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = find(full, name);
        if (found) return found;
      } else if (entry.name === name) return full;
    }
    return null;
  };
  const transcriptOf = (key) => find(HOME, `${key.replace(":", "_")}.jsonl`);
  const memoryLines = (key) => fs.readFileSync(transcriptOf(key), "utf8").split("\n")
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((event) => event?.type === "octiq_memory_activity");
  const linesFor = (key, id) => memoryLines(key).filter((event) => event.id === id).map((event) => event.status);
  const dropLines = (key, id) => {
    const file = transcriptOf(key);
    const kept = fs.readFileSync(file, "utf8").split("\n").filter((line) => !line.includes(`"id":"${id}"`));
    fs.writeFileSync(file, kept.join("\n"));
  };
  const ledgerFile = find(HOME, "memory-activity.json");
  const readLedger = () => JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
  const crossId = retried.result.receipt.id;
  const workerId = results.workerSaved.result.receipt.id;
  const r1Id = results.saved.result.receipt.id;

  // The undated worker line, on disk, carries the local date.
  const localId = results.localDate.receipt;
  results.localDate.lineDate = memoryLines(W).find((e) => e.id === localId)?.date;
  assert.equal(results.localDate.lineDate, results.localDate.entryDate);

  // Lines the ledger confirmed, gone from their transcripts (the platter lost
  // an unsynced write, or a backup was restored) — in the direct chat, and a
  // worker's line in the coordinator chat — and a worker line whose intent a
  // crash left unconfirmed, never written.
  await stopServer();
  assert.equal(readLedger().entries[crossId].delivered[D], "saved");
  assert.equal(readLedger().entries[workerId].delivered[C], "saved");
  dropLines(D, crossId);
  dropLines(W, workerId);
  dropLines(C, workerId);
  const pendingLedger = readLedger();
  delete pendingLedger.entries[workerId].delivered[W];
  pendingLedger.entries[workerId].pending = { [W]: "saved" };
  fs.writeFileSync(ledgerFile, JSON.stringify(pendingLedger));
  results.durable = { before: { direct: linesFor(D, crossId), worker: linesFor(W, workerId), coordinator: linesFor(C, workerId) } };
  await startServer();
  // The restart itself writes all three back — nobody retried anything.
  await wait("the restored lines", async () =>
    linesFor(W, workerId).length === 1 && linesFor(C, workerId).length === 1 && linesFor(D, crossId).length === 1);
  const afterStart = readLedger();
  results.durable.afterRestart = { direct: linesFor(D, crossId), worker: linesFor(W, workerId), coordinator: linesFor(C, workerId),
    workerPending: afterStart.entries[workerId].pending, delivered: afterStart.entries[workerId].delivered };
  assert.deepEqual(results.durable.afterRestart.workerPending, {});
  assert.deepEqual(results.durable.afterRestart.delivered, { [W]: "saved", [C]: "saved" });
  // Present now: another restart and three retries add nothing.
  await stopServer();
  await startServer();
  await revive(D);
  for (let i = 0; i < 3; i++) {
    assert.equal((await memory(D, "agent_memory_append", { text: crossText, requestId: "live-x1" })).status, 200);
  }
  results.durable.afterSecondRestartAndRetries = { direct: linesFor(D, crossId), worker: linesFor(W, workerId), coordinator: linesFor(C, workerId) };
  assert.deepEqual(results.durable.afterSecondRestartAndRetries, { direct: ["saved"], worker: ["saved"], coordinator: ["saved"] });

  // ---- Past KEEP: the ledger forgets the oldest writes, the transcripts
  // still guard them, alone and under concurrent retries.
  await stopServer();
  const crowded = readLedger();
  const newer = Date.now() + 86_400_000;
  for (let i = 0; i < 5000; i++) {
    const id = `crowd-${String(i).padStart(5, "0")}`;
    crowded.entries[id] = { activity: { id, chatKey: "chat:crowd", requestId: id, status: "saved", agent: null,
      at: newer + i, note: null, date: null, text: null, receiptId: null, receiptStatus: null, error: null, owner: null },
      delivered: {}, pending: {} };
  }
  fs.writeFileSync(ledgerFile, JSON.stringify(crowded));
  await startServer();
  await revive(D);
  const r4 = await memory(D, "agent_memory_append", { text: "One more, to trim the ledger.", date: "2026-09-28", requestId: "live-r4" });
  assert.equal(r4.status, 200, JSON.stringify(r4));
  const trimmed = readLedger();
  results.keep = { entries: Object.keys(trimmed.entries).length, r1Remembered: r1Id in trimmed.entries };
  assert.equal(results.keep.entries, 5000);
  assert.equal(results.keep.r1Remembered, false);
  const concurrent = await Promise.all(Array.from({ length: 6 }, () => memory(D, "agent_memory_append", entry)));
  results.keep.concurrentStatuses = concurrent.map((r) => r.status);
  assert.ok(concurrent.every((r) => r.status === 200 && r.result.alreadySaved === true));
  results.keep.r1Lines = linesFor(D, r1Id);
  assert.deepEqual(results.keep.r1Lines, ["saved"]);
  results.keep.entriesInNote = fs.readFileSync(path.join(VAULT, MEMORY_NOTE), "utf8").split("Receipts decide saved, not prose.").length - 1;
  assert.equal(results.keep.entriesInNote, 1);
  await open("Mango direct chat");
  await wait("the final lines", async () => (await notes().count()) === 6);
  results.keep.statuses = await notes().evaluateAll((els) => els.map((e) => e.getAttribute("data-memory-status")));
  // r1, r2, r3, x1, x1's refused different payload, r4 — one line each. (The
  // tab's cache keeps x1 where it first saw it; the order on disk is above.)
  assert.deepEqual([...results.keep.statuses].sort(), ["failed", "refused", "saved", "saved", "saved", "uncertain"]);
  results.keep.linesOnDisk = Object.entries(Object.groupBy(memoryLines(D), (e) => e.id))
    .map(([, events]) => events.map((e) => e.status).join("+"));
  assert.equal(results.keep.linesOnDisk.length, 6);
  assert.ok(results.keep.linesOnDisk.every((s) => ["saved", "failed", "uncertain", "refused"].includes(s)), results.keep.linesOnDisk.join());
  await settle();
  await page.screenshot({ path: path.join(OUT, "8-recovered-lines-1440-dark.png") });

  // ---- Themes and widths.
  for (const [theme, width, height] of [["light", 1440, 1000], ["dark", 390, 844], ["light", 390, 844], ["fun", 390, 844], ["fun", 1440, 1000]]) {
    await page.evaluate((t) => localStorage.setItem("octiq.theme", t), theme);
    await page.setViewportSize({ width, height });
    // A phone hides the chat list; the chat's own link opens it anywhere.
    await page.goto("about:blank");
    await page.goto(`http://127.0.0.1:${PORT}/?token=${TOKEN}#/c/${D.slice(5)}`);
    const first = notes().first();
    await first.waitFor({ timeout: 10_000 });
    await first.getByRole("button", { name: /Details/ }).click();
    await first.scrollIntoViewIfNeeded();
    await settle();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    results[`overflow-${theme}-${width}`] = overflow;
    assert.equal(overflow, false, `no sideways scroll at ${width}px in ${theme}`);
    await page.screenshot({ path: path.join(OUT, `7-${theme}-${width}.png`) });
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
  fs.writeFileSync(path.join(OUT, "memory-activity-live.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(OUT, "server.log"), serverLog);
  await browser?.close();
  ws?.close();
  await stopServer().catch(() => {});
  try { fs.chmodSync(path.join(VAULT, "agent-zone/agents/mango-juice"), 0o755); } catch {}
}
console.log(JSON.stringify({ pass: results.pass, evidence: OUT, error: results.error }, null, 2));
process.exit(results.pass ? 0 : 1);
