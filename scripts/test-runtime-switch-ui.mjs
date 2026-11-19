// App-shell check of changing an agent's runtime from inside its chat, on the
// host contract `chat_switch_runtime` (docs/agents-mode.md). The socket is a
// stub with a little memory of its own (what the chat runs on, a switch
// waiting, the way home); everything else is the real App, composer and CSS.
//
// Scenes, in the order the person lives them:
//   1  On a fallback with Opus limited: the way-back row says when the limit
//      resets; the reset passes (one timer, nothing polls) and the words say
//      Opus may be available again; the person presses `Back to Opus`, the
//      request is the home runtime, the settings follow the host's word and
//      the row is gone.
//   2  The picker, idle: pick a model in the sheet. The request is held while
//      it is out (a second press sends nothing), and the settings text
//      changes only when the host's word arrives.
//   3  During a turn: the host answers pending. `Switches to <model> after
//      this turn` is said in the row, the sheet and the chip's tooltip, the
//      settings stay; picking the runtime already running takes it back.
//   4  Refusal: the host's sentence is on the row / in the sheet, the
//      settings stay as they were.
//   5  Reload on a fallback, and reload with a switch waiting: the same rows
//      from `chat_queue_state` alone, with no event.
//   6  Not offered: a worker's chat draws neither a row nor a picker.
//   7  Antigravity at guarded Auto: its tiles are off (`aria-disabled`) with
//      the reason in words, and nothing is sent.
//   8  An older reply is not applied over a newer host event: the reply to a
//      Sol switch is held in transit, a newer host switch back to Opus
//      arrives, then the older reply is released. The chip stays on Opus.
//   9  Agents mode OFF, a registered agent's chat (the host says so in
//      `chat_queue_state`): the ordinary model picker sends
//      `chat_switch_runtime` and nothing else (no `chat_retarget`, no
//      `chat_start`), and the picker's text moves only on the host's word.
//   10 Agents mode OFF, an ordinary chat (the host says it is not
//      registered): the picker is unchanged, a local choice and no switch.
//
// At 1280 (with the git column, so the chat is a narrow column) and 390, with
// screenshots in the theme named by OCTIQ_THEME (dark by default).
//
//   OCTIQ_THEME=light|dark   OCTIQ_EVIDENCE_DIR=/abs/dir
//   PLAYWRIGHT_MODULE=/abs/playwright/index.mjs
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const webRoot = resolve(process.env.OCTIQ_WEB_ROOT || fileURLToPath(new URL("../web", import.meta.url)));
const require = createRequire(join(webRoot, "package.json"));
const moduleUrl = (spec) => (isAbsolute(spec) || spec.startsWith(".") ? pathToFileURL(resolve(spec)).href : spec);
const { createServer } = await import(moduleUrl(require.resolve("vite")));
const { chromium } = await import(moduleUrl(process.env.PLAYWRIGHT_MODULE || "playwright"));
const theme = process.env.OCTIQ_THEME || "dark";
const artifacts = process.env.OCTIQ_EVIDENCE_DIR || await mkdtemp(join(tmpdir(), "octiq-runtime-switch-ui-"));
await mkdir(artifacts, { recursive: true });

const now = Date.now();
const root = "/Users/kyson/03-projects/octiq-flow";
const head = {
  id: "head", name: "Potato Juice", role: "Lead", agent: "claude", model: "opus",
  effort: "high", access: "read", projectId: "octiq", createdAt: now - 900_000, updatedAt: now - 900_000,
};

/** What the stub knows of the chat; each scene resets it. */
let host;
const fresh = (change = {}) => ({
  modelId: "claude:opus", effort: "high", access: "read",
  home: null, pending: null, switchMode: "switched", delay: 0, refusal: "", calls: [], commands: [], registered: true, polls: 0, ...change,
});
const MODEL_OF = {
  "claude:opus": { agent: "claude", model: "opus" },
  "codex:sol": { agent: "codex", model: "gpt-5.6-sol" },
  "antigravity:gemini": { agent: "antigravity", model: "gemini-3.8-flash-high" },
};

const chatRecord = (id, modelId, access) => ({
  id, projectId: "octiq", title: "Switch the runtime from inside the chat", customTitle: true, modelId, access, effort: "high",
  sessionId: `session-${id}`, cwd: root, createdAt: now - 500_000, updatedAt: now - 1_000,
});
const messages = [{ id: "m1", role: "assistant", streaming: false, blocks: [{ kind: "text", text: "Ready." }] }];

let socket = null;
const emit = (event, payload) => socket?.send(JSON.stringify({ t: "event", event, payload }));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function resultFor(request) {
  const key = request.args?.key;
  switch (request.cmd) {
    case "list_workspaces": return [{ id: "octiq", name: "octiq-flow", primary_path: root }];
    case "chat_index_list": return [chatRecord(host.chatId, host.modelId, host.access)];
    case "chat_index_deleted": return [];
    case "chat_page": return { events: [], context: [], before: null };
    case "provider_fallback_choices": return [];
    case "chat_list": case "chat_activity": case "permission_pending": case "question_pending":
    case "safety_block_pending": case "pr_repositories": case "codex_skills":
      return [];
    case "team_list": return [head];
    case "team_head": return head;
    case "team_leads": return [{ chatKey: `chat:${host.chatId}`, leadId: head.id, leadName: head.name, projectId: "octiq", crossProject: false, createdAt: now - 500_000 }];
    case "team_home": return "octiq";
    case "chat_queue_state":
      host.polls += 1;
      // A reset "in N ms" is fixed when the page first asks, so a slow cold
      // start of the dev server does not eat it.
      if (host.home?.resetsInMs && !host.home.resetsAt) host.home.resetsAt = Math.ceil((Date.now() + host.home.resetsInMs) / 1000);
      return {
        live: false, queuedTurnIds: [], registered: host.registered,
        ...(host.home ? { homeRuntime: Object.fromEntries(Object.entries(host.home).filter(([name]) => name !== "resetsInMs")) } : {}),
        ...(host.pending ? { pendingRuntime: host.pending } : {}),
      };
    case "orchestration_snapshot": return { runs: [], tasks: [], attempts: [], gates: [], messages: [], notifications: [] };
    case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
    case "usage_summary": return {};
    case "agent_models": return { source: "bundled", models: [] };
    case "agent_installs": return [{ id: "claude", installed: true, path: "/mock/claude" }, { id: "codex", installed: true, path: "/mock/codex" }, { id: "antigravity", installed: true, path: "/mock/agy" }];
    case "pr_local_list": case "pr_remote_list": return { items: [], warnings: [] };
    case "agent_avatar_status": return { available: false, reason: "Not signed in to Codex." };
    case "git_status_summary": return [{ path: root, repo_root: root, is_repo: true, branch: "develop", changed: 0, ahead: 0, behind: 0 }];
    case "git_local_branches": return { is_repo: true, current: "develop", branches: ["develop"], is_worktree: false };
    case "chat_task": return { chatId: request.args?.chatId, projectId: "octiq" };
    default: return key === undefined ? null : null;
  }
}

/** The host's answer to `chat_switch_runtime`, with its events first. */
async function switchRuntime(socketRef, request) {
  const { agent, model, effort } = request.args;
  host.calls.push({ key: request.args.key, agent, model, effort });
  if (host.delay) await sleep(host.delay);
  if (host.switchMode === "refuse") {
    socketRef.send(JSON.stringify({ t: "reply", id: request.id, ok: false, error: host.refusal }));
    return;
  }
  const modelId = Object.entries(MODEL_OF).find(([, ref]) => ref.agent === agent && (ref.model === model))?.[0] ?? `${agent}:${model}`;
  const same = modelId === host.modelId && (effort ?? "auto") === (host.effort === "auto" ? "auto" : host.effort);
  if (host.switchMode === "pending" && !same) {
    host.pending = { agent, model, effort };
    emit("chat-runtime-pending", { key: request.args.key, agent, model, effort });
    socketRef.send(JSON.stringify({ t: "reply", id: request.id, ok: true, result: { state: "pending", agent, model, effort, access: host.access } }));
    return;
  }
  if (host.pending) { host.pending = null; emit("chat-runtime-pending", { key: request.args.key, cleared: true }); }
  if (!same) {
    host.modelId = modelId; host.effort = effort ?? "auto";
    // Going back to the chat's own runtime ends the fallback.
    if (host.home && host.home.agent === agent && host.home.model === model) host.home = null;
    emit("chat-provider-switch", { key: request.args.key, agent, model, effort, access: host.access, sessionId: null, home: host.home, byPerson: true });
  }
  // A reply held in transit: the events have gone, the answer has not.
  if (host.holdReply) await new Promise((done) => { host.release = done; });
  socketRef.send(JSON.stringify({ t: "reply", id: request.id, ok: true, result: { state: "switched", agent, model, effort, access: host.access } }));
}

const server = await createServer({
  root: webRoot,
  configFile: join(webRoot, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  ...(process.env.OCTIQ_WEB_ROOT ? { cacheDir: join(artifacts, ".vite") } : {}),
});
const errors = [];
const report = { artifacts, theme, scenes: {} };

async function open(browser, { width, height, phone = false, chatId = "main", composer = true, agentsMode = true }) {
  const context = await browser.newContext({
    viewport: { width, height }, reducedMotion: "reduce",
    ...(phone ? { hasTouch: true, isMobile: true } : {}),
  });
  host.chatId = chatId;
  await context.addInitScript(({ stored, mode, gitColumn, agentsMode }) => {
    localStorage.setItem("octiq.agentsMode", agentsMode ? "on" : "off");
    localStorage.setItem("octiq.v2.gitColumn", gitColumn ? "1" : "0");
    localStorage.setItem("octiq.theme", mode);
    localStorage.setItem("octiq.v2.theme", mode);
    localStorage.setItem("octiq.v2.conversations", JSON.stringify(stored));
  }, { stored: [{ ...chatRecord(chatId, host.modelId, host.access), permission: host.access, messages }], mode: theme, gitColumn: !phone, agentsMode });
  await context.route("**/token", (route) => route.fulfill({ body: "mock-token" }));
  await context.route("**/auth", (route) => route.fulfill({ body: "ok" }));
  await context.routeWebSocket(/.*/, (ws) => {
    socket = ws;
    ws.onMessage((raw) => {
      const request = JSON.parse(String(raw));
      if (request.t !== "invoke") return;
      if (["chat_subscribe", "orchestration_summary", "orchestration_run_detail"].includes(request.cmd)) {
        ws.send(JSON.stringify({ t: "reply", id: request.id, ok: false, error: `'${request.cmd}' is not available on this backend` })); return;
      }
      host.commands.push(request.cmd);
      if (request.cmd === "chat_switch_runtime") { void switchRuntime(ws, request); return; }
      ws.send(JSON.stringify({ t: "reply", id: request.id, ok: true, result: resultFor(request) }));
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) => errors.push(error.stack ?? String(error)));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/#/p/octiq-flow/c/${chatId}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  if (composer) await page.locator(".composer-row").waitFor();
  else await page.locator(".topbar").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(700);
  return { context, page };
}

const runsText = (page) => page.locator(".composer-identity-runs").innerText().then((text) => text.replace(/\s+/g, " ").trim());
const rowsText = (page) => page.locator(".runtime-row").allInnerTexts().then((list) => list.map((text) => text.replace(/\s+/g, " ").trim()));
const openSheet = async (page, phone) => {
  const spot = await page.locator(".composer-identity-name").evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  if (phone) await page.touchscreen.tap(spot.x, spot.y); else await page.mouse.click(spot.x, spot.y);
  await page.locator(".runtime-sheet").waitFor();
};
const closeSheet = async (page) => {
  await page.locator(".sheet-scrim").click({ position: { x: 4, y: 4 } });
  await page.locator(".runtime-sheet").waitFor({ state: "detached" });
};
const shot = (page, name) => page.screenshot({ path: join(artifacts, `${theme}-${name}.png`) });
/** The way-back row's box against the group it is in and the window. */
const rowBox = (page) => page.evaluate(() => {
  const row = document.querySelector(".runtime-row[data-kind=home]");
  const button = row?.querySelector(".runtime-back");
  if (!row || !button) return null;
  const r = row.getBoundingClientRect(), b = button.getBoundingClientRect();
  return { rowRight: Math.round(r.right), buttonRight: Math.round(b.right), buttonH: Math.round(b.height), buttonW: Math.round(b.width), rowH: Math.round(r.height), sideways: document.documentElement.scrollWidth > innerWidth };
});

async function scenes(browser, size) {
  const phone = !!size.phone;
  const at = `${size.width}`;
  const out = (report.scenes[at] = {});

  // 1  The person's own: on Codex after Opus hit its limit.
  {
    host = fresh({ modelId: "codex:sol", home: { agent: "claude", model: "opus", effort: "high", limited: true, resetsInMs: 6000 } });
    const { context, page } = await open(browser, { ...size });
    const row = page.locator(".runtime-row[data-kind=home]");
    await row.waitFor();
    const before = (await rowsText(page))[0];
    assert.match(before, /^Running on Codex\s*Opus limit resets \d{1,2}:\d{2}/, `${at}: the row says where it runs and when the limit resets (${before})`);
    assert.match(before, /Back to Opus$/, `${at}: and offers the way back`);
    assert.match(await runsText(page), /^sol · high · Read-only$/, `${at}: the chip says what the chat runs on now`);
    const box = await rowBox(page);
    assert(box.buttonRight <= box.rowRight + 0.5, `${at}: the button is inside the row`);
    assert.equal(box.sideways, false);
    if (phone || await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches)) assert(box.buttonH >= 43.5, `${at}: the button is 44px on a phone (${box.buttonH})`);
    out.row = box;
    await shot(page, `${at}-1-limited`);
    // The reset passes: one timer redraws the words, nothing polls.
    const pollsBefore = host.polls;
    await page.waitForFunction(() => /may be available again/.test(document.querySelector(".runtime-row[data-kind=home]")?.textContent ?? ""), null, { timeout: 15_000 });
    assert.equal(host.polls, pollsBefore, `${at}: nothing polls: the words changed by their own timer`);
    assert.match((await rowsText(page))[0], /^Running on Codex\s*Opus may be available again\s*Back to Opus$/);
    await shot(page, `${at}-1-reset-passed`);
    // Back to Opus: asked of the host as the home runtime.
    await page.getByRole("button", { name: "Back to Opus" }).click();
    await row.waitFor({ state: "detached" });
    assert.deepEqual(host.calls, [{ key: `chat:${host.chatId}`, agent: "claude", model: "opus", effort: "high" }], `${at}: the request is the home runtime`);
    assert.match(await runsText(page), /^opus latest · high · Plan$/, `${at}: the settings text follows the host's word (${await runsText(page)})`);
    assert.deepEqual(await rowsText(page), [], `${at}: the row is gone`);
    await context.close();
  }

  // 2  The picker, idle.
  {
    host = fresh({ delay: 700 });
    const { context, page } = await open(browser, { ...size });
    assert.match(await runsText(page), /^opus latest · high · Plan$/);
    await openSheet(page, phone);
    const sheet = page.locator(".runtime-sheet");
    const inside = await sheet.evaluate((el) => { const r = el.getBoundingClientRect(); return { ok: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, sideways: el.scrollWidth > el.clientWidth + 1, text: el.innerText.replace(/\s+/g, " ") }; });
    assert(inside.ok && !inside.sideways, `${at}: the sheet is inside the window`);
    assert.doesNotMatch(inside.text, /Access/, `${at}: no access control in the sheet`);
    assert.match(inside.text, /This changes this chat only/);
    out.sheet = inside;
    await shot(page, `${at}-2-sheet`);
    await sheet.getByRole("tab", { name: /Codex/ }).click();
    const tile = phone || await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches)
      ? sheet.locator(".picker-item", { hasText: "Sol" }) : sheet.locator(".picker-item, .mp-card", { hasText: "Sol" });
    await tile.first().click();
    // A second press while the request is out sends nothing.
    await tile.first().click({ force: true }).catch(() => {});
    await page.waitForTimeout(250);
    assert.match(await runsText(page), /^opus latest · high · Plan$/, `${at}: the settings text does not move on the press, only on the host's word`);
    await page.waitForFunction(() => /^sol/.test(document.querySelector(".composer-identity-runs")?.textContent ?? ""), null, { timeout: 10_000 });
    assert.equal(host.calls.length, 1, `${at}: one request while it was out (${host.calls.length})`);
    assert.deepEqual(host.calls[0], { key: `chat:${host.chatId}`, agent: "codex", model: "gpt-5.6-sol", effort: "high" });
    assert.match(await runsText(page), /^sol · high · Read-only$/);
    await page.keyboard.press("Escape");
    await context.close();
  }

  // 3  During a turn: pending, and taking it back.
  {
    host = fresh({ switchMode: "pending" });
    const { context, page } = await open(browser, { ...size });
    await openSheet(page, phone);
    const sheet = page.locator(".runtime-sheet");
    await sheet.getByRole("tab", { name: /Codex/ }).click();
    await sheet.locator(".picker-item, .mp-card", { hasText: "Sol" }).first().click();
    await page.locator(".runtime-sheet .runtime-pending").waitFor();
    assert.equal(await page.locator(".runtime-sheet .runtime-pending").innerText(), "Switches to Sol after this turn");
    assert.match(await runsText(page), /^opus latest · high · Plan$/, `${at}: nothing changed yet: the turn is not interrupted`);
    await shot(page, `${at}-3-pending-sheet`);
    await closeSheet(page);
    const kinds = await rowsText(page);
    assert.deepEqual(kinds, ["Switches to Sol after this turn"], `${at}: the row says it too`);
    const title = await page.locator(".composer-identity").getAttribute("title");
    assert.match(title, /Switches to Sol after this turn/, `${at}: and the chip's tooltip`);
    const dot = await page.evaluate(() => { const el = document.querySelector(".runtime-pending-dot"); const s = getComputedStyle(el); const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(); return { border: s.borderTopColor, accent }; });
    out.pendingDot = dot;
    await shot(page, `${at}-3-pending-row`);
    // Picking the runtime already running takes it back.
    await openSheet(page, phone);
    await page.locator(".runtime-sheet").getByRole("tab", { name: /Claude/ }).click();
    await page.locator(".runtime-sheet .picker-item, .runtime-sheet .mp-card").filter({ hasText: "Opus latest" }).first().click();
    await page.waitForFunction(() => document.querySelectorAll(".runtime-row").length === 0, null, { timeout: 10_000 });
    assert.equal(host.pending, null);
    await context.close();
  }

  // 4  Refusal, said where the press was made.
  {
    host = fresh({ modelId: "codex:sol", switchMode: "refuse", refusal: "Claude is not installed on this machine.", home: { agent: "claude", model: "opus", effort: "high", limited: false } });
    const { context, page } = await open(browser, { ...size });
    await page.getByRole("button", { name: "Back to Opus" }).click();
    const refusal = page.locator(".runtime-row-refusal");
    await refusal.waitFor();
    assert.equal(await refusal.innerText(), "Claude is not installed on this machine.", `${at}: the host's sentence, whole, on the row`);
    const whole = await refusal.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && getComputedStyle(el).whiteSpace !== "nowrap");
    assert(whole, `${at}: the sentence is never cut`);
    assert.match(await runsText(page), /^sol · high · Read-only$/, `${at}: the settings stay as they were`);
    assert.equal((await rowsText(page)).length, 1, `${at}: the way back is still offered`);
    await shot(page, `${at}-4-refusal-row`);
    // And in the sheet, for a press made there.
    host.refusal = "Opus is not available on this account.";
    await openSheet(page, phone);
    const sheet = page.locator(".runtime-sheet");
    await sheet.getByRole("tab", { name: /Claude/ }).click();
    await sheet.locator(".picker-item, .mp-card").filter({ hasText: "Sonnet latest" }).first().click();
    await sheet.locator(".runtime-refusal").waitFor();
    assert.match(await sheet.locator(".runtime-refusal").innerText(), /Opus is not available on this account\./);
    assert.match(await runsText(page), /^sol · high · Read-only$/, `${at}: still unchanged`);
    await shot(page, `${at}-4-refusal-sheet`);
    await context.close();
  }

  // 5  Reload: the same rows from `chat_queue_state` alone.
  {
    host = fresh({ modelId: "codex:sol", home: { agent: "claude", model: "opus", effort: "high", limited: true } });
    let { context, page } = await open(browser, { ...size });
    await page.locator(".runtime-row[data-kind=home]").waitFor();
    assert.match((await rowsText(page))[0], /Running on Codex\s*Opus limit reached\s*Back to Opus/, `${at}: a reload on a fallback draws the row (${(await rowsText(page))[0]})`);
    await context.close();
    host = fresh({ pending: { agent: "codex", model: "gpt-5.6-sol", effort: "high" } });
    ({ context, page } = await open(browser, { ...size }));
    await page.locator(".runtime-row[data-kind=pending]").waitFor();
    assert.deepEqual(await rowsText(page), ["Switches to Sol after this turn"], `${at}: a reload with a switch waiting draws the line`);
    await page.locator(".composer-identity").getAttribute("title").then((title) => assert.match(title, /Switches to Sol after this turn/));
    await context.close();
  }

  // 6  Not offered on a worker's chat.
  {
    host = fresh({ modelId: "codex:sol", home: { agent: "claude", model: "opus", effort: "high", limited: true }, pending: { agent: "claude", model: "opus", effort: null } });
    const { context, page } = await open(browser, { ...size, chatId: "orch-worker-1", composer: false });
    await page.waitForTimeout(500);
    assert.equal(await page.locator(".runtime-row").count(), 0, `${at}: no row on a worker's chat`);
    assert.equal(await page.locator(".runtime-sheet").count(), 0);
    assert.equal(await page.locator(".composer-identity").count(), 0, `${at}: and no chip with pickers`);
    await context.close();
  }

  // 7  Antigravity at guarded Auto: shown, off, with the reason in words.
  {
    host = fresh({ access: "auto" });
    const { context, page } = await open(browser, { ...size });
    await openSheet(page, phone);
    const sheet = page.locator(".runtime-sheet");
    await sheet.getByRole("tab", { name: /Antigravity/ }).click();
    const tiles = sheet.locator("[aria-disabled=true].picker-item, [aria-disabled=true].mp-card");
    assert((await tiles.count()) > 0, `${at}: Antigravity's models stay visible and off`);
    assert.match(await sheet.innerText(), /Antigravity cannot ask for permission/, `${at}: with the reason in words`);
    await tiles.first().click({ force: true });
    await page.waitForTimeout(300);
    assert.equal(host.calls.length, 0, `${at}: nothing is sent`);
    await shot(page, `${at}-7-antigravity-held`);
    await context.close();
  }

  // 8  An older reply cannot undo a newer host event.
  {
    host = fresh({ holdReply: true });
    const { context, page } = await open(browser, { ...size });
    await openSheet(page, phone);
    const sheet = page.locator(".runtime-sheet");
    await sheet.getByRole("tab", { name: /Codex/ }).click();
    await sheet.locator(".picker-item, .mp-card", { hasText: "Sol" }).first().click();
    // The host switched and said so; its reply is still in transit.
    await page.waitForFunction(() => /^sol/.test(document.querySelector(".composer-identity-runs")?.textContent ?? ""), null, { timeout: 10_000 });
    for (let wait = 0; wait < 100 && !host.release; wait += 1) await sleep(50);
    assert(host.release, `${at}: the reply is held`);
    // A newer host switch, back to Opus, arrives before the older reply.
    host.modelId = "claude:opus"; host.effort = "high";
    emit("chat-provider-switch", { key: `chat:${host.chatId}`, agent: "claude", model: "opus", effort: "high", access: host.access, sessionId: null, home: null, byPerson: true });
    await page.waitForFunction(() => /^opus/.test(document.querySelector(".composer-identity-runs")?.textContent ?? ""), null, { timeout: 10_000 });
    host.release();
    await page.waitForTimeout(1500);
    assert.match(await runsText(page), /^opus latest · high · Plan$/, `${at}: the older reply did not put Sol back (${await runsText(page)})`);
    await shot(page, `${at}-8-older-reply`);
    await context.close();
  }

  // 9  Agents mode off, a registered agent's chat: the ordinary picker is a
  //    runtime switch, asked of the host and applied only on its word.
  {
    host = fresh({ delay: 600 });
    const { context, page } = await open(browser, { ...size, agentsMode: false });
    const trigger = page.locator(".model-trigger:visible").first();
    await trigger.waitFor();
    assert.match(await trigger.innerText(), /opus/i, `${at}: the picker starts on Opus`);
    assert.equal(await page.locator(".composer-identity").count(), 0, `${at}: no agent chip with agents mode off`);
    await trigger.click();
    const menu = page.locator(".picker-menu.is-models:visible, .settings-sheet:visible").first();
    await menu.waitFor();
    await menu.getByRole("tab", { name: /Codex/ }).click();
    await menu.locator(".picker-item, .mp-card", { hasText: "Sol" }).first().click();
    await page.waitForTimeout(250);
    assert.match(await page.locator(".model-trigger:visible").first().innerText(), /opus/i, `${at}: the picker does not move on the press, only on the host's word`);
    await page.waitForFunction(() => /sol/i.test(document.querySelector(".model-trigger")?.textContent ?? ""), null, { timeout: 10_000 });
    assert.deepEqual(host.calls, [{ key: `chat:${host.chatId}`, agent: "codex", model: "gpt-5.6-sol", effort: "high" }], `${at}: one chat_switch_runtime with the picked runtime`);
    assert.equal(host.commands.filter((cmd) => cmd === "chat_retarget" || cmd === "chat_start").length, 0, `${at}: no retarget and no start carries the choice (${host.commands.filter((cmd) => /chat_(retarget|start|send)/.test(cmd))})`);
    await shot(page, `${at}-9-picker-registered-agents-off`);
    await context.close();
  }

  // 10 Agents mode off, an ordinary chat: today's picker, no switch.
  {
    host = fresh({ registered: false });
    const { context, page } = await open(browser, { ...size, agentsMode: false });
    const trigger = page.locator(".model-trigger:visible").first();
    await trigger.waitFor();
    await trigger.click();
    const menu = page.locator(".picker-menu.is-models:visible, .settings-sheet:visible").first();
    await menu.waitFor();
    await menu.getByRole("tab", { name: /Codex/ }).click();
    await menu.locator(".picker-item, .mp-card", { hasText: "Sol" }).first().click();
    await page.waitForFunction(() => /sol/i.test(document.querySelector(".model-trigger")?.textContent ?? ""), null, { timeout: 10_000 });
    assert.equal(host.calls.length, 0, `${at}: an ordinary chat never asks the host to switch`);
    await context.close();
  }
}

let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  await scenes(browser, { width: 1280, height: 860 });
  await scenes(browser, { width: 390, height: 844, phone: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, mockedBackend: true, ...report }, null, 1));
} catch (error) {
  const page = browser?.contexts().at(-1)?.pages().at(-1);
  await page?.screenshot({ path: join(artifacts, `${theme}-failure.png`), fullPage: true }).catch(() => {});
  console.log(JSON.stringify({ ...report, errors }, null, 1));
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
