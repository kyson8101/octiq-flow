// Draws the real App in one appearance mode, at 1280 and at 390, for the
// screens a mode has to get right: a chat with a reply, a permission card and
// a question waiting on the person, the run panel beside the chat, the
// terminal, Settings' appearance tiles and the empty page. It also checks what
// a mode must never break: the phone keeps the phone's layout, nothing scrolls
// the page sideways, and the action bar keeps its height (36px, 45px on a
// phone). And what a mode must never do to an answer to a question: the
// permission card's and the Complete question's leading answer keep the
// decision colour (its edge, its tint or its fill), never the accent, and no
// answer at rest or under the pointer is drawn orange-gold (`answers`).
// In Cyberpunk, whose accent means a turn in flight, it also Tabs through the
// chat page, chat search and Settings' appearance (`focusScenes`): no focus
// cue may be drawn in the accent, and what is in flight inside a focused
// control must keep it.
//
// The socket is mocked; everything else is the real App and its CSS.
//
//   OCTIQ_THEME=light|dark|fun|manga|guofeng|xp|cyberpunk   the mode (xp)
//   OCTIQ_EVIDENCE_DIR   where the screenshots go (a temp folder otherwise)
//   PLAYWRIGHT_MODULE, PLAYWRIGHT_CHANNEL   as the other scripts take them
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
const theme = process.env.OCTIQ_THEME || "xp";
const artifacts = process.env.OCTIQ_EVIDENCE_DIR || await mkdtemp(join(tmpdir(), "octiq-appearance-"));
await mkdir(artifacts, { recursive: true });

const now = Date.now();
const root = "/Users/kyson/03-projects/octiq-flow";
const main = {
  id: "main", projectId: "octiq", title: "Tidy the release notes", customTitle: true, modelId: "claude:opus", access: "auto", effort: "high",
  sessionId: "session-main", cwd: root, createdAt: now - 500_000, updatedAt: now - 1_000, coordinatesRun: true,
};
const other = { ...main, id: "other", title: "Check the Windows build", coordinatesRun: false, updatedAt: now - 90_000 };
const chats = [main, other];

const reply = [
  "Here is what changed in **0.3.11**:",
  "",
  "- The theme picker gained a sixth mode.",
  "- `pnpm test` runs from `web/`, not the repo root.",
  "- A [link to the notes](https://example.com) and a warning are left as they were.",
  "",
  "```ts",
  "export const XP_MODE = \"xp\";",
  "applyTheme(XP_MODE); // 42",
  "```",
  "",
  "> A quote, set apart from the reply.",
].join("\n");
const record = [
  { type: "user", uuid: "u-1", octiq_user_turn: true, message: { content: [{ type: "text", text: "Summarise what changed in the last release." }] } },
  { type: "assistant", message: { id: "msg-1", role: "assistant", content: [{ type: "text", text: reply }] } },
  { type: "result", subtype: "success", is_error: false, result: reply },
].map((event, at) => ({ seq: at + 1, event }));

const task = (id, title, status, extra = {}) => ({
  id, runId: "run-1", title, spec: "Do the thing.", dependsOn: [], status,
  destination: { projectId: "octiq", projectName: "OctiqFlow", repository: root }, heldByPlan: false,
  createdAt: now - 400_000, updatedAt: now - 20_000, ...extra,
});
const snapshot = {
  runs: [{
    id: "run-1", coordinatorChatKey: "chat:main", objective: main.title, workspaceId: "octiq", rootPath: root,
    status: "running", maxConcurrent: 2, createdAt: now - 450_000, updatedAt: now - 20_000,
    planApproval: { status: "approved", requestedAt: now - 440_000, decidedAt: now - 430_000 },
  }],
  tasks: [
    task("a", "Draft the notes", "completed", { verdict: "pass" }),
    task("b", "Check the links", "running", { activeAttemptId: "att-b" }),
    task("c", "Publish", "ready"),
  ],
  attempts: [{
    id: "att-b", runId: "run-1", taskId: "b", number: 1, workerChatKey: "chat:orch-b", agent: "claude", access: "auto",
    status: "running", cwd: root, branch: "feature/b", isWorktree: true, filesModified: [],
    execution: { state: "executing", retryCount: 0, lastActivityAt: now - 1_000 }, createdAt: now - 60_000, updatedAt: now - 5_000,
  }],
  gates: [], messages: [], notifications: [],
};
const permissions = [{ id: "perm-1", chatKey: "chat:main", toolName: "Bash", toolInput: { command: "pnpm --dir web build" } }];
const questions = [{
  id: "q1", chatKey: "chat:main", batch: "batch-1", batchSize: 1, question: "Which notes should go out first?",
  options: [{ label: "Release notes", description: "What a person reads on the page." }, { label: "Changelog", description: "Every commit, grouped." }],
  recommended: 0,
}];

let ptyId = null;
const ansi = [
  "\x1b[1mkyson@mac\x1b[0m \x1b[34m~/octiq-flow\x1b[0m $ pnpm test\r\n",
  " \x1b[32m✓\x1b[0m src/lib/themes.test.ts \x1b[2m(42 tests)\x1b[0m\r\n",
  " \x1b[33m⚠\x1b[0m one warning \x1b[31m✗ one failure\x1b[0m \x1b[35mmagenta\x1b[0m \x1b[36mcyan\x1b[0m\r\n",
  " \x1b[90mbright black (dim)\x1b[0m \x1b[37mwhite\x1b[0m \x1b[97mbright white\x1b[0m\r\n",
  "$ ",
].join("");

function resultFor(request) {
  switch (request.cmd) {
    case "list_workspaces": return [{ id: "octiq", name: "octiq-flow", primary_path: root }];
    case "chat_index_list": return chats;
    case "chat_index_deleted": return [];
    case "chat_page": return { events: request.args?.key === "chat:main" ? record : [], context: [], before: null };
    case "chat_since": return [];
    case "permission_pending": return permissions;
    case "question_pending": return questions;
    case "chat_list": case "chat_activity": case "safety_block_pending": case "access_request_pending":
    case "pr_repositories": case "codex_skills": case "image_preview_list":
      return [];
    case "team_list": case "team_leads": return [];
    case "chat_queue_state": return { live: false, queuedTurnIds: [] };
    case "orchestration_snapshot": return snapshot;
    case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
    case "usage_summary": return {};
    case "agent_models": return { source: "mock", models: [] };
    case "agent_installs": return [{ id: "claude", installed: true, path: "/mock/claude" }];
    case "pr_local_list": case "pr_remote_list": return { items: [], warnings: [] };
    case "sandbox_snapshot": return { defaultEnabled: false, environments: {} };
    case "git_status_summary": return [{ path: root, repo_root: root, is_repo: true, branch: "develop", changed: 0, ahead: 0, behind: 0 }];
    case "git_local_branches": return { is_repo: true, current: "develop", branches: ["develop"], is_worktree: false };
    case "chat_task": return { chatId: request.args?.chatId, projectId: "octiq" };
    case "pty_spawn": case "pty_attach": ptyId = request.args?.id ?? ptyId; return true;
    default: return null;
  }
}

const server = await createServer({
  root: webRoot,
  configFile: join(webRoot, "vite.config.ts"),
  // `node_modules` may be a link to another checkout's.
  server: { host: "127.0.0.1", port: 0, strictPort: false, fs: { strict: false } },
  ...(process.env.OCTIQ_WEB_ROOT ? { cacheDir: join(artifacts, ".vite") } : {}),
});
const errors = [];
const report = { artifacts, theme, scenes: {} };

async function open(browser, { width, height, phone = false, terminal = false, hash = "#/p/octiq-flow/c/main" }) {
  const context = await browser.newContext({
    viewport: { width, height }, reducedMotion: "reduce", deviceScaleFactor: 1,
    ...(phone ? { hasTouch: true, isMobile: true } : {}),
  });
  await context.addInitScript(({ mode, term }) => {
    localStorage.setItem("octiq.agentsMode", "off");
    localStorage.setItem("octiq.theme", mode);
    localStorage.setItem("octiq.v2.terminalOpen", term ? "1" : "0");
    localStorage.setItem("octiq.v2.gitColumn", "0");
  }, { mode: theme, term: terminal });
  await context.route("**/token", (route) => route.fulfill({ body: "mock-token" }));
  await context.route("**/auth", (route) => route.fulfill({ body: "ok" }));
  await context.routeWebSocket(/.*/, (socket) => socket.onMessage((raw) => {
    const request = JSON.parse(String(raw));
    if (request.t !== "invoke") return;
    socket.send(JSON.stringify({ t: "reply", id: request.id, ok: true, result: resultFor(request) }));
    if ((request.cmd === "pty_spawn" || request.cmd === "pty_attach") && request.args?.id) {
      setTimeout(() => socket.send(JSON.stringify({ t: "event", event: "pty-restore", payload: { id: request.args.id, data: ansi, trimmed: false } })), 200);
    }
  }));
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  page.on("pageerror", (error) => errors.push(error.stack ?? String(error)));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/${hash}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  await page.locator(".composer-row").first().waitFor();
  if (hash.includes("/c/main")) await page.getByText("Here is what changed", { exact: false }).first().waitFor({ state: "attached" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1200);
  return { context, page };
}

/** What a mode must not change about the frame. */
const frame = (page) => page.evaluate(() => {
  const bar = document.querySelector(".actionbar");
  const r = bar?.getBoundingClientRect();
  return {
    theme: document.documentElement.getAttribute("data-theme"),
    sideways: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
    actionBar: r && r.height > 0 ? Math.round(r.height) : null,
    phone: !!document.querySelector(".app.is-mobile, .mobile-sidebar, .app-mobile") || innerWidth < 860,
  };
});


/** An empty conversation with the composer focused and nothing sent: the
 *  box's border and the page's accent (a turn in flight), as RGB through a
 *  1x1 canvas, read once the box's transition has finished. */
const idleFocus = async (page, shot) => {
  await page.locator(".composer textarea").first().focus();
  const look = await page.evaluate(() => new Promise((done) => {
    const box = document.querySelector(".composer-box");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const rgb = (value) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000"; ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
    };
    const wait = () => {
      if (box.getAnimations().length) return requestAnimationFrame(wait);
      const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
      done({ focused: box.matches(":focus-within"), border: rgb(getComputedStyle(box).borderTopColor), accent: rgb(accent) });
    };
    requestAnimationFrame(wait);
  }));
  await page.screenshot({ path: join(artifacts, shot) });
  return look;
};

/** Cyberpunk only: the focus cues of the element that has the focus, read
 *  off the page once nothing round it is moving. For the element and its
 *  ::before and ::after: every outline, border and box-shadow colour that is
 *  the root accent (the cyan of a turn in flight). For each element round
 *  it: what is the accent only while the focus is inside it (a `:focus-within`
 *  frame), found by taking the focus away and giving it back. A danger
 *  answer draws in --danger and is not asked. Answers null for no focus and
 *  `repeat` for an element this walk has had already. */
const focusProbe = (page) => page.evaluate(() => new Promise((done) => {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return done(null);
  window.__focusWalked ??= new Set();
  if (window.__focusWalked.has(el)) return done({ repeat: true });
  window.__focusWalked.add(el);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const rgb = (value) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000"; ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data];
  };
  const accent = rgb(getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
  const isAccent = ([r, g, b, a]) => a > 0 && Math.abs(r - accent[0]) <= 3 && Math.abs(g - accent[1]) <= 3 && Math.abs(b - accent[2]) <= 3;
  const colours = (text) => (text.match(/(rgba?|color|oklab|oklch|lab|lch)\([^()]*\)|#[0-9a-f]{3,8}\b/gi) ?? []).map(rgb);
  /** The cue properties of `node` (or its pseudo-element) drawn in the accent. */
  const cues = (node, pseudo = null) => {
    const s = getComputedStyle(node, pseudo);
    if (pseudo && (s.content === "none" || s.content === "normal" || s.display === "none")) return [];
    const drawn = [];
    if (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) drawn.push(["outline", s.outlineColor]);
    for (const side of ["Top", "Right", "Bottom", "Left"]) {
      if (s[`border${side}Style`] !== "none" && parseFloat(s[`border${side}Width`]) > 0) drawn.push([`border-${side.toLowerCase()}`, s[`border${side}Color`]]);
    }
    if (s.boxShadow !== "none") drawn.push(["box-shadow", s.boxShadow]);
    return [...new Set(drawn.filter(([, text]) => colours(text).some(isAccent)).map(([prop]) => prop))];
  };
  const chain = [];
  for (let node = el.parentElement; node && node !== document.documentElement; node = node.parentElement) chain.push(node);
  const name = (node) => `${node.tagName.toLowerCase()}${node.className && typeof node.className === "string" ? "." + node.className.trim().split(/\s+/).join(".") : ""}${node.getAttribute("aria-label") ? `[${node.getAttribute("aria-label").slice(0, 40)}]` : ""}`;
  /** Waits until no transition runs on the element or round it. */
  const still = (then, started = performance.now(), quiet = 0) => requestAnimationFrame(() => {
    const moving = document.getAnimations().some((a) => a.playState === "running" && typeof CSSTransition !== "undefined" && a instanceof CSSTransition
      && (a.effect?.target === el || chain.includes(a.effect?.target)));
    const next = moving ? 0 : quiet + 1;
    if (next >= 2 || performance.now() - started > 3000) return then();
    still(then, started, next);
  });
  still(() => {
    const visible = el.matches(":focus-visible");
    const own = { self: cues(el), "::before": cues(el, "::before"), "::after": cues(el, "::after") };
    const around = chain.map((node) => cues(node));
    const look = {
      name: name(el), visible,
      danger: el.matches(".is-danger"),
      bad: Object.entries(own).flatMap(([part, props]) => props.map((prop) => `${part} ${prop}`)),
    };
    if (!around.some((props) => props.length)) return done(look);
    // Something round it is the accent: is it only while the focus is in it?
    el.blur();
    still(() => {
      const rest = chain.map((node) => cues(node));
      el.focus({ preventScroll: true });
      chain.forEach((node, at) => {
        for (const prop of around[at]) if (!rest[at].includes(prop)) look.bad.push(`${name(node)}:focus-within ${prop}`);
      });
      still(() => done(look));
    });
  });
}));

/** Tabs through every control from where the focus is until it comes round
 *  again, probing each (above). `shots` names controls to photograph as
 *  the walk reaches them: { selector, frame (what round it is in the
 *  picture), file, pad }. */
async function focusWalk(page, scene, shots = []) {
  await page.mouse.move(0, 0);
  await page.evaluate(() => { window.__focusWalked = new Set(); });
  const walked = [];
  const found = [];
  const shot = new Set();
  for (let step = 0; step < 400; step++) {
    await page.keyboard.press("Tab");
    const look = await focusProbe(page);
    if (!look) continue;
    if (look.repeat) break;
    walked.push(look.name);
    if (look.bad.length && !look.danger) found.push(`${scene}: ${look.name} draws its focus in the accent (${look.bad.join(", ")})`);
    for (const { selector, frame = selector, file, pad = 10 } of shots) {
      if (shot.has(file) || !await page.evaluate((selector) => document.activeElement?.matches(selector), selector)) continue;
      shot.add(file);
      const clip = await page.evaluate(({ frame, pad }) => {
        const r = (document.activeElement.closest(frame) ?? document.activeElement).getBoundingClientRect();
        const x = Math.max(0, r.left - pad), y = Math.max(0, r.top - pad);
        return { x, y, width: Math.min(innerWidth - x, r.width + 2 * pad), height: Math.min(innerHeight - y, r.height + 2 * pad) };
      }, { frame, pad });
      await page.screenshot({ path: join(artifacts, file), clip });
    }
  }
  return { walked: walked.length, names: walked, found, shots: [...shot] };
}

/** How an answer to a question is drawn, read off the page: its colours as
 *  RGB (through a 1x1 canvas, so `color(srgb …)` and `oklab(…)` read alike)
 *  and the decision colour, the accent and the two decision tints as the
 *  same element would compute them. */
const answerLook = (page, selector) => page.evaluate((selector) => {
  const el = document.querySelector(selector);
  if (!el) return null;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const rgb = (value) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000"; ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a];
  };
  const colours = (text) => (text.match(/(rgba?|color|oklab|oklch|lab|lch)\([^()]*\)|#[0-9a-f]{3,8}\b/gi) ?? []).map(rgb);
  const probe = (prop, value) => {
    const span = document.createElement("span");
    span.style[prop] = value;
    el.parentElement.append(span);
    const read = getComputedStyle(span)[prop];
    span.remove();
    return rgb(read);
  };
  const s = getComputedStyle(el);
  return {
    text: el.textContent.trim(),
    background: rgb(s.backgroundColor),
    border: rgb(s.borderTopColor),
    painted: colours(`${s.backgroundImage} ${s.boxShadow} ${s.borderTopColor} ${s.backgroundColor}`),
    shadow: s.boxShadow,
    decide: probe("color", "var(--decide)"),
    accent: probe("color", "var(--accent)"),
    tint18: probe("backgroundColor", "color-mix(in srgb, var(--decide) 18%, var(--bg-1))"),
    tint28: probe("backgroundColor", "color-mix(in srgb, var(--decide) 28%, var(--bg-1))"),
  };
}, selector);

const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 2);
/** Orange-gold, amber: a warm hue with colour in it. */
const orange = ([r, g, b, a]) => {
  if (a < 40) return false;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), chroma = (max - min) / 255;
  if (chroma < 0.2 || max !== r) return false;
  const h = (((g - b) / (max - min)) * 60 + 360) % 360;
  return h >= 15 && h <= 60;
};

/** Waits until the first element `selector` names is in the state asked
 *  (under the pointer, or not) and has finished drawing it: `:hover` says
 *  so, for a hover the element at the pointer is it or inside it, nothing
 *  of it is animating, and its painted colours read the same over two
 *  frames in a row. A wait on a condition, never on a clock: under load a
 *  fixed 250 ms read the 130 ms transition before it had run (review 1b,
 *  H2). Fails with the part that never settled. */
const settled = (page, selector, { hovered, at = null, timeout = 20_000 }) => page.evaluate(({ selector, hovered, at, timeout }) => new Promise((resolve, reject) => {
  const started = performance.now();
  let previous = null;
  let steady = 0;
  const check = () => {
    const el = document.querySelector(selector);
    const why = [];
    if (!el) why.push("the element is not on the page");
    else {
      if (el.matches(":hover") !== hovered) why.push(hovered ? "it does not match :hover" : "it still matches :hover");
      if (hovered && at) {
        const under = document.elementFromPoint(at.x, at.y);
        if (!under || !el.contains(under)) why.push(`the element under the pointer is ${under ? under.tagName.toLowerCase() + (under.className ? "." + String(under.className).trim().replace(/\s+/g, ".") : "") : "nothing"}`);
      }
      const running = el.getAnimations({ subtree: true }).filter((a) => a.playState !== "finished" && a.playState !== "idle");
      if (running.length) why.push(`${running.length} animation(s) still running (${running.map((a) => a.transitionProperty ?? a.animationName ?? a.constructor.name).join(", ")})`);
      const s = getComputedStyle(el);
      const now = [s.backgroundColor, s.backgroundImage, s.borderTopColor, s.boxShadow, s.color].join("|");
      steady = now === previous ? steady + 1 : 0;
      previous = now;
      if (steady < 2) why.push("its colours changed between frames");
    }
    if (!why.length) return resolve();
    if (performance.now() - started > timeout) return reject(new Error(`${selector} never settled ${hovered ? "under the pointer" : "at rest"} in ${timeout} ms: ${why.join("; ")}`));
    requestAnimationFrame(check);
  };
  requestAnimationFrame(check);
}), { selector, hovered, at, timeout });

/** Puts the pointer on the first element `selector` names and waits until
 *  it is drawn hovered. */
async function hoverSettled(page, selector) {
  const button = page.locator(selector).first();
  await button.hover();
  const box = await button.boundingBox();
  await settled(page, selector, { hovered: true, at: { x: box.x + box.width / 2, y: box.y + box.height / 2 } });
}

/** Takes the pointer off everything and waits until `selector` is drawn
 *  at rest. */
async function restSettled(page, selector) {
  await page.mouse.move(0, 0);
  await settled(page, selector, { hovered: false });
}

/** Measures an answer at rest and under the pointer, and checks it. */
async function answer(page, selector, { leading }) {
  const button = page.locator(selector).first();
  await button.scrollIntoViewIfNeeded();
  await restSettled(page, selector);
  const rest = await answerLook(page, selector);
  await hoverSettled(page, selector);
  const hover = await answerLook(page, selector);
  for (const [when, look] of [["at rest", rest], ["under the pointer", hover]]) {
    const where = `${selector} (${look.text}) ${when}`;
    assert.equal(look.painted.some(orange), false, `${where} is drawn orange-gold: ${JSON.stringify(look.painted)}`);
    if (leading) {
      assert.ok(same(look.border, look.decide), `${where}: its edge is not the decision colour`);
      // Manga is monochrome: its decision colour and its accent are both ink.
      if (!same(look.decide, look.accent)) assert.ok(!same(look.background, look.accent), `${where}: its fill is the accent`);
      const tint = when === "at rest" ? look.tint18 : look.tint28;
      assert.ok(same(look.background, tint) || same(look.background, look.decide), `${where}: its fill is not the decision colour (${look.background} vs ${tint})`);
    } else if (theme === "xp" && when === "under the pointer") {
      assert.ok(look.painted.some((c) => same(c, look.decide)), `${where}: not rimmed in the decision colour`);
    }
  }
  return { rest, hover };
}

async function desktop(browser, out) {
  const { context, page } = await open(browser, { width: 1280, height: 860 });
  out.frame = await frame(page);
  // Something to send, so Send is drawn enabled.
  await page.locator(".composer textarea").first().fill("Ship it");
  // Up to the reply, so it is on screen beside the cards.
  await page.mouse.move(990, 300);
  await page.mouse.wheel(0, -2000);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(artifacts, `${theme}-1280-chat.png`) });
  // The permission card unfolded, so its parts can be seen.
  const fold = page.locator(".permission-card .card-fold-toggle, .permission-card [aria-expanded]").first();
  if (await fold.count()) { await fold.click().catch(() => {}); await page.waitForTimeout(300); }
  await page.screenshot({ path: join(artifacts, `${theme}-1280-cards.png`) });
  out.permission = {
    leading: await answer(page, ".permission-card .ask-card-actions .ask-btn.is-primary", { leading: true }),
    other: await answer(page, ".permission-card .ask-card-actions .ask-btn:not(.is-primary):not(.is-quiet)", { leading: false }),
  };
  await page.screenshot({ path: join(artifacts, `${theme}-1280-permission-hover.png`), clip: await page.locator(".permission-card").first().evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.left - 8, y: r.top - 8, width: r.width + 16, height: r.height + 16 }; }) });
  // The Complete question: the person's own decision, from the action bar.
  await page.locator(".complete-chat").first().click();
  await page.locator(".complete-ask").waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(artifacts, `${theme}-1280-complete.png`) });
  out.complete = {
    leading: await answer(page, ".complete-ask .ask-btn.is-primary", { leading: true }),
    other: await answer(page, ".complete-ask .ask-btn:not(.is-primary)", { leading: false }),
  };
  await hoverSettled(page, ".complete-ask .ask-btn.is-primary");
  await page.screenshot({ path: join(artifacts, `${theme}-1280-complete-hover.png`), clip: await page.locator(".complete-ask").evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.left - 8, y: r.top - 8, width: r.width + 16, height: r.height + 16 }; }) });
  // Its flag in the title, against the title's own background.
  out.complete.flag = await page.evaluate(() => {
    const mark = document.querySelector(".complete-ask-mark");
    return { mark: getComputedStyle(mark).color, title: getComputedStyle(mark.parentElement).backgroundImage };
  });
  await page.keyboard.press("Escape");
  await page.locator(".complete-ask").waitFor({ state: "detached" });
  // The question, drawn in the transcript.
  const question = page.locator(".qa-block, .inline-questions, [data-pending-keys]").first();
  if (await question.count()) {
    await question.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(artifacts, `${theme}-1280-question.png`) });
  }
  // Settings, Appearance.
  await page.locator(".sidebar-place", { hasText: /^Settings$/ }).first().click();
  await page.getByRole("button", { name: /Appearance/ }).first().click();
  await page.locator(".thm-grid").waitFor();
  await page.locator(".thm-grid").scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  out.settingsFrame = await frame(page);
  await page.screenshot({ path: join(artifacts, `${theme}-1280-settings.png`) });
  await context.close();

  // The terminal, open under the chat.
  const term = await open(browser, { width: 1280, height: 860, terminal: true });
  await term.page.locator(".xterm").first().waitFor();
  await term.page.waitForTimeout(800);
  out.terminal = await term.page.locator(".xterm").count();
  await term.page.screenshot({ path: join(artifacts, `${theme}-1280-terminal.png`) });
  await term.page.locator(".xterm").first().screenshot({ path: join(artifacts, `${theme}-terminal-crop.png`) });
  // The colours the terminal resolves its palette from, read the way
  // `xtermTheme` reads them (one probe per value).
  out.terminalColours = await term.page.evaluate(() => {
    const names = ["--bg-0", "--fg-1", "--fg-0", "--fg-3", "--ok", "--warn", "--danger", "--link"];
    const probes = names.map((name) => { const el = document.createElement("span"); el.style.color = `var(${name})`; document.body.append(el); return el; });
    const out = Object.fromEntries(names.map((name, at) => [name, getComputedStyle(probes[at]).color]));
    for (const el of probes) el.remove();
    return out;
  });
  await term.context.close();

  // The empty page: a new conversation.
  const empty = await open(browser, { width: 1280, height: 860, hash: "#/p/octiq-flow" });
  await empty.page.waitForTimeout(600);
  await empty.page.screenshot({ path: join(artifacts, `${theme}-1280-empty.png`) });
  // A raised button under the pointer.
  const resume = empty.page.locator(".resume-open").first();
  if (await resume.count()) {
    await hoverSettled(empty.page, ".resume-open");
    await empty.page.screenshot({ path: join(artifacts, `${theme}-button-hover.png`), clip: await resume.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.left - 12, y: r.top - 12, width: r.width + 24, height: r.height + 24 }; }) });
  }
  await empty.page.mouse.move(0, 0);
  out.idleFocus = await idleFocus(empty.page, `${theme}-1280-idle-focus.png`);
  await empty.context.close();
}

async function phone(browser, out) {
  const { context, page } = await open(browser, { width: 390, height: 844, phone: true });
  out.frame = await frame(page);
  await page.screenshot({ path: join(artifacts, `${theme}-390-chat.png`) });
  await page.evaluate(() => document.querySelector(".composer")?.scrollIntoView());
  await page.screenshot({ path: join(artifacts, `${theme}-390-chat-full.png`), fullPage: true });
  // The composer's settings sheet: a sheet with a title bar.
  const toggle = page.locator(".composer .settings-toggle").first();
  if (await toggle.count()) {
    await toggle.click();
    await page.locator(".sheet").first().waitFor();
    await page.waitForTimeout(300);
    out.sheetFrame = await frame(page);
    await page.screenshot({ path: join(artifacts, `${theme}-390-sheet.png`) });
  }
  await context.close();
  const empty = await open(browser, { width: 390, height: 844, phone: true, hash: "#/p/octiq-flow" });
  out.idleFocus = await idleFocus(empty.page, `${theme}-390-idle-focus.png`);
  await empty.context.close();
}

/** Cyberpunk: Tab through the chat page (the sidebar and its rows' "…"
 *  included), the chat search page and Settings' appearance, and photograph
 *  the row's "…" and the search box with the focus. */
async function focusScenes(browser, out, { width, height, phone = false }) {
  const { context, page } = await open(browser, { width, height, phone });
  const menu = { selector: ".task-chat-list .chat-actions-trigger", frame: ".chat", file: `${theme}-${width}-sidebar-menu-focus.png` };
  if (phone) {
    // The phone's chat list is drawn in the chat's place.
    await page.locator("[aria-label='Show chats']").first().click();
    await page.locator(".task-chat-list .chat-actions-trigger").first().waitFor({ state: "attached" });
  }
  out.chat = await focusWalk(page, `${width} chat page`, [menu]);
  // What is in flight inside a focused control keeps the accent: the row's
  // "Running" line, and the run strip's bar.
  out.inFlight = {};
  const look = ({ control, part }) => {
    const el = document.querySelector(control);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const rgb = (value) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000"; ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
    };
    const s = getComputedStyle(el.querySelector(part));
    return {
      focused: el.matches(":focus-visible"),
      drawn: rgb(part === ".run-strip-fill" ? s.backgroundColor : s.color),
      accent: rgb(getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()),
    };
  };
  for (const [control, part] of [[".task-chat-list .chat.is-tasks-running .chat-btn", ".chat-workflow-status"], [".run-strip[data-live] .run-strip-open", ".run-strip-fill"]]) {
    if (!await page.locator(control).count()) continue;
    await page.evaluate(() => document.activeElement?.blur?.());
    const rest = await page.evaluate(look, { control, part });
    await page.keyboard.press("Shift");
    await page.locator(control).first().focus();
    out.inFlight[part] = { rest: rest.drawn, ...await page.evaluate(look, { control, part }) };
  }
  await page.locator(".sidebar-place", { hasText: "Search chats" }).first().click();
  await page.locator(".chat-search-form").waitFor();
  await page.waitForTimeout(300);
  out.search = await focusWalk(page, `${width} search`, [{ selector: ".chat-search-form input", frame: ".chat-search-form", file: `${theme}-${width}-search-focus.png` }]);
  if (phone) await page.locator("[aria-label='Show chats']").first().click();
  await page.locator(".sidebar-place", { hasText: /^Settings$/ }).first().click();
  await page.getByRole("button", { name: /Appearance/ }).first().click();
  await page.locator(".thm-grid").waitFor();
  await page.waitForTimeout(300);
  out.settings = await focusWalk(page, `${width} settings`);
  await context.close();
}

let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  await desktop(browser, report.scenes.desktop = {});
  await phone(browser, report.scenes.phone = {});
  if (theme === "cyberpunk") {
    await focusScenes(browser, report.scenes.focusDesktop = {}, { width: 1280, height: 860 });
    await focusScenes(browser, report.scenes.focusPhone = {}, { width: 390, height: 844, phone: true });
  }
  const { desktop: d, phone: p } = report.scenes;
  assert.equal(d.frame.theme, theme === "dark" ? null : theme);
  assert.equal(d.frame.sideways, false, "no sideways scroll at 1280");
  assert.equal(p.frame.sideways, false, "no sideways scroll at 390");
  assert.equal(d.frame.actionBar, 36, "the action bar is 36px on a desktop");
  assert.equal(p.frame.actionBar, 45, "the action bar is 45px on a phone");
  for (const scene of [d, p]) assert.equal(scene.idleFocus.focused, true, "the composer has the focus");
  // Cyberpunk's accent is a cyan that means a turn in flight, so a focused
  // idle composer must not be drawn in it. (Manga, 中国风 and Windows XP draw
  // their focus in their accent by design, and are not asked.)
  if (theme === "cyberpunk") {
    for (const scene of [d, p]) assert.notDeepEqual(scene.idleFocus.border, scene.idleFocus.accent, "an idle focused composer is not the accent");
    // No focus cue anywhere is the accent, on the element, its ::before and
    // ::after, or a frame round it lit by :focus-within.
    const walks = [report.scenes.focusDesktop, report.scenes.focusPhone].flatMap((scene) => [scene.chat, scene.search, scene.settings]);
    report.focusTargets = walks.reduce((sum, walk) => sum + walk.walked, 0);
    assert.deepEqual(walks.flatMap((walk) => walk.found), [], "a focus cue is drawn in the accent");
    for (const [scene, size] of [[report.scenes.focusDesktop, 1280], [report.scenes.focusPhone, 390]]) {
      assert.ok(scene.chat.names.some((name) => name.includes("chat-actions-trigger")), `the ${size} walk reached a row's "…"`);
      assert.ok(scene.search.names.some((name) => name.includes("Search chats")), `the ${size} walk reached the search box`);
      assert.ok(scene.settings.names.some((name) => name.includes("thm")), `the ${size} walk reached the appearance tiles`);
      assert.equal(scene.chat.shots.length + scene.search.shots.length, 2, `the ${size} focus pictures were taken`);
    }
    // ...and what is in flight inside a focused control is still the accent.
    const inFlight = Object.entries(report.scenes.focusDesktop.inFlight);
    assert.deepEqual(inFlight.map(([part]) => part), [".chat-workflow-status", ".run-strip-fill"], "the row's Running line and the live run strip were asked");
    for (const [part, look] of inFlight) {
      assert.equal(look.focused, true, `${part}: its control has the focus`);
      assert.deepEqual(look.drawn, look.rest, `${part} inside a focused control is drawn as it is without the focus`);
      if (part === ".chat-workflow-status") assert.deepEqual(look.drawn, look.accent, `${part} inside a focused control keeps the accent`);
    }
  }
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
