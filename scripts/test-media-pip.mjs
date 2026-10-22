// A chat's video or recording goes on playing when the person goes to another
// chat (web/src/lib/nowPlaying, components/NowPlaying), in the real App.
//
// Chat A's reply names a video and a recording; chat B is another chat. At
// 1280 and at 390, for each scene:
//
//   pip    the video plays, the person picks B: it goes on playing, in the
//          browser's own picture-in-picture window where this browser grants
//          it, otherwise in the mini-player; picking A again puts the same
//          element back in the reply, still playing, and the window shuts
//   mini   the same with picture-in-picture not offered (Firefox, a page that
//          turns it off): the mini-player shows the file, its chat, play and
//          pause, close; "Back to …" hands it back; close stops it, lets the
//          file go, and A's reply starts again from nothing
//   audio  the recording, in the mini-player only
//   paused a paused video stays in its reply: nothing floats
//   pip-leave  return to the tab opens its chat, including paused video;
//          inconclusive exits keep a visible Back fallback
//
// What is asserted each time: the element is the same one (a mark it carries
// moves with it), `currentTime` goes on advancing after the switch, exactly
// one player plays on the page, the mini-player is inside the window, clear of
// the action bar and the composer, with 44px targets, and nothing scrolls
// sideways.
//
// The socket and `/file` are mocked; everything else is the real App and CSS.
// The clips are made by ffmpeg at the start.
//
//   OCTIQ_THEME=light|dark|fun|manga|guofeng|xp|cyberpunk   one mode (dark), or
//   OCTIQ_THEMES=light,dark,...                            several (screenshots only past the first)
//   OCTIQ_BROWSER=chromium|webkit                          the engine (chromium)
//   PLAYWRIGHT_CHANNEL=chrome                              a Chromium channel (chrome)
//   OCTIQ_EVIDENCE_DIR=<dir>                               where the screenshots go (.shots/media-pip)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const webRoot = resolve(process.env.OCTIQ_WEB_ROOT || fileURLToPath(new URL("../web", import.meta.url)));
const repoRoot = resolve(webRoot, "..");
const require = createRequire(join(webRoot, "package.json"));
const moduleUrl = (spec) => (isAbsolute(spec) || spec.startsWith(".") ? pathToFileURL(resolve(spec)).href : spec);
const { createServer } = await import(moduleUrl(require.resolve("vite")));
const playwright = await import(moduleUrl(process.env.PLAYWRIGHT_MODULE || "playwright"));
const engine = process.env.OCTIQ_BROWSER || "chromium";
const themes = (process.env.OCTIQ_THEMES || process.env.OCTIQ_THEME || "dark").split(",").map((each) => each.trim()).filter(Boolean);
const artifacts = resolve(process.env.OCTIQ_EVIDENCE_DIR || join(repoRoot, ".shots/media-pip"));
await mkdir(artifacts, { recursive: true });

const SIZES = [{ name: "1280", width: 1280, height: 900, phone: false }, { name: "390", width: 390, height: 844, phone: true }];

/* ---- The files ------------------------------------------------------------- */

const scratch = await mkdtemp(join(tmpdir(), "octiq-media-pip-"));
execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=480x270:rate=15:duration=240", "-f", "lavfi", "-i", "sine=frequency=330:duration=240",
  "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-movflags", "+faststart", join(scratch, "take.mp4")]);
execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=240", "-c:a", "aac", join(scratch, "voice.m4a")]);

const VIDEO = join(repoRoot, "out/launch-take.mp4");
const AUDIO = join(repoRoot, "out/voice-note.m4a");
const FILES = new Map([
  [VIDEO, { file: join(scratch, "take.mp4"), type: "video/mp4" }],
  [AUDIO, { file: join(scratch, "voice.m4a"), type: "audio/mp4" }],
]);

function mock(duplicate = false) {
  const stamp = 1792461219629;
  const chat = (id, title, at, text) => ({
    id, projectId: "octiq", title, customTitle: true, modelId: "claude:opus", access: "auto", sessionId: `session-${id}`, cwd: repoRoot,
    createdAt: stamp - 600_000, updatedAt: at,
    messages: [{ id: `${id}-m1`, role: "assistant", streaming: false, blocks: [{ kind: "text", text }] }],
  });
  const a = chat("chat-a", "Launch video review", stamp, `The cut is ready: \`${VIDEO}\`\n\nAnd the voice-over on its own: \`${AUDIO}\``);
  const b = chat("chat-b", "Release notes", stamp - 60_000, "The release notes are drafted. Nothing to play here.");
  if (duplicate) a.messages.push(
    {id: 'a-user', role: 'user', streaming: false, blocks: [{kind: 'text', text: 'Review the same cut again.'}]},
    {id: 'a-second', role: 'assistant', streaming: false, blocks: [{kind: 'text', text: `The second reply: \`${VIDEO}\``}]},
  );
  const stored = [a, b];
  const index = stored.map(({ messages, ...entry }) => entry);
  const resultFor = (request) => {
    switch (request.cmd) {
      case "list_workspaces": return [{ id: "octiq", name: "octiq-flow", primary_path: repoRoot }];
      case "chat_index_list": return index;
      case "chat_index_deleted": return [];
      case "chat_page": return { events: [], context: [], before: null };
      case "resolve_paths": return (request.args?.paths ?? []).map((path) => (FILES.has(path) ? path : null));
      case "chat_list": case "chat_activity": case "permission_pending": case "safety_block_pending": case "question_pending":
      case "pr_repositories": case "codex_skills": case "image_preview_list": case "access_request_pending": case "team_list":
        return [];
      case "chat_queue_state": return { live: false, queuedTurnIds: [] };
      case "orchestration_snapshot": return { runs: [], tasks: [], attempts: [], gates: [], messages: [] };
      case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
      case "usage_summary": return { claude: { available: true, fiveHour: { percent: 12 } }, codex: { available: true, weekly: { percent: 23 } } };
      case "agent_installs": return [{ id: "claude", installed: true, path: "/mock/claude" }];
      case "pr_local_list": case "pr_remote_list": return { items: [], warnings: [] };
      case "sandbox_snapshot": return { defaultEnabled: false, environments: {} };
      case "git_status_summary": return [{ path: repoRoot, repo_root: repoRoot, is_repo: true, branch: "develop", changed: 0, ahead: 0, behind: 0 }];
      case "git_local_branches": return { is_repo: true, current: "develop", branches: ["develop"], is_worktree: false };
      case "chat_task": return { chatId: request.args?.chatId, projectId: "octiq" };
      case "chat_plan_get": return { chatId: request.args?.chatId, revision: 0, items: [], decisions: [], awaitsStart: false };
      case "media_comments_list": return { target: { path: request.args?.path, revision: "v1", kind: "video" }, comments: [] };
      case "chat_jobs": return [];
      default: return null;
    }
  };
  return { stored, resultFor };
}

const server = await createServer({ root: webRoot, configFile: join(webRoot, "vite.config.ts"), server: { host: "127.0.0.1", port: 0, strictPort: false, fs: { strict: false } } });
const errors = [];
const report = { artifacts, engine, themes, results: [] };

async function open(browser, theme, { width, height, phone }, { noPip = false, duplicate = false } = {}) {
  const { stored, resultFor } = mock(duplicate);
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce", ...(phone ? { hasTouch: true, isMobile: engine !== "webkit" ? true : undefined } : {}) });
  await context.addInitScript(({ chats, mode, off }) => {
    localStorage.setItem("octiq.v2.gitColumn", "0");
    localStorage.setItem("octiq.theme", mode);
    localStorage.setItem("octiq.v2.theme", mode);
    localStorage.setItem("octiq.v2.conversations", JSON.stringify(chats));
    // What Firefox, and a page that turns it off, look like.
    if (off) Object.defineProperty(Document.prototype, "pictureInPictureEnabled", { get: () => false, configurable: true });
  }, { chats: stored, mode: theme, off: noPip });
  await context.route("**/token", (route) => route.fulfill({ body: "mock-token" }));
  await context.route("**/auth", (route) => route.fulfill({ body: "ok" }));
  await context.route(/\/file\?/, async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path");
    const known = FILES.get(path);
    if (!known) return route.fulfill({ status: 404, body: "no such file" });
    // In ranges, as the host serves it: WebKit plays nothing without them.
    const body = await readFile(known.file);
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? "");
    if (!range) return route.fulfill({ status: 200, contentType: known.type, headers: { "Accept-Ranges": "bytes" }, body });
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
    return route.fulfill({
      status: 206, contentType: known.type, body: body.subarray(start, end + 1),
      headers: { "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${body.length}` },
    });
  });
  await context.routeWebSocket(/.*/, (socket) => {
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw));
      if (request.t !== "invoke") return;
      socket.send(JSON.stringify({ t: "reply", id: request.id, ok: true, result: resultFor(request) }));
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  page.on("pageerror", (error) => errors.push(error.stack ?? String(error)));
  page.on("console", (message) => { if (message.type() === "error" && /Error|Uncaught|Minified React/.test(message.text())) errors.push(message.text().slice(0, 600)); });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/#/p/octiq-flow/c/chat-a`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  await page.locator(".msgs").first().waitFor({ timeout: 180_000 });
  return { context, page };
}

/** Open a chat as a person would: its row in the list. */
async function pick(page, phone, title) {
  if (phone) {
    const back = page.getByRole("button", { name: "Show chats", exact: true });
    await back.tap();
    await page.locator(".sidebar .chat-row").filter({ hasText: title }).first().tap();
  } else {
    await page.locator(".sidebar .chat-row").filter({ hasText: title }).first().click();
  }
  await page.waitForFunction((want) => [...document.querySelectorAll(".msgs .msg")].some((el) => el.checkVisibility?.() !== false && el.textContent.includes(want)),
    title === "Release notes" ? "release notes are drafted" : "The cut is ready");
}

/** The inline player of chat A, brought into view and playing. */
async function startInline(page, kind, index = 0) {
  const selector = `.prose-media.is-${kind}`;
  const box = page.locator(selector).nth(index);
  await box.waitFor();
  await box.scrollIntoViewIfNeeded();
  await page.waitForFunction(({sel, index}) => { const box = document.querySelectorAll(sel)[index]; const el = box?.querySelector("video, audio"); return el && el.readyState >= 1; }, {sel: selector, index}, { timeout: 60_000 }).catch(async (error) => {
    throw new Error(`${selector}: no metadata: ${JSON.stringify(await page.evaluate((sel) => { const el = document.querySelector(`${sel} video, ${sel} audio`); return el && { state: el.readyState, network: el.networkState, error: el.error?.code ?? null, src: el.currentSrc.slice(0, 80) }; }, selector))}: ${error.message}`);
  });
  await page.evaluate(({sel, index}) => {
    const el = document.querySelectorAll(sel)[index].querySelector("video, audio");
    el.dataset.mark = "first";
    el.volume = 0.4;
    el.playbackRate = 1.25;
    return el.play();
  }, {sel: selector, index});
  await page.waitForFunction(() => { const el = document.querySelector("[data-mark=first]"); return el && el.currentTime > 0.6; });
}

/** Everything about the marked element and the page's players. */
const state = (page) => page.evaluate(() => {
  const el = document.querySelector("[data-mark=first]");
  const players = [...document.querySelectorAll("video, audio")];
  const host = document.querySelector(".now-playing");
  return {
    present: !!el,
    where: !el ? null : el.closest(".now-playing") ? "host" : el.closest(".prose-media") ? "inline" : "elsewhere",
    paused: el?.paused ?? null,
    time: el?.currentTime ?? null,
    rate: el?.playbackRate ?? null,
    volume: el?.volume ?? null,
    src: el?.getAttribute("src") ? "set" : "none",
    controls: el?.controls ?? null,
    playing: players.filter((each) => !each.paused).length,
    pip: !!document.pictureInPictureElement && document.pictureInPictureElement === el,
    pipEnabled: !!document.pictureInPictureEnabled,
    mini: host?.dataset.shown === "true",
  };
});

/** The marked element advanced by at least `by` seconds since `from`. */
const advances = (page, from, by = 0.5) => page.waitForFunction(({ t, d }) => {
  const el = document.querySelector("[data-mark=first]");
  return el && !el.paused && el.currentTime > t + d;
}, { t: from, d: by }, { timeout: 20_000 }).catch(async (error) => {
  throw new Error(`the player did not advance ${by}s from ${from}: ${JSON.stringify(await state(page))}: ${error.message}`);
});

/** The mini-player: inside the window, clear of the bars and the prompt box,
 *  44px targets, nothing in the accent. */
async function checkMini(page, label) {
  const facts = await page.evaluate(() => {
    const host = document.querySelector(".now-playing");
    const r = host.getBoundingClientRect();
    const rect = (sel) => [...document.querySelectorAll(sel)].filter((el) => el.checkVisibility?.() !== false).map((el) => { const b = el.getBoundingClientRect(); return { t: b.top, b: b.bottom, l: b.left, r: b.right }; });
    const overlaps = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
    const me = { t: r.top, b: r.bottom, l: r.left, r: r.right };
    const targets = [...host.querySelectorAll("button")].map((el) => { const b = el.getBoundingClientRect(); return { name: el.getAttribute("aria-label") || el.textContent.trim(), w: b.width, h: b.height }; });
    const colour = (token) => {
      const probe = document.createElement("span");
      probe.style.color = `var(${token})`;
      document.body.append(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    };
    const accent = colour("--accent");
    // Manga's accent is its ink, the colour of its text: nothing to tell apart.
    const inkAccent = [colour("--fg-0"), colour("--fg-1")].includes(accent);
    const colours = [...host.querySelectorAll("*")].concat(host).flatMap((el) => { const s = getComputedStyle(el); return [s.color, s.backgroundColor, s.borderTopColor]; });
    return {
      box: me,
      inWindow: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      hitsBars: rect(".topbar, .actionbar").some((b) => overlaps(me, b)),
      hitsComposer: rect(".composer-box").some((b) => overlaps(me, b)),
      targets,
      usesAccent: !inkAccent && colours.includes(accent),
      sideways: document.documentElement.scrollWidth > innerWidth,
      text: host.innerText,
    };
  });
  assert.equal(facts.inWindow, true, `${label}: the mini-player is inside the window ${JSON.stringify(facts.box)}`);
  assert.equal(facts.hitsBars, false, `${label}: clear of the top bar and the action bar`);
  assert.equal(facts.hitsComposer, false, `${label}: clear of the composer`);
  for (const target of facts.targets) assert.ok(target.w >= 44 && target.h >= 44, `${label}: ${target.name} is a 44px target (${target.w}x${target.h})`);
  assert.equal(facts.usesAccent, false, `${label}: nothing on it is the accent`);
  assert.equal(facts.sideways, false, `${label}: no sideways scroll`);
  return facts;
}

async function pipScene(browser, theme, size, shots) {
  const label = `${theme} pip ${size.name}`;
  const { context, page } = await open(browser, theme, size);
  const out = { scene: "pip", size: size.name, theme };
  try {
    await startInline(page, "video");
    const before = await state(page);
    out.pipEnabled = before.pipEnabled;
    await pick(page, size.phone, "Release notes");
    await page.waitForFunction(() => { const el = document.querySelector("[data-mark=first]"); return el?.closest(".now-playing") && (document.pictureInPictureElement === el || document.querySelector(".now-playing")?.dataset.shown === "true"); });
    const away = await state(page);
    assert.equal(away.present, true, `${label}: the same element is still on the page`);
    assert.equal(away.where, "host", `${label}: in the floating host`);
    assert.equal(away.paused, false, `${label}: still playing`);
    assert.ok(away.time >= before.time, `${label}: from where it was (${before.time} → ${away.time})`);
    assert.equal(away.rate, 1.25, `${label}: at its rate`);
    assert.equal(away.volume, 0.4, `${label}: at its volume`);
    assert.equal(away.playing, 1, `${label}: one player plays`);
    await advances(page, away.time);
    out.shownAs = away.pip ? "native picture-in-picture" : "mini-player";
    if (!away.pip) out.mini = await checkMini(page, label);
    if (shots) await page.screenshot({ path: join(artifacts, `${theme}-${engine}-pip-away-${size.name}.png`) });
    // Back to A by its row: the same element in the reply, still playing.
    const t = (await state(page)).time;
    await pick(page, size.phone, "Launch video review");
    await page.waitForFunction(() => document.querySelector("[data-mark=first]")?.closest(".prose-media"));
    const back = await state(page);
    assert.equal(back.where, "inline", `${label}: back in the reply`);
    assert.equal(back.paused, false, `${label}: still playing`);
    assert.equal(back.controls, true, `${label}: with its own controls again`);
    assert.ok(back.time >= t, `${label}: never behind where it was (${t} → ${back.time})`);
    await advances(page, back.time);
    await page.waitForFunction(() => !document.pictureInPictureElement && document.querySelector(".now-playing")?.dataset.shown === "false");
    assert.equal((await state(page)).playing, 1, `${label}: one player plays`);
    if (shots) await page.screenshot({ path: join(artifacts, `${theme}-${engine}-pip-back-${size.name}.png`) });
  } finally {
    await context.close();
  }
  return out;
}

/** Leaving the browser's own window. Its buttons are outside the page, so the
 *  window is shut from the page (`exitPictureInPicture`), which the store has
 *  not asked for. This exercises playing and paused return in a focused
 *  document; it does not physically press the operating system's buttons. */
async function pipLeaveScene(browser, theme, size) {
  const label = `${theme} pip-leave ${size.name}`;
  const { context, page } = await open(browser, theme, size);
  const out = { scene: "pip-leave", size: size.name, theme };
  try {
    await startInline(page, "video");
    await pick(page, size.phone, "Release notes");
    const granted = await page.waitForFunction(() => document.pictureInPictureElement?.dataset.mark === "first", null, { timeout: 5000 }).then(() => true, () => false);
    if (!granted) { out.skipped = "picture-in-picture not granted"; return out; }
    // Back to tab: its chat opens and the reply has it, still playing.
    await page.evaluate(() => document.exitPictureInPicture());
    await page.waitForFunction(() => document.querySelector("[data-mark=first]")?.closest(".prose-media"));
    const back = await state(page);
    assert.equal(back.paused, false, `${label}: back to tab keeps it playing`);
    assert.equal(await page.locator(".msgs .msg").filter({ hasText: "The cut is ready" }).first().isVisible(), true, `${label}: in its chat`);
    // Pause first, then return to a focused tab: this is still Back, not Close.
    await pick(page, size.phone, "Release notes");
    await page.waitForFunction(() => document.pictureInPictureElement?.dataset.mark === "first");
    const t = await page.evaluate(() => { const el = document.querySelector("[data-mark=first]"); el.pause(); return el.currentTime; });
    await page.bringToFront();
    await page.evaluate(() => document.exitPictureInPicture());
    await page.waitForFunction(() => document.querySelector("[data-mark=first]")?.closest(".prose-media"));
    const again = await state(page);
    assert.equal(again.paused, true, `${label}: its reply has it again, paused`);
    assert.ok(Math.abs(again.time - t) < 0.05, `${label}: where it stopped (${t} → ${again.time})`);
  } finally {
    await context.close();
  }
  return out;
}

async function miniScene(browser, theme, size, kind, shots) {
  const label = `${theme} mini ${kind} ${size.name}`;
  const { context, page } = await open(browser, theme, size, { noPip: true });
  const out = { scene: `mini-${kind}`, size: size.name, theme };
  try {
    await startInline(page, kind);
    await pick(page, size.phone, "Release notes");
    await page.locator('.now-playing[data-shown="true"]').waitFor();
    const away = await state(page);
    assert.equal(away.where, "host", `${label}: in the floating host`);
    assert.equal(away.paused, false, `${label}: still playing`);
    assert.equal(away.playing, 1, `${label}: one player plays`);
    await advances(page, away.time);
    out.mini = await checkMini(page, label);
    assert.match(out.mini.text, new RegExp(kind === "video" ? "launch-take\\.mp4" : "voice-note\\.m4a"), `${label}: the file's name`);
    assert.match(out.mini.text, /Back to Launch video review/, `${label}: the way back names its chat`);
    const names = out.mini.targets.map((each) => each.name);
    assert.deepEqual(names.filter((name) => /Picture/.test(name)), [], `${label}: no picture-in-picture button where it is not offered`);
    if (shots) await page.screenshot({ path: join(artifacts, `${theme}-${engine}-mini-${kind}-${size.name}.png`) });
    // Pause and play from the mini-player.
    await page.locator(".now-playing").getByRole("button", { name: "Pause", exact: true }).click();
    assert.equal((await state(page)).paused, true, `${label}: Pause pauses`);
    await page.locator(".now-playing").getByRole("button", { name: "Play", exact: true }).click();
    await advances(page, (await state(page)).time, 0.3);
    // "Back to …" hands it back, still playing, in place.
    const t = (await state(page)).time;
    await page.locator(".now-playing-back").click();
    await page.waitForFunction(() => document.querySelector("[data-mark=first]")?.closest(".prose-media"));
    const back = await state(page);
    assert.equal(back.paused, false, `${label}: still playing back in its reply`);
    assert.ok(back.time >= t, `${label}: from where it was`);
    await page.locator('.now-playing[data-shown="false"]').waitFor({ state: "attached" });
    await advances(page, back.time, 0.3);
    if (shots && size.name === "1280") await page.screenshot({ path: join(artifacts, `${theme}-${engine}-mini-${kind}-back-${size.name}.png`) });
    // Away again, then close: it stops, lets the file go, and the reply has a new player.
    await pick(page, size.phone, "Release notes");
    await page.locator('.now-playing[data-shown="true"]').waitFor();
    await page.locator(".now-playing").getByRole("button", { name: "Stop and close", exact: true }).click();
    const closed = await state(page);
    assert.equal(closed.present, false, `${label}: closed, the element is gone`);
    assert.equal(closed.playing, 0, `${label}: nothing plays`);
    await pick(page, size.phone, "Launch video review");
    await page.locator(`.prose-media.is-${kind} ${kind}`).first().waitFor({ state: "attached" });
    const fresh = await page.evaluate((k) => { const el = document.querySelector(`.prose-media.is-${k} ${k}`); return { mark: el.dataset.mark ?? null, paused: el.paused }; }, kind);
    assert.deepEqual(fresh, { mark: null, paused: true }, `${label}: the reply starts again from nothing`);
  } finally {
    await context.close();
  }
  return out;
}

async function pausedScene(browser, theme, size) {
  const label = `${theme} paused ${size.name}`;
  const { context, page } = await open(browser, theme, size, { noPip: true });
  try {
    await startInline(page, "video");
    await page.evaluate(() => document.querySelector("[data-mark=first]").pause());
    await pick(page, size.phone, "Release notes");
    await page.waitForTimeout(300);
    const away = await state(page);
    assert.equal(away.mini, false, `${label}: paused media does not float`);
    assert.equal(away.playing, 0, `${label}: and nothing plays`);
  } finally {
    await context.close();
  }
  return { scene: "paused", size: size.name, theme };
}

/** Actual App wiring, rather than just the store's public methods. */
async function lifecycleScene(browser, theme, size, scene) {
  const { context, page } = await open(browser, theme, size, { noPip: true, duplicate: scene === "duplicate" });
  const label = `${scene} ${size.name}`;
  try {
    await startInline(page, "video", scene === "duplicate" ? 1 : 0);
    await page.evaluate(() => { window.playedElement = document.querySelector('[data-mark=first]'); });
    await pick(page, size.phone, "Release notes");
    await page.locator('.now-playing[data-shown=true]').waitFor();
    if (scene === "duplicate") {
      await pick(page, size.phone, "Launch video review");
      await page.waitForFunction(() => document.querySelectorAll('.prose-media.is-video')[1]?.contains(window.playedElement));
      assert.equal(await page.evaluate(() => document.querySelectorAll('.prose-media.is-video')[0].contains(window.playedElement)), false, label);
      assert.equal((await state(page)).paused, false, label);
    } else if (scene === "delete") {
      if (size.phone) await page.getByRole('button', {name: 'Show chats', exact: true}).tap();
      await page.getByRole('button', {name: 'Actions for Launch video review', exact: true}).click();
      await page.getByRole('menuitem', {name: 'Delete chat', exact: true}).click();
      await page.waitForFunction(() => !document.querySelector('[data-mark=first]'));
    } else if (scene === "clear") {
      await pick(page, size.phone, "Launch video review");
      const input = page.locator('.composer textarea').first();
      await input.fill('/clear');
      await input.press('Enter');
      await page.waitForFunction(() => !document.querySelector('[data-mark=first]'));
    } else {
      // A genuine read/decode failure while the reply has no mounted owner.
      await page.evaluate(() => { const el = window.playedElement; el.src = '/file?path=/missing.mp4'; el.load(); });
      await page.locator('.now-playing [role=alert]').waitFor();
      assert.equal(await page.locator('.now-playing').getByRole('button', {name: 'Play', exact: true}).isDisabled(), true, label);
      await page.locator('.now-playing-back').click();
      await page.waitForFunction(() => !document.querySelector('.msgs video'));
      assert.equal(await page.locator('.now-playing[data-shown=true]').count(), 0, label);
    }
    if (scene === 'delete' || scene === 'clear') {
      assert.deepEqual(await page.evaluate(() => ({paused: window.playedElement.paused, src: window.playedElement.getAttribute('src'), connected: window.playedElement.isConnected})),
        {paused: true, src: null, connected: false}, label);
      assert.equal(await page.locator('.now-playing[data-shown=true]').count(), 0, label);
    }
  } finally {
    await context.close();
  }
  return {scene, size: size.name, theme};
}

const deadline = setTimeout(() => { console.error("media-pip: timed out"); process.exit(1); }, 20 * 60_000);
let browser;
try {
  await server.listen();
  browser = engine === "webkit"
    ? await playwright.webkit.launch({ headless: true })
    : await playwright.chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", args: ["--autoplay-policy=no-user-gesture-required"] });
  for (const [index, theme] of themes.entries()) {
    for (const size of SIZES) {
      const full = index === 0;
      if (!process.env.OCTIQ_MEDIA_REGRESSION_ONLY) {
        report.results.push(await pipScene(browser, theme, size, true));
        report.results.push(await miniScene(browser, theme, size, "video", true));
      }
      if (full) {
        if (!process.env.OCTIQ_MEDIA_REGRESSION_ONLY) {
          report.results.push(await miniScene(browser, theme, size, "audio", true));
          report.results.push(await pausedScene(browser, theme, size));
        }
        for (const scene of ["duplicate", "delete", "clear", "error"]) report.results.push(await lifecycleScene(browser, theme, size, scene));
        report.results.push(await pipLeaveScene(browser, theme, size));
      }
    }
  }
  assert.deepEqual(errors, [], "no page errors");
  console.log(JSON.stringify(report.results.map(({ mini, ...rest }) => ({ ...rest, ...(mini ? { miniBox: mini.box } : {}) })), null, 1));
  console.log(`media-pip: ${report.results.length} scenes passed (${engine}); screenshots in ${artifacts}`);
} catch (error) {
  console.error(errors.length ? `page errors:\n${errors.join("\n")}` : "");
  throw error;
} finally {
  clearTimeout(deadline);
  await browser?.close();
  await server.close();
}
