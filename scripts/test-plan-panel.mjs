// App-shell check of the Plan panel, over the plans the host itself
// recorded (`web/src/lib/__fixtures__/host/chat_plan_*.json`).
//
//   none        a chat with no plan           the button, `No plan yet`, no Start
//   discussing  two items, three questions    the count on the button, Start beside `3 questions still open`
//   decided     every question answered       Start alone
//   started     a started plan, mixed tasks   `Started`, the host's count beside the agent's word
//
// Then what a press does, which no render test can show:
//   - Start is sent once, with the revision on screen and the chat's start
//     settings, and is replaced by `Started` when the host says so;
//   - a refusal leaves the button with the host's words under it;
//   - a Start whose turn was not handed over says both halves and offers
//     `Tell the agent`, with the reason behind a disclosure;
//   - the press that opened the panel, repeated in the same spot, and a held
//     key do not start anything;
//   - an item's task opens the run panel at that task's row;
//   - a worker's chat has no Plan button.
//
// Nothing of a plan is changed but its `chatId`, which is set to the mock's
// chat. For the last scene the started plan's second item is pointed at the
// two tasks of a host ledger (`usage_context.json`) and one of that ledger's
// attempts is moved to `executing`: no recorded fixture holds a plan and a
// ledger of the same tasks, or a turn in flight.
//
// The socket is mocked; everything else is the real App and CSS.
//
//   OCTIQ_THEME=light|dark|fun|manga|guofeng   the appearance mode (dark)
//   WIDE_FONT=1            a wider font, standing in for a Windows fallback
//   CLASSIC_SCROLLBARS=1   Chromium's 15px classic scrollbars, as on Windows
//   OCTIQ_EVIDENCE_DIR=<dir>   where the screenshots go
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

// `fileURLToPath`, not `.pathname`: on Windows that is `/C:/…`, which
// `resolve` turns into `C:\C:\…`. OCTIQ_WEB_ROOT points at another copy of web/.
const webRoot = resolve(process.env.OCTIQ_WEB_ROOT || fileURLToPath(new URL("../web", import.meta.url)));
const require = createRequire(join(webRoot, "package.json"));
/** A module named by a path is imported by its file URL: Node's loader
 *  refuses `C:\…` as a specifier. A bare name or a URL is left as it is. */
const moduleUrl = (spec) => (isAbsolute(spec) || spec.startsWith(".") ? pathToFileURL(resolve(spec)).href : spec);
const { createServer } = await import(moduleUrl(require.resolve("vite")));
const { chromium } = await import(moduleUrl(process.env.PLAYWRIGHT_MODULE || "playwright"));
const wideFont = process.env.WIDE_FONT === "1";
const classic = process.env.CLASSIC_SCROLLBARS === "1";
const theme = process.env.OCTIQ_THEME || "dark";
const artifacts = process.env.OCTIQ_EVIDENCE_DIR || await mkdtemp(join(tmpdir(), "octiq-plan-panel-"));
await mkdir(artifacts, { recursive: true });
const tag = [theme, wideFont && "wide", classic && "classic"].filter(Boolean).join("-");

const root = "/Users/kyson/03-projects/octiq-flow";
const SIZES = [{ name: "1280", width: 1280, height: 900, phone: false }, { name: "390", width: 390, height: 844, phone: true }];

const fixture = async (file) => JSON.parse(await readFile(join(webRoot, "src/lib/__fixtures__/host", `${file}.json`), "utf8"));
const plan = async (name) => ({ ...(await fixture(`chat_plan_${name}`)), chatId: "main" });
const EMPTY_LEDGER = { runs: [], tasks: [], attempts: [], gates: [], messages: [] };

/** The host's ledger of two running attempts, set in the mock's chat, with
 *  its two tasks under the ids the started plan's second item links, and the
 *  first attempt's turn in flight. */
async function linkedLedger(started) {
  const text = await readFile(join(webRoot, "src/lib/__fixtures__/host/usage_context.json"), "utf8");
  const before = JSON.parse(text);
  const item = started.items[1];
  let moved = text.replaceAll(JSON.stringify(before.runs[0].coordinatorChatKey), JSON.stringify("chat:main"))
    .replaceAll(before.runs[0].id, item.linked[0].runId);
  before.tasks.slice(0, 2).forEach((task, at) => { moved = moved.replaceAll(task.id, item.tasks[at]); });
  const snapshot = JSON.parse(moved);
  snapshot.runs = snapshot.runs.map((run) => ({ ...run, workspaceId: "octiq", objective: "The UI batch" }));
  snapshot.tasks = snapshot.tasks.map((task, at) => ({ ...task, title: item.linked[at]?.title ?? task.title, assignee: { id: "fe", name: "OCTIQ FE" } }));
  const flying = snapshot.attempts.find((attempt) => attempt.id === snapshot.tasks[0].activeAttemptId);
  flying.execution = { ...flying.execution, state: "executing" };
  return snapshot;
}

function mock(state) {
  const stamp = 1791886010639;
  const main = {
    id: "main", projectId: "octiq", title: "Plan the UI batch", customTitle: true, modelId: "claude:opus", access: "auto",
    sessionId: "session-main", cwd: root, createdAt: stamp - 3_000_000, updatedAt: stamp, coordinatesRun: state.ledger.runs.length > 0,
  };
  const workers = state.ledger.attempts.map((attempt) => ({ ...main, id: attempt.workerChatKey.replace(/^chat:/, ""), title: "Worker", sessionId: `session-${attempt.id}`, coordinatesRun: false }));
  const chats = [main, ...workers];
  const stored = chats.map((chat) => ({ ...chat, messages: [{ id: `m-${chat.id}`, role: "assistant", streaming: false, blocks: [{ kind: "text", text: "Ready." }] }] }));
  const resultFor = (request) => {
    switch (request.cmd) {
      case "list_workspaces": return [{ id: "octiq", name: "octiq-flow", primary_path: root }];
      case "chat_index_list": return chats;
      case "chat_index_deleted": return [];
      case "chat_page": return { events: [], context: [], before: null };
      case "chat_list": case "chat_activity": case "permission_pending": case "question_pending":
      case "safety_block_pending": case "pr_repositories": case "codex_skills": case "image_preview_list":
        return [];
      case "team_list": return [{ id: "fe", name: "OCTIQ FE", role: "", agent: "claude", model: "opus", access: "auto", createdAt: 1, updatedAt: 1 }];
      case "chat_queue_state": return { live: false, queuedTurnIds: [] };
      case "orchestration_snapshot": return state.ledger;
      case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
      case "usage_summary": return {};
      case "agent_installs": return [{ id: "claude", installed: true, path: "/mock/claude" }];
      case "pr_local_list": case "pr_remote_list": return { items: [], warnings: [] };
      case "sandbox_snapshot": return { defaultEnabled: false, environments: {} };
      case "git_status_summary": return [{ path: root, repo_root: root, is_repo: true, branch: "develop", changed: 0, ahead: 0, behind: 0 }];
      case "git_local_branches": return { is_repo: true, current: "develop", branches: ["develop"], is_worktree: false };
      case "chat_task": return { chatId: request.args?.chatId, projectId: "octiq" };
      case "chat_plan_get": state.reads.push(request.args); return state.plan;
      default: return null;
    }
  };
  return { stored, resultFor };
}

const server = await createServer({
  root: webRoot,
  configFile: join(webRoot, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
const errors = [];
const report = { artifacts, theme, wideFont, classic, scenes: {} };

async function open(browser, state, { width, height, phone = false }, chat = "main") {
  const { stored, resultFor } = mock(state);
  const context = await browser.newContext({
    viewport: { width, height }, reducedMotion: "reduce",
    ...(phone ? { hasTouch: true, isMobile: true } : {}),
  });
  await context.addInitScript(({ chats, mode, wide }) => {
    localStorage.setItem("octiq.v2.gitColumn", "0");
    localStorage.setItem("octiq.theme", mode);
    localStorage.setItem("octiq.v2.theme", mode);
    localStorage.setItem("octiq.v2.conversations", JSON.stringify(chats));
    if (wide) addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = "*, *::before, *::after { font-family: Verdana, sans-serif !important; letter-spacing: 0.02em !important; }";
      document.head.append(style);
    });
  }, { chats: stored, mode: theme, wide: wideFont });
  await context.route("**/token", (route) => route.fulfill({ body: "mock-token" }));
  await context.route("**/auth", (route) => route.fulfill({ body: "ok" }));
  const sockets = new Set();
  await context.routeWebSocket(/.*/, (socket) => {
    sockets.add(socket);
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw));
      if (request.t !== "invoke") return;
      if (request.cmd === "chat_plan_start") {
        state.starts.push(request.args);
        const reply = (answer) => {
          if (answer.error) { socket.send(JSON.stringify({ t: "reply", id: request.id, ok: false, error: answer.error })); return; }
          state.plan = answer.plan;
          // The host says a recorded Start before it answers.
          for (const each of sockets) each.send(JSON.stringify({ t: "event", event: "chat-plan", payload: { chatId: "main", plan: answer.plan } }));
          socket.send(JSON.stringify({ t: "reply", id: request.id, ok: true, result: answer }));
        };
        const answer = state.onStart(request.args);
        // A host that has not answered yet: `state.release(answer)` answers.
        if (answer.hold) { state.release = reply; return; }
        reply(answer);
        return;
      }
      socket.send(JSON.stringify({ t: "reply", id: request.id, ok: true, result: resultFor(request) }));
    });
  });
  const say = (event, payload) => sockets.forEach((socket) => socket.send(JSON.stringify({ t: "event", event, payload })));
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  page.on("pageerror", (error) => errors.push(error.stack ?? String(error)));
  // An error React caught unmounts the page and reaches the console only.
  page.on("console", (message) => { if (message.type() === "error" && /Error|Uncaught|Minified React/.test(message.text())) errors.push(message.text().slice(0, 600)); });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/#/p/octiq-flow/c/${chat}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  return { context, page, say };
}

const fresh = (planNow, ledger = EMPTY_LEDGER) => ({ plan: planNow, ledger, reads: [], starts: [], onStart: () => ({ error: "not expected" }) });
const noSidewaysScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const toggle = (page) => page.locator(".cplan-toggle").first();
const panel = (page) => page.locator(".cplan-panel").first();

/** The Plan button, wherever the bar put it: in the row, or behind More. */
async function openPlan(page) {
  const button = toggle(page);
  await page.locator(".actionbar").first().waitFor();
  for (let tries = 0; tries < 120 && !(await button.isVisible().catch(() => false)); tries++) {
    const more = page.locator(".mobile-actions-trigger").first();
    if (tries > 20 && await more.isVisible().catch(() => false) && await more.getAttribute("aria-expanded") !== "true") await more.click().catch(() => {});
    await page.waitForTimeout(250);
  }
  await button.scrollIntoViewIfNeeded();
  if (await button.getAttribute("aria-expanded") !== "true") await button.click();
  await panel(page).waitFor();
  // Reduced motion still takes a few frames to reach a child's visibility.
  await page.waitForTimeout(250);
}

const probes = (page) => page.evaluate(() => Object.fromEntries(["--decide", "--accent", "--ok", "--warn", "--danger", "--fg-2"].map((token) => {
  const el = document.createElement("span"); el.style.color = `var(${token})`; document.body.append(el);
  const colour = getComputedStyle(el).color; el.remove(); return [token, colour];
})));

/** What the panel says and how it is drawn. */
const readPanel = (page) => page.evaluate(() => {
  const root = document.querySelector(".cplan-panel");
  if (!root) return null;
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
  // What is drawn, part by part: text nodes joined by a space, and nothing
  // of a part that is folded away.
  const text = (el) => {
    if (!el) return null;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const parts = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) if (!node.parentElement.closest("[hidden]")) parts.push(node.textContent);
    return parts.join(" ").replace(/\s+/g, " ").trim();
  };
  const start = root.querySelector(".cplan-start");
  const scroller = root.querySelector(".cplan-items");
  return {
    page: root.classList.contains("is-page"), box: box(root),
    state: text(root.querySelector(".cplan-head-state")), meta: text(root.querySelector(".cplan-meta")),
    none: text(root.querySelector(".cplan-none")),
    items: [...root.querySelectorAll(".cplan-item")].map((item) => ({
      status: item.getAttribute("data-status"), mark: item.getAttribute("data-mark"),
      title: text(item.querySelector(".cplan-item-title")), word: text(item.querySelector(".cplan-item-word")),
      markBorder: getComputedStyle(item.querySelector(".cplan-mark")).borderTopColor,
      questions: [...item.querySelectorAll(".cplan-questions li")].map((li) => text(li)),
      questionMark: (() => { const el = item.querySelector(".cplan-question-mark"); return el ? getComputedStyle(el).color : null; })(),
      progress: text(item.querySelector(".cplan-progress")),
      inside: (() => { const r = item.getBoundingClientRect(); const p = scroller.getBoundingClientRect(); return r.left >= p.left - 0.5 && r.right <= p.right + 0.5; })(),
      cut: [...item.querySelectorAll(".cplan-item-title, .cplan-decisions li, .cplan-questions li span:last-child")].some((el) => el.scrollWidth > el.clientWidth + 1),
    })),
    foot: text(root.querySelector(".cplan-foot")), footBox: box(root.querySelector(".cplan-foot")),
    start: start ? { label: text(start), off: start.getAttribute("aria-disabled") === "true", border: getComputedStyle(start).borderTopColor, box: box(start) } : null,
    scrollerSideways: scroller ? scroller.scrollWidth > scroller.clientWidth + 1 : false,
    chatHidden: !!document.querySelector(".chat-app-surface")?.hidden,
    composer: !!document.querySelector(".composer") && document.querySelector(".composer").getClientRects().length > 0,
  };
});

/** The checks every fixture gets, and its screenshot. */
async function fixtureScene(browser, name, size, expect) {
  const label = `${tag}-${size.name}-${name}`;
  const out = (report.scenes[name] ??= {})[size.name] = {};
  const state = fresh(await plan(name));
  const { context, page } = await open(browser, state, size);
  const colours = await (await page.locator(".actionbar").first().waitFor(), probes(page));
  const button = toggle(page);
  await button.waitFor();

  // The button: an icon, the word, and the open questions in the decision colour.
  await page.waitForFunction(() => document.querySelector(".cplan-toggle") && true);
  await page.waitForTimeout(600);
  const count = page.locator(".cplan-toggle-open");
  out.button = { label: await button.getAttribute("aria-label"), count: await count.count() ? (await count.first().textContent())?.trim() : null };
  assert.equal(out.button.count, expect.count, `${label}: the open questions on the button`);
  if (expect.count) assert.equal(await count.first().evaluate((el) => getComputedStyle(el).color), colours["--decide"], `${label}: in the decision colour`);
  assert.equal((await button.locator(".topbar-action-label").textContent())?.trim(), "Plan", `${label}: the button's word`);
  assert.equal(state.reads.length, 1, `${label}: the plan is read once as the chat opens`);

  await openPlan(page);
  assert.equal(state.reads.length, 2, `${label}: and once more as the panel opens`);
  const read = await readPanel(page);
  out.panel = { state: read.state, meta: read.meta, none: read.none, foot: read.foot, items: read.items.map((item) => `${item.word}: ${item.title}`) };
  assert.equal(read.page, size.phone, `${label}: a page on a phone, a column on a desktop`);
  assert.equal(read.chatHidden, size.phone, `${label}: the chat gives its place on a phone only`);
  assert.equal(read.composer, !size.phone, `${label}: the composer is on screen beside a column, and not under a page`);
  if (!size.phone) assert(read.box.r <= size.width + 0.5 && read.box.w >= 300, `${label}: the column is inside the window (${JSON.stringify(read.box)})`);
  else assert(read.box.w >= size.width - 1, `${label}: the page is the window's width`);
  assert.equal(read.state, expect.state === null ? null : read.state, `${label}: header state`);
  if (expect.state) assert.match(read.state, expect.state, `${label}: the header's state`);
  if (expect.none) assert.match(read.none, expect.none, `${label}: the empty line`);
  assert.equal(read.items.length, expect.items, `${label}: its items`);
  for (const item of read.items) {
    assert.equal(item.inside, true, `${label}: ${item.title} is inside the panel`);
    assert.equal(item.cut, false, `${label}: nothing of ${item.title} is cut`);
    if (item.questionMark) assert.equal(item.questionMark, item.status === "dropped" ? item.questionMark : colours["--decide"], `${label}: a question still open is the decision colour`);
    // No turn is in flight in these: nothing is the accent, and nothing is red.
    assert.notEqual(item.markBorder, colours["--accent"], `${label}: ${item.title} is not the accent`);
    assert.notEqual(item.markBorder, colours["--danger"], `${label}: ${item.title} is not red`);
  }
  assert.equal(read.scrollerSideways, false, `${label}: the list does not scroll sideways`);
  assert.equal(await noSidewaysScroll(page), true, `${label}: no sideways scroll`);
  assert.equal(read.foot, expect.foot === undefined ? read.foot : expect.foot, `${label}: the foot`);
  if (expect.footMatch) assert.match(read.foot, expect.footMatch, `${label}: the foot`);
  assert.equal(read.start?.label ?? null, expect.start, `${label}: the Start control`);
  if (read.start) {
    assert.equal(read.start.border, colours["--decide"], `${label}: Start is the decision colour`);
    assert(read.start.box.r <= read.box.r + 0.5 && read.start.box.l >= read.box.l - 0.5, `${label}: Start is inside the panel`);
    assert(read.footBox.b <= size.height + 0.5, `${label}: the foot is on screen`);
  }
  await expect.more?.({ page, label, out, read, colours, state, size });
  await page.screenshot({ path: join(artifacts, `${label}.png`) });
  // The way back: the same button, and the chat is there again.
  await toggle(page).click();
  await panel(page).waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => !!document.querySelector(".chat-app-surface")?.hidden), false, `${label}: the chat is back`);
  await context.close();
}

/** Start, a refusal, a Start that was not delivered, and the guards. */
async function startScene(browser, size) {
  const label = `${tag}-${size.name}-start`;
  const out = (report.scenes.start ??= {})[size.name] = {};
  const decided = await plan("decided");
  const state = fresh(decided);
  const { context, page } = await open(browser, state, size);
  await toggle(page).waitFor();
  await page.waitForTimeout(600);

  // The press that opens the panel, repeated in the same spot onto Start,
  // starts nothing; nor does a key held down.
  const opener = toggle(page);
  await opener.scrollIntoViewIfNeeded();
  const at = await opener.boundingBox();
  const spot = { x: at.x + at.width / 2, y: at.y + at.height / 2 };
  // The repeat is sent from inside the page, the moment Start is drawn: the
  // guard is a window of 700 ms, and a press sent from here after a wait for
  // the button missed it on a loaded machine (seen once, in manga at 1280).
  await page.evaluate((where) => {
    window.__strayStart = new Promise((done) => {
      const repeat = () => {
        const button = document.querySelector(".cplan-start");
        if (!button) return false;
        const click = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1, clientX: where.x, clientY: where.y });
        button.dispatchEvent(click);
        done(click.defaultPrevented);
        return true;
      };
      const watch = new MutationObserver(() => { if (repeat()) watch.disconnect(); });
      watch.observe(document.body, { childList: true, subtree: true });
    });
  }, spot);
  await page.mouse.click(spot.x, spot.y);
  const start = page.locator(".cplan-start");
  await start.waitFor();
  const stray = await page.evaluate(() => window.__strayStart);
  const held = await start.evaluate((button) => {
    const key = new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true, cancelable: true });
    button.dispatchEvent(key);
    return key.defaultPrevented;
  });
  await page.waitForTimeout(200);
  out.guards = { stray, held, sent: state.starts.length };
  assert.equal(stray, true, `${label}: a press that repeats the one that opened the panel is dropped`);
  assert.equal(held, true, `${label}: a held key is dropped`);
  assert.equal(state.starts.length, 0, `${label}: and nothing was sent`);

  // A refusal: the host's words under the button, which stays.
  const REFUSAL = "The plan changed since you looked: it is at revision 3 and you pressed Start on revision 2.";
  state.onStart = () => ({ error: REFUSAL });
  await page.waitForTimeout(800);
  await start.click();
  await page.locator(".cplan-refusal").waitFor();
  out.refused = { words: (await page.locator(".cplan-refusal").textContent())?.trim(), button: (await start.textContent())?.trim() };
  assert.equal(out.refused.words, REFUSAL, `${label}: the host's words`);
  assert.equal(out.refused.button, "Start", `${label}: the button is left`);
  assert.equal(await start.getAttribute("aria-disabled"), null, `${label}: and can be pressed again`);
  assert.deepEqual(Object.keys(state.starts[0]).sort(), ["chatId", "revision", "start"], `${label}: what a Start carries`);
  assert.equal(state.starts[0].chatId, "main", `${label}: for this chat`);
  assert.equal(state.starts[0].revision, decided.revision, `${label}: the revision on screen`);
  assert.equal(typeof state.starts[0].start?.cwd, "string", `${label}: with the settings the chat would start with`);
  await page.screenshot({ path: join(artifacts, `${label}-refused.png`) });

  // Recorded, and the agent was not told: both halves, one control.
  const WHY = "The profile folder /Volumes/work/octiq is not available right now.";
  const untold = { ...decided, awaitsStart: false, started: { at: 1791886010700, revision: decided.revision, turnId: "octiq-plan-start-1", told: false } };
  state.onStart = () => ({ plan: untold, turnId: "octiq-plan-start-1", delivered: false, notDelivered: WHY });
  await start.click();
  await page.locator(".cplan-foot[data-kind='tell']").waitFor();
  const tell = await readPanel(page);
  out.untold = { foot: tell.foot, state: tell.state, button: tell.start?.label };
  assert.match(tell.foot, /^Started .+ · the agent has not been told yet Tell the agent Why$/, `${label}: both halves, apart`);
  assert.equal(tell.start.label, "Tell the agent", `${label}: one control`);
  assert.equal(await page.locator(".cplan-refusal").isVisible(), false, `${label}: the reason is behind its disclosure`);
  await page.locator(".cplan-why").click();
  assert.equal((await page.locator(".cplan-refusal").textContent())?.trim(), WHY, `${label}: and is the host's sentence`);
  assert.equal(await noSidewaysScroll(page), true, `${label}: no sideways scroll`);
  await page.screenshot({ path: join(artifacts, `${label}-not-told.png`) });

  // The same command again, and the agent has its turn: Started, and no button.
  const told = { ...untold, started: { ...untold.started, turnId: "octiq-plan-start-2", told: true } };
  state.onStart = () => ({ plan: told, turnId: "octiq-plan-start-2", delivered: true, state: "started" });
  await page.waitForTimeout(800);
  await page.locator(".cplan-start").click();
  await page.locator(".cplan-foot[data-kind='started']").waitFor();
  const done = await readPanel(page);
  out.started = { foot: done.foot, state: done.state, sent: state.starts.length, revisions: state.starts.map((each) => each.revision) };
  assert.match(done.foot, /^Started \S.*$/, `${label}: Started and the time`);
  assert.equal(done.start, null, `${label}: no button is left`);
  assert.match(done.state, /^Started /, `${label}: the header says so too`);
  assert.equal(state.starts.length, 3, `${label}: three presses, three commands, none twice`);
  await page.screenshot({ path: join(artifacts, `${label}-started.png`) });
  await context.close();
}

/** A Start the host has not answered, with the panel shut and opened again
 *  (review 3, H2). The control is drawn anew each time the panel opens, so
 *  what is out cannot be its own to remember: shut on a Start not yet
 *  answered and opened again, it used to be on, and a press sent the same
 *  Start twice. The same for `Tell the agent`, which is the same command. */
async function flightScene(browser, size) {
  for (const kind of ["start", "tell"]) {
    const label = `${tag}-${size.name}-flight-${kind}`;
    const out = ((report.scenes.flight ??= {})[size.name] ??= {})[kind] = {};
    const decided = await plan("decided");
    const untold = { ...decided, awaitsStart: false, started: { at: 1791886010700, revision: decided.revision, turnId: "octiq-plan-start-1", told: false } };
    const state = fresh(kind === "tell" ? untold : decided);
    state.onStart = () => ({ hold: true });
    const { context, page } = await open(browser, state, size);
    await openPlan(page);
    const start = page.locator(".cplan-start");
    await start.waitFor();
    assert.equal((await start.textContent())?.trim(), kind === "tell" ? "Tell the agent" : "Start", `${label}: the control`);
    await page.waitForTimeout(800);
    await start.click();
    await page.waitForFunction(() => document.querySelector(".cplan-start")?.getAttribute("aria-disabled") === "true");
    assert.equal(state.starts.length, 1, `${label}: one command`);
    out.sending = (await page.locator(".cplan-foot-side").textContent())?.trim();
    assert.equal(out.sending, "Sending…", `${label}: and it says it is out`);

    // Shut and opened again, twice: a new control each time, still off, and
    // a press on it sends nothing.
    out.reopened = [];
    for (let round = 0; round < 2; round++) {
      await page.locator(".cplan-close").click();
      await panel(page).waitFor({ state: "detached" });
      await page.waitForTimeout(800);
      await openPlan(page);
      await start.waitFor();
      await page.waitForTimeout(800);
      out.reopened.push(await start.getAttribute("aria-disabled"));
      const box = await start.boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await start.evaluate((button) => { button.focus(); });
      await page.keyboard.press("Enter");
      await page.waitForTimeout(200);
    }
    assert.deepEqual(out.reopened, ["true", "true"], `${label}: drawn again, the control is still off`);
    assert.equal(state.starts.length, 1, `${label}: and no press on it sends a second command`);
    await page.screenshot({ path: join(artifacts, `${label}-out.png`) });

    // A refusal that arrives while the panel is shut is still said: the
    // sender keeps the host's words, not the control that asked.
    await page.locator(".cplan-close").click();
    await panel(page).waitFor({ state: "detached" });
    const REFUSAL = "The plan changed since you looked: it is at revision 3 and you pressed Start on revision 2.";
    state.release({ error: REFUSAL });
    await page.waitForTimeout(400);
    await openPlan(page);
    await start.waitFor();
    await page.waitForFunction(() => document.querySelector(".cplan-start")?.getAttribute("aria-disabled") !== "true");
    if (kind === "tell") await page.locator(".cplan-why").click();
    out.said = (await page.locator(".cplan-refusal").textContent())?.trim();
    assert.equal(out.said, REFUSAL, `${label}: the host's answer is said in the panel that was opened afterwards`);

    // Answered, the next press is a new command, and one only.
    const told = { ...untold, started: { ...untold.started, told: true } };
    state.onStart = () => ({ plan: told, turnId: "octiq-plan-start-1", delivered: true, state: "started" });
    await page.waitForTimeout(800);
    await start.click();
    await page.locator(".cplan-foot[data-kind='started']").waitFor();
    out.sent = state.starts.length;
    assert.equal(state.starts.length, 2, `${label}: two presses that were the person's own, two commands`);
    await context.close();
  }
}

/** A started plan beside the ledger of its tasks: the accent, and the way
 *  to a task's row in the run panel. */
async function linkedScene(browser, size) {
  const label = `${tag}-${size.name}-linked`;
  const out = (report.scenes.linked ??= {})[size.name] = {};
  const started = await plan("started");
  const ledger = await linkedLedger(started);
  const state = fresh(started, ledger);
  const { context, page } = await open(browser, state, size);
  const colours = await (await page.locator(".actionbar").first().waitFor(), probes(page));
  await openPlan(page);
  await page.waitForFunction(() => document.querySelector(".cplan-item[data-mark='live']"));
  const read = await readPanel(page);
  const live = read.items.filter((item) => item.mark === "live");
  out.live = live.map((item) => item.title);
  assert.deepEqual(out.live, ["Action bar and usage row"], `${label}: the accent is on the one item with a turn in flight`);
  assert.equal(live[0].markBorder, colours["--accent"], `${label}: as the accent`);
  for (const item of read.items.filter((each) => each.mark !== "live")) assert.notEqual(item.markBorder, colours["--accent"], `${label}: ${item.title} is not`);
  // The agent's "done" that the count contradicts is not the ok colour.
  assert.equal(read.items[0].mark, "quiet", `${label}: done by the agent's word alone is grey`);
  assert.notEqual(read.items[0].markBorder, colours["--ok"], `${label}: and not the ok colour`);
  assert.equal(read.items[0].progress, "1/2 1 failed", `${label}: the host's count is beside it`);
  await page.screenshot({ path: join(artifacts, `${label}.png`) });

  // The item's tasks, and the way to one's row.
  const item = page.locator(".cplan-item").filter({ hasText: "Action bar and usage row" });
  await item.locator(".cplan-progress").click();
  const task = item.locator("button.cplan-task").first();
  await task.waitFor();
  out.tasks = await item.locator(".cplan-task").evaluateAll((rows) => rows.map((row) => [...row.querySelectorAll("span")].map((part) => part.textContent.trim()).join(" ")));
  assert.deepEqual(out.tasks, ["Running Action bar", "Waiting Usage row"], `${label}: its tasks, as the host says they stand`);
  assert.equal(await item.locator(".cplan-task-word[data-live]").evaluate((el) => getComputedStyle(el).color), colours["--accent"], `${label}: the task with the turn is the accent`);
  await page.screenshot({ path: join(artifacts, `${label}-tasks.png`) });
  await page.waitForTimeout(800);
  await task.click();
  const wanted = started.items[1].tasks[0];
  await page.waitForFunction((id) => document.activeElement?.closest("[data-task-id]")?.getAttribute("data-task-id") === id, wanted, { timeout: 10_000 });
  out.opened = await page.evaluate(() => ({
    row: document.activeElement?.closest("[data-task-id]")?.querySelector(".orch-task-title")?.textContent ?? null,
    plan: !!document.querySelector(".cplan-panel"),
  }));
  assert.equal(out.opened.row, "Action bar", `${label}: the run panel is opened at that task's row`);
  assert.equal(out.opened.plan, !size.phone, `${label}: the plan stays beside it on a desktop, and gives its place on a phone`);
  assert.equal(await noSidewaysScroll(page), true, `${label}: no sideways scroll`);
  await page.screenshot({ path: join(artifacts, `${label}-run-panel.png`) });
  await context.close();

  // A worker's chat keeps no plan: no button, and the plan is not read.
  const worker = fresh(started, ledger);
  const workerChat = ledger.attempts[0].workerChatKey.replace(/^chat:/, "");
  const second = await open(browser, worker, size, workerChat);
  await second.page.locator(".actionbar").first().waitFor();
  await second.page.waitForTimeout(1_500);
  out.worker = { button: await second.page.locator(".cplan-toggle").count(), reads: worker.reads.length };
  assert.deepEqual(out.worker, { button: 0, reads: 0 }, `${label}: a worker's chat has no Plan button and reads no plan`);
  await second.context.close();
}

/** An event from the host moves the button's count with no read. */
async function eventScene(browser, size) {
  const label = `${tag}-${size.name}-event`;
  const state = fresh(await plan("discussing"));
  const { context, page, say } = await open(browser, state, size);
  await page.locator(".cplan-toggle-open").first().waitFor();
  const reads = state.reads.length;
  say("chat-plan", { chatId: "main", plan: await plan("decided") });
  await page.locator(".cplan-toggle-open").first().waitFor({ state: "detached" });
  say("chat-plan", { chatId: "another", plan: { ...(await plan("discussing")), chatId: "another" } });
  await page.waitForTimeout(400);
  assert.equal(await page.locator(".cplan-toggle-open").count(), 0, `${label}: another chat's plan is not this one's`);
  assert.equal(state.reads.length, reads, `${label}: nothing was read again for the event`);
  (report.scenes.event ??= {})[size.name] = { reads };
  await context.close();
}

const SCENES = {
  none: { count: null, state: null, none: /^No plan yet The agent keeps one when you ask it to plan\./, items: 0, foot: null, start: null },
  discussing: {
    count: "3", state: /^Not started$/, items: 2, foot: "Start 3 questions still open", start: "Start",
    // The note opens by a press, and opening it moves nothing sideways.
    more: async ({ page, label, out }) => {
      const before = await page.locator(".cplan-item").first().evaluate((item) => item.getBoundingClientRect().width);
      const note = page.locator(".cplan-more", { hasText: "Note" }).first();
      await note.click();
      assert.equal(await page.locator(".cplan-note").first().isVisible(), true, `${label}: the note opens by a press`);
      const after = await page.locator(".cplan-item").first().evaluate((item) => item.getBoundingClientRect().width);
      out.widths = { before, after };
      assert.equal(after, before, `${label}: opening it does not make the rows narrower`);
    },
  },
  decided: { count: null, state: /^Not started$/, items: 2, foot: "Start", start: "Start" },
  started: { count: "2", state: /^Started /, items: 7, footMatch: /^Started \S/, start: null },
};

let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(classic ? { ignoreDefaultArgs: ["--hide-scrollbars"], args: ["--disable-features=OverlayScrollbar"] } : {}),
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  const only = process.env.SCENE;
  for (const size of SIZES) {
    for (const [name, expect] of Object.entries(SCENES)) if (!only || only === name) await fixtureScene(browser, name, size, expect);
    if (!only || only === "start") await startScene(browser, size);
    if (!only || only === "flight") await flightScene(browser, size);
    if (!only || only === "linked") await linkedScene(browser, size);
    if (!only || only === "event") await eventScene(browser, size);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, mockedBackend: true, ...report }, null, 1));
} catch (error) {
  const page = browser?.contexts().at(-1)?.pages().at(-1);
  await page?.screenshot({ path: join(artifacts, `${tag}-failure.png`), fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ error: String(error), errors, report }, null, 1));
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
