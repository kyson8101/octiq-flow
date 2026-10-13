// App-shell check of the composer's row at the widths a chat column really
// has: no control is drawn outside the composer, and what the agent's chat
// runs at can be read whole without a hover.
//
//   * an ordinary chat between the run column and the git column on a
//     desktop (about 340px on a 1280px window): the pickers fold behind one
//     button by the row's own measured width, Send stays inside, and the
//     pickers come back when the column closes; the window is then walked
//     down to the desktop's narrowest;
//   * an agent's chat: the settings text is cut before the name, its access
//     is the last part to go, and a press, a tap or Enter shows the three
//     values whole in a read-only sheet (Escape and a press outside shut it);
//   * the sheet the folded button opens on a wide window is a card, inside
//     the window.
//
// The socket is mocked; everything else is the real App, composer and CSS.
//
//   OCTIQ_THEME=light|dark|fun|manga|guofeng   the appearance mode (dark)
//   WIDE_FONT=1   a wider font, standing in for a Windows fallback
//   CLASSIC_SCROLLBARS=1   Chromium's 15px classic scrollbars, as on Windows
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
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
const shotsOnly = process.env.SHOTS_ONLY === "1";
const wideFont = process.env.WIDE_FONT === "1";
const classic = process.env.CLASSIC_SCROLLBARS === "1";
const theme = process.env.OCTIQ_THEME || "dark";
const artifacts = process.env.OCTIQ_EVIDENCE_DIR || await mkdtemp(join(tmpdir(), "octiq-composer-fit-"));
await mkdir(artifacts, { recursive: true });
const tag = [theme, wideFont && "wide", classic && "classic"].filter(Boolean).join("-");

const now = Date.now();
const root = "/Users/kyson/03-projects/octiq-flow";
const head = {
  id: "head", name: "Potato Juice", role: "Lead", agent: "claude", model: "opus",
  effort: "high", access: "read", projectId: "octiq", createdAt: now - 900_000, updatedAt: now - 900_000,
};
const main = {
  id: "main", projectId: "octiq", title: "Fit the composer in a narrow chat column", customTitle: true, modelId: "claude:opus", access: "read", effort: "high",
  sessionId: "session-main", cwd: root, createdAt: now - 500_000, updatedAt: now - 1_000, coordinatesRun: true,
};
const chats = [main];
const localChats = chats.map((chat) => ({ ...chat, messages: [{ id: "m1", role: "assistant", streaming: false, blocks: [{ kind: "text", text: "Ready." }] }] }));
const task = (id, status) => ({
  id, runId: "run-1", title: `Task ${id}`, spec: "Do the thing.", dependsOn: [], status,
  destination: { projectId: "octiq", projectName: "OctiqFlow", repository: root }, heldByPlan: false,
  createdAt: now - 400_000, updatedAt: now - 20_000,
});
const snapshot = {
  runs: [{
    id: "run-1", coordinatorChatKey: "chat:main", objective: main.title, workspaceId: "octiq", rootPath: root,
    status: "running", maxConcurrent: 2, createdAt: now - 450_000, updatedAt: now - 20_000,
    planApproval: { status: "approved", requestedAt: now - 440_000, decidedAt: now - 430_000 },
  }],
  tasks: [task("a", "completed"), task("b", "ready")],
  attempts: [], gates: [], messages: [], notifications: [],
};

function resultFor(request) {
  switch (request.cmd) {
    case "list_workspaces": return [{ id: "octiq", name: "octiq-flow", primary_path: root }];
    case "chat_index_list": return chats;
    case "chat_index_deleted": return [];
    case "chat_page": return { events: [], context: [], before: null };
    case "chat_list": case "chat_activity": case "permission_pending": case "question_pending":
    case "safety_block_pending": case "pr_repositories": case "codex_skills": case "image_preview_list":
      return [];
    case "team_list": return [head];
    case "team_head": return head;
    case "team_leads": return [{ chatKey: "chat:main", leadId: head.id, leadName: head.name, projectId: "octiq", crossProject: false, createdAt: now - 500_000 }];
    case "team_home": return "octiq";
    case "chat_queue_state": return { live: false, queuedTurnIds: [] };
    case "orchestration_snapshot": return snapshot;
    case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
    case "usage_summary": return {};
    case "agent_models": return { source: "mock", models: [] };
    case "agent_installs": return [{ id: "claude", installed: true, path: "/mock/claude" }];
    case "pr_local_list": case "pr_remote_list": return { items: [], warnings: [] };
    case "agent_avatar_status": return { available: false, reason: "Not signed in to Codex." };
    case "sandbox_snapshot": return { defaultEnabled: false, environments: {} };
    case "git_status_summary": return [{ path: root, repo_root: root, is_repo: true, branch: "develop", changed: 0, ahead: 0, behind: 0 }];
    case "git_local_branches": return { is_repo: true, current: "develop", branches: ["develop"], is_worktree: false };
    case "chat_task": return { chatId: request.args?.chatId, projectId: "octiq" };
    default: return null;
  }
}

const server = await createServer({
  root: webRoot,
  configFile: join(webRoot, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  ...(process.env.OCTIQ_WEB_ROOT ? { cacheDir: join(artifacts, ".vite") } : {}),
});
const errors = [];
const report = { artifacts, theme, wideFont, classic, shotsOnly, scenes: {} };

async function open(browser, { width, height, phone = false, agents, git = false }) {
  const context = await browser.newContext({
    viewport: { width, height }, reducedMotion: "reduce",
    ...(phone ? { hasTouch: true, isMobile: true } : {}),
  });
  await context.addInitScript(({ stored, mode, wide, agentsMode, gitColumn }) => {
    localStorage.setItem("octiq.agentsMode", agentsMode ? "on" : "off");
    localStorage.setItem("octiq.v2.gitColumn", gitColumn ? "1" : "0");
    localStorage.setItem("octiq.theme", mode);
    localStorage.setItem("octiq.v2.theme", mode);
    localStorage.setItem("octiq.v2.conversations", JSON.stringify(stored));
    if (wide) addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = "*, *::before, *::after { font-family: Verdana, sans-serif !important; letter-spacing: 0.02em !important; }";
      document.head.append(style);
    });
  }, { stored: localChats, mode: theme, wide: wideFont, agentsMode: agents, gitColumn: git });
  await context.route("**/token", (route) => route.fulfill({ body: "mock-token" }));
  await context.route("**/auth", (route) => route.fulfill({ body: "ok" }));
  await context.routeWebSocket(/.*/, (socket) => socket.onMessage((raw) => {
    const request = JSON.parse(String(raw));
    if (request.t !== "invoke") return;
    socket.send(JSON.stringify({ t: "reply", id: request.id, ok: true, result: resultFor(request) }));
  }));
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  page.on("pageerror", (error) => errors.push(error.stack ?? String(error)));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/#/p/octiq-flow/c/main`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  await page.locator(".composer-row").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(900);
  return { context, page };
}

/** The composer as drawn: its box, the chat column it is in, and every
 *  control of it that is on screen, with how far each reaches past the box. */
const composer = (page) => page.evaluate(() => {
  const rect = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
  const box = rect(document.querySelector(".composer-box"));
  const row = document.querySelector(".composer-row");
  const controls = [...document.querySelectorAll(".composer button, .composer textarea, .composer .composer-identity, .composer select, .composer input")]
    .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; })
    .map((el) => {
      const r = rect(el);
      return { what: (el.getAttribute("aria-label") || el.getAttribute("title") || el.className || el.tagName).toString().split("\n")[0].slice(0, 48), l: Math.round(r.l), r: Math.round(r.r), past: Math.max(0, r.r - box.r, box.l - r.l) };
    });
  const send = document.querySelector(".composer .send");
  return {
    window: innerWidth,
    chat: Math.round(rect(document.querySelector(".composer")).w),
    box: { l: Math.round(box.l), r: Math.round(box.r), w: Math.round(box.w) },
    row: { client: row.clientWidth, scroll: row.scrollWidth, tight: row.classList.contains("is-tight") },
    pickers: !!document.querySelector(".composer .model-trigger:not(.settings-toggle)")?.getBoundingClientRect().width,
    toggle: !!document.querySelector(".composer .settings-toggle")?.getBoundingClientRect().width,
    send: send ? { r: Math.round(rect(send).r), w: Math.round(rect(send).w) } : null,
    outside: controls.filter((control) => control.past > 0.5),
    sideways: document.documentElement.scrollWidth > innerWidth,
  };
});

/** The agent's chip: what of its settings text can be seen. */
const chip = (page) => page.evaluate(() => {
  const el = document.querySelector(".composer-identity");
  if (!el) return null;
  const whole = (node) => !!node && node.getBoundingClientRect().width > 0 && node.scrollWidth <= node.clientWidth;
  const name = el.querySelector(".composer-identity-name");
  const rest = el.querySelector(".composer-identity-rest");
  const access = el.querySelector(".composer-identity-access");
  const button = el.querySelector(".composer-identity-runs");
  return {
    width: Math.round(el.getBoundingClientRect().width),
    name: name?.textContent, nameWhole: whole(name),
    rest: rest?.textContent ?? null, restWhole: whole(rest), restWidth: Math.round(rest?.getBoundingClientRect().width ?? 0),
    access: access?.textContent ?? null, accessWhole: whole(access),
    label: button?.getAttribute("aria-label") ?? null, expanded: button?.getAttribute("aria-expanded") ?? null,
    title: el.getAttribute("title"),
  };
});

const sheetText = (page) => page.locator(".composer-identity-sheet").evaluate((el) => {
  const r = el.getBoundingClientRect();
  return { text: el.innerText.replace(/\s+/g, " ").trim(), inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, controls: el.querySelectorAll("button, input, select, a").length };
});

/** An ordinary chat between the run column and the git column. */
async function ordinary(browser, out) {
  const { context, page } = await open(browser, { width: 1280, height: 860, agents: false, git: true });
  const label = `${tag}-ordinary`;
  await page.locator(".orch-embedded, .orch-layout").first().waitFor({ state: "attached" }).catch(() => {});
  const first = await composer(page);
  out.at1280 = first;
  await page.screenshot({ path: join(artifacts, `${label}-1280.png`) });
  if (shotsOnly) { await context.close(); return; }
  assert(first.chat < 480, `${label}: the chat is a narrow column beside the run panel and the git column (${first.chat})`);
  assert.deepEqual(first.outside, [], `${label}: no control is drawn outside the composer at ${first.chat}px`);
  assert(first.send.r <= first.box.r, `${label}: Send is inside the composer (${first.send.r} of ${first.box.r})`);
  assert.equal(first.row.tight, true, `${label}: the pickers fold by the row's own width`);
  assert.equal(first.pickers, false, `${label}: the three pickers are not drawn`);
  assert.equal(first.toggle, true, `${label}: one button stands for them`);
  assert.equal(first.sideways, false);

  // The sheet that button opens: a card inside the window, not a band across it.
  await page.locator(".composer .settings-toggle").click();
  const sheet = page.locator(".sheet.settings-sheet");
  await sheet.waitFor();
  const card = await sheet.evaluate((el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, w: r.width, b: Math.round(innerHeight - r.bottom) }; });
  out.sheet = card;
  assert(card.w <= 440.5 && card.l >= 0 && card.r <= 1280, `${label}: the settings sheet is a card on a wide window (${card.w})`);
  assert.equal(card.b, 0, `${label}: at the foot of the window`);
  await page.screenshot({ path: join(artifacts, `${label}-sheet.png`) });
  await page.locator(".sheet-scrim").click({ position: { x: 5, y: 5 } });
  await sheet.waitFor({ state: "detached" });

  // Walked down to the narrowest desktop: nothing is ever outside.
  out.widths = [];
  for (const width of [1280, 1200, 1120, 1040, 960, 900, 861]) {
    await page.setViewportSize({ width, height: 860 });
    await page.waitForTimeout(350);
    const at = await composer(page);
    out.widths.push({ window: width, chat: at.chat, box: at.box.w, tight: at.row.tight, outside: at.outside.length });
    assert.deepEqual(at.outside, [], `${label}: nothing outside the composer in a ${at.chat}px chat (window ${width})`);
    assert(at.send.r <= at.box.r, `${label}: Send inside at window ${width}`);
    assert.equal(at.sideways, false, `${label}: no sideways scroll at window ${width}`);
  }
  out.narrowestChat = Math.min(...out.widths.map((item) => item.chat));
  await page.screenshot({ path: join(artifacts, `${label}-861.png`) });

  // The column put away: the pickers come back, by the same measure.
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.getByRole("button", { name: /git/i }).first().click();
  await page.waitForTimeout(700);
  const closed = await composer(page);
  out.gitClosed = { chat: closed.chat, row: closed.row.client, holds: closed.row.scroll, tight: closed.row.tight, pickers: closed.pickers };
  assert(closed.chat > first.chat + 100, `${label}: the chat has its room back (${closed.chat})`);
  // A wider font may still not fit them in this column: then they stay
  // folded, and what is asserted is that nothing is outside either way.
  if (!wideFont) {
    assert.equal(closed.row.tight, false, `${label}: with room again the pickers come back`);
    assert.equal(closed.pickers, true);
  }
  assert.equal(closed.pickers, !closed.row.tight);
  assert.deepEqual(closed.outside, []);
  await context.close();
}

/** An agent's chat: the chip and what it runs at. */
async function agent(browser, out, size) {
  const { context, page } = await open(browser, { ...size, agents: true, git: !size.phone });
  const label = `${tag}-agent-${size.width}`;
  await page.locator(".composer-identity").waitFor();
  const fit = await composer(page);
  const drawn = await chip(page);
  out.composer = { chat: fit.chat, box: fit.box.w, outside: fit.outside };
  out.chip = drawn;
  await page.screenshot({ path: join(artifacts, `${label}.png`) });
  if (shotsOnly) { await context.close(); return; }
  assert.deepEqual(fit.outside, [], `${label}: no control is drawn outside the composer`);
  // The run column beside the chat (300px here, with the side column open)
  // does not scroll sideways, and nothing of a run is cut off at its edge:
  // a run's accordion was as wide as its widest content wanted, which put a
  // horizontal scrollbar on the panel (seen on Windows, where it takes room).
  if (!size.phone) {
    const run = await page.evaluate(() => {
      const scroller = document.querySelector(".orch-content");
      if (!scroller) return null;
      const cut = [];
      for (const accordion of scroller.querySelectorAll(".orch-run-accordion")) {
        const edge = accordion.getBoundingClientRect().right;
        for (const el of accordion.querySelectorAll("*")) {
          // The tab row scrolls sideways by design, with no scrollbar.
          if (el.closest(".orch-tabs")) continue;
          const box = el.getBoundingClientRect();
          if (box.width && box.right > edge + 0.5) cut.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}`);
        }
      }
      return { client: scroller.clientWidth, scroll: scroller.scrollWidth, cut };
    });
    out.runColumn = run;
    assert(run, `${label}: the run column is drawn`);
    assert(run.scroll <= run.client, `${label}: the run column does not scroll sideways (${run.scroll} in ${run.client})`);
    assert.deepEqual(run.cut, [], `${label}: nothing of a run is cut at the column's edge`);
  }
  assert.equal(drawn.name, "Potato Juice");
  assert.equal(drawn.nameWhole, true, `${label}: the name is whole`);
  assert.equal(`${drawn.rest}${drawn.access}`, "opus latest · high · Plan", `${label}: the session's three values are the text`);
  // The access is the last part to go: it is whole while anything of the
  // model and the effort is still drawn, and is cut only once they are gone
  // (a 320px phone, where the name itself has the row's last room).
  if (size.accessWhole !== false) assert.equal(drawn.accessWhole, true, `${label}: the access is drawn whole (${JSON.stringify(drawn)})`);
  if (!drawn.accessWhole) assert.equal(drawn.restWidth, 0, `${label}: the access is cut only after the model and the effort are gone`);
  out.cut = drawn.restWhole ? "nothing" : drawn.accessWhole ? "the model and the effort are cut, the access is not" : "the model and the effort are gone, the access is cut";
  assert.equal(drawn.label, "What this chat runs at: opus latest · high · Plan", `${label}: its name carries the three values`);
  assert.match(drawn.title, /\nThis chat runs at opus latest · high · Plan/, `${label}: the tooltip carries the session's effort and access`);

  // A press on the chip (a tap on a phone), anywhere on it: the sheet.
  // Aimed at the middle of the NAME: the button's target is the whole chip,
  // so there is something to press however little of the text is left.
  const spot = await page.locator(".composer-identity-name").evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.className, spot), "composer-identity-runs", `${label}: a press on the name reaches the disclosure`);
  if (size.phone) await page.touchscreen.tap(spot.x, spot.y); else await page.mouse.click(spot.x, spot.y);
  const sheet = page.locator(".composer-identity-sheet");
  await sheet.waitFor();
  const shown = await sheetText(page);
  out.sheet = shown;
  assert.match(shown.text, /^Model Opus latest Effort High Access Plan /, `${label}: the sheet has the three values whole (${shown.text})`);
  assert.equal(shown.controls, 0, `${label}: and no control: it is read-only`);
  assert.equal(shown.inside, true, `${label}: inside the window`);
  assert.equal((await chip(page)).expanded, "true");
  await page.screenshot({ path: join(artifacts, `${label}-sheet.png`) });
  // A press outside shuts it.
  await page.locator(".picker-scrim").click({ position: { x: 4, y: 4 } });
  await sheet.waitFor({ state: "detached" });
  // The keyboard: Enter opens it, Escape shuts it, and the focus stays.
  const button = page.locator(".composer-identity-runs");
  await button.focus();
  await page.keyboard.press("Enter");
  await sheet.waitFor();
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "detached" });
  assert.equal(await button.evaluate((el) => el === document.activeElement), true, `${label}: the focus stays on the chip`);
  assert.equal(await page.locator(".composer textarea").count(), 1);
  await context.close();
}

let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(classic ? { ignoreDefaultArgs: ["--hide-scrollbars"], args: ["--disable-features=OverlayScrollbar"] } : {}),
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  await ordinary(browser, report.scenes.ordinary = {});
  await agent(browser, report.scenes.agent1280 = {}, { width: 1280, height: 860 });
  await agent(browser, report.scenes.agent390 = {}, { width: 390, height: 844, phone: true });
  await agent(browser, report.scenes.agent320 = {}, { width: 320, height: 720, phone: true, accessWhole: false });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: !shotsOnly, mockedBackend: true, ...report }, null, 1));
} catch (error) {
  const page = browser?.contexts().at(-1)?.pages().at(-1);
  await page?.screenshot({ path: join(artifacts, `${tag}-failure.png`), fullPage: true }).catch(() => {});
  console.log(JSON.stringify({ ...report, errors }, null, 1));
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
