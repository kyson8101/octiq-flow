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
//   OCTIQ_MEDIA_SIZES=1280,390                             optional width subset
//   OCTIQ_MEDIA_PATH_MENU_ONLY=1                          path → native Play and intentional file actions
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
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

const SIZES = [{ name: "1280", width: 1280, height: 900, phone: false }, { name: "390", width: 390, height: 844, phone: true }]
  .filter(size => !process.env.OCTIQ_MEDIA_SIZES || process.env.OCTIQ_MEDIA_SIZES.split(',').includes(size.name));

/* ---- The files ------------------------------------------------------------- */

const scratch = await mkdtemp(join(tmpdir(), "octiq-media-pip-"));
const clipSeconds = Number(process.env.OCTIQ_MEDIA_CLIP_SECONDS || (process.env.OCTIQ_MEDIA_PATH_MENU_ONLY ? 4 : process.env.OCTIQ_MEDIA_RESUME_ONLY ? 30 : 240));
execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `testsrc=size=480x270:rate=15:duration=${clipSeconds}`, "-f", "lavfi", "-i", `sine=frequency=330:duration=${clipSeconds}`,
  "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-movflags", "+faststart", join(scratch, "take.mp4")]);
execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `sine=frequency=440:duration=${clipSeconds}`, "-c:a", "aac", join(scratch, "voice.m4a")]);

const VIDEO = join(repoRoot, "out/launch-take.mp4");
const AUDIO = join(repoRoot, "out/voice-note.m4a");
const NOTE = join(repoRoot, "out/notes.txt");
await writeFile(join(scratch, 'notes.txt'), 'Notes for the review.');
const FILES = new Map([
  [VIDEO, { file: join(scratch, "take.mp4"), type: "video/mp4" }],
  [AUDIO, { file: join(scratch, "voice.m4a"), type: "audio/mp4" }],
  [NOTE, { file: join(scratch, 'notes.txt'), type: 'text/plain' }],
]);

function mock(duplicate = false, text) {
  const stamp = 1792461219629;
  const chat = (id, title, at, text) => ({
    id, projectId: "octiq", title, customTitle: true, modelId: "claude:opus", access: "auto", sessionId: `session-${id}`, cwd: repoRoot,
    createdAt: stamp - 600_000, updatedAt: at,
    messages: [{ id: `${id}-m1`, role: "assistant", streaming: false, blocks: [{ kind: "text", text }] }],
  });
  const a = chat("chat-a", "Launch video review", stamp, `The cut is ready: \`${VIDEO}\`\n\nAnd the voice-over on its own: \`${AUDIO}\``);
  if (text) a.messages[0].blocks[0].text = text;
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
      case "stat_paths": return (request.args?.paths ?? []).map(() => 1);
      case "chat_list": case "chat_activity": case "permission_pending": case "safety_block_pending": case "question_pending":
      case "pr_repositories": case "codex_skills": case "access_request_pending": case "team_list":
      case "provider_fallback_choices":
        return [];
      case "chat_queue_state": return { live: false, queuedTurnIds: [] };
      case "orchestration_snapshot": return { runs: [], tasks: [], attempts: [], gates: [], messages: [] };
      case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
      case "usage_summary": return { claude: { available: true, fiveHour: { percent: 12 } }, codex: { available: true, weekly: { percent: 23 } } };
      case "agent_installs": return [{ id: "claude", installed: true, path: "/mock/claude" }];
      case "pr_local_list": case "pr_remote_list": return { items: [], warnings: [] };
      case "git_status_summary": return [{ path: repoRoot, repo_root: repoRoot, is_repo: true, branch: "develop", changed: 0, ahead: 0, behind: 0 }];
      case "git_local_branches": return { is_repo: true, current: "develop", branches: ["develop"], is_worktree: false };
      case "chat_task": return { chatId: request.args?.chatId, projectId: "octiq" };
      case "media_comments_list": return { target: { path: request.args?.path, revision: "v1", kind: "video" }, comments: [] };
      case "chat_jobs": return [];
      default: return null;
    }
  };
  return { stored, resultFor };
}

const server = await createServer({ root: webRoot, cacheDir: join(webRoot, "node_modules/.vite-media-pip"), configFile: join(webRoot, "vite.config.ts"), server: { host: "127.0.0.1", port: 0, strictPort: false, fs: { strict: false } } });
const errors = [];
const report = { artifacts, engine, themes, results: [] };

async function open(browser, theme, { width, height, phone }, { noPip = false, duplicate = false, text } = {}) {
  const { stored, resultFor } = mock(duplicate, text);
  const sockets = [], calls = [];
  let revisionDelay = 0, revision = 1;
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce", ...(phone ? { hasTouch: true, isMobile: engine !== "webkit" ? true : undefined } : {}) });
  await context.addInitScript(({ chats, mode, off }) => {
    localStorage.setItem("octiq.v2.gitColumn", "0");
    localStorage.setItem("octiq.theme", mode);
    localStorage.setItem("octiq.v2.theme", mode);
    localStorage.setItem("octiq.v2.conversations", JSON.stringify(chats));
    // What Firefox, and a page that turns it off, look like.
    if (off) Object.defineProperty(Document.prototype, "pictureInPictureEnabled", { get: () => false, configurable: true });
    window.mediaPlayErrors = [];
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      const result = play.apply(this, args);
      void result.catch(error => window.mediaPlayErrors.push({ name: error.name, message: error.message }));
      return result;
    };
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
    sockets.push(socket);
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw));
      if (request.t !== "invoke") return;
      calls.push(request);
      const result = request.cmd === "stat_paths" ? (request.args?.paths ?? []).map(() => revision) : resultFor(request);
      const reply = () => socket.send(JSON.stringify({ t: "reply", id: request.id, ok: true, result }));
      if (request.cmd === "stat_paths" && revisionDelay) setTimeout(reply, revisionDelay);
      else reply();
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  page.on("pageerror", (error) => errors.push(error.stack ?? String(error)));
  page.on("console", (message) => { if (message.type() === "error" && /Error|Uncaught|Minified React/.test(message.text())) errors.push(message.text().slice(0, 600)); });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/#/p/octiq-flow/c/chat-a`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  await page.locator(".msgs").first().waitFor({ timeout: 180_000 });
  return { context, page, calls,
    slowRevision: (ms, value = revision) => { revisionDelay = ms; revision = value; },
    send: (event) => sockets.forEach(socket => socket.send(JSON.stringify({ t: "event", event: "chat-event", payload: event }))),
  };
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

/** Resume the earlier reply while a new turn streams. One browser-native
 * Play press must work before the deliberately slow host stat can answer.
 * Identity/holder observations distinguish freshness gating from remounts. */
async function resumeScene(browser, theme, size, kind, repeated = false, takeover = 'wheel') {
  console.log(`resume ${engine} ${kind} ${size.name} ${takeover} ${repeated ? 'repeated' : 'single'}: opening App`);
  const { context, page, calls, slowRevision, send } = await open(browser, theme, size);
  let timer;
  try {
    await startInline(page, kind);
    console.log('resume: initial playback ready');
    await page.evaluate(() => {
      const el = document.querySelector('[data-mark=first]');
      el.pause(); el.currentTime = 12;
      window.resumePlayer = el; window.resumeHolder = el.parentElement;
      window.resumePlays = 0; window.resumeAt = null; window.resumeMs = null;
      window.resumeAllowedImmediately = null; window.resumePauses = 0;
      el.addEventListener('play', () => { window.resumePlays++; window.resumeAt ??= performance.now(); window.resumeAllowedImmediately ??= !el.paused; });
      el.addEventListener('pause', () => { if (window.resumeAt !== null) window.resumePauses++; });
      el.addEventListener('playing', () => { if (!el.paused && window.resumeAt !== null) window.resumeMs ??= performance.now() - window.resumeAt; });
      window.resumeLoads = 0; el.addEventListener('loadstart', () => window.resumeLoads++);
    });
    const input = page.locator('.composer textarea').first();
    await input.fill('Continue the review while I listen.');
    await page.locator('.composer').getByRole('button', { name: 'Send', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.msgs')?.textContent.includes('Continue the review while I listen.'));
    assert(calls.some(call => ['chat_start', 'chat_send'].includes(call.cmd)), 'a real composer send reached the socket');
    let seq = 0;
    const stream = (event) => send({ key: 'chat:chat-a', seq: ++seq, event: { type: 'stream_event', event } });
    stream({ type: 'message_start', message: { id: 'reply-stream', type: 'message', role: 'assistant', content: [], model: 'claude-opus' } });
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Still reviewing.' } });
    const delta = () => stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' .' } });
    timer = setInterval(delta, 50);
    await page.locator('.msgs').getByText('Still reviewing.', { exact: false }).first().waitFor();
    console.log('resume: sending/deltas ready');
    const player = page.locator(`[data-mark=first]`);
    let interaction;
    if (takeover === 'wheel') {
      // Take over transcript scrolling as a reader does.
      await page.locator('.msgs').first().hover();
      await page.mouse.wheel(0, -1800);
      await page.waitForTimeout(100);
      // The scroller's centre can be a file path. Leave its hover menu before
      // locating native controls, so Copy path cannot intercept the press.
      await page.mouse.move(1, 1);
    } else {
      // No wheel/touch/key takeover: the player itself must protect a press
      // from follow-tail, including before pointerdown reaches its controls.
      clearInterval(timer);
    }
    await player.scrollIntoViewIfNeeded();
    if (takeover !== 'wheel') {
      if (takeover === 'hover') await player.hover();
      else await player.focus();
      const before = await player.boundingBox();
      timer = setInterval(() => stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '\n\nMore review notes.' } }), 50);
      await page.waitForTimeout(450);
      const after = await player.boundingBox();
      interaction = { takeover, before: before.y, after: after.y };
      report.lastInteraction = interaction;
      await page.screenshot({ path: join(artifacts, `${engine}-${kind}-${takeover}-hold-${size.name}.png`) });
      assert(Math.abs(after.y - before.y) < 1, `${takeover} keeps the player's controls in place: ${JSON.stringify(interaction)}`);
    }
    slowRevision(1800, repeated ? 2 : 1);
    const statsBefore = calls.filter(call => call.cmd === 'stat_paths').length;
    // A native control press: Chrome's control bar, WebKit's video overlay
    // or audio control. No page script calls play() on this path.
    const press = async () => {
      const b = await player.boundingBox();
      await page.mouse.click(b.x + (engine === 'webkit' ? kind === 'video' ? b.width / 2 : b.width < 400 ? 22 : 50 : 24),
        b.y + (engine === 'webkit' && kind === 'video' ? b.height / 2 : kind === 'video' ? b.height - 50 : b.height / 2));
    };
    const started = Date.now();
    if (repeated) await page.evaluate(() => {
      // Two native play intents in the browser, 30ms apart. A second
      // Playwright round trip could arrive after the first has resumed and
      // would then press Pause instead, which is a different user action.
      window.resumePlayer.addEventListener('play', () => setTimeout(() => {
        void HTMLMediaElement.prototype.play.call(window.resumePlayer).catch(() => {});
      }, 30), { once: true });
    });
    await press();
    await page.waitForFunction(() => window.resumeAt !== null, null, { timeout: 2000 }).catch(() => {});
    await page.waitForFunction(() => window.resumeMs !== null, null, { timeout: 900 }).catch(() => {});
    // WebKit can acknowledge Play before its seeked audio clock ticks.
    await page.waitForFunction(() => window.resumePlayer.currentTime > 12.05, null, { timeout: 1500 }).catch(() => {});
    const resumed = await page.evaluate(() => ({
      same: document.querySelector('[data-mark=first]') === window.resumePlayer,
      sameHolder: window.resumePlayer.parentElement === window.resumeHolder,
      paused: window.resumePlayer.paused, time: window.resumePlayer.currentTime,
      loads: window.resumeLoads,
      plays: window.resumePlays,
      resumeMs: window.resumeMs,
      allowedImmediately: window.resumeAllowedImmediately,
      pauses: window.resumePauses,
      sincePlayMs: window.resumeAt === null ? null : performance.now() - window.resumeAt,
      playErrors: window.mediaPlayErrors,
    }));
    const lookups = calls.filter(call => call.cmd === 'stat_paths').length - statsBefore;
    report.lastResume = { ...resumed, lookups };
    await page.screenshot({ path: join(artifacts, `${engine}-resume-press-${kind}-${size.name}.png`) });
    assert.equal(resumed.same, true, 'send/deltas preserve the player');
    assert.equal(resumed.sameHolder, true, 'send/deltas preserve the holder');
    assert.equal(resumed.paused, false, `one press resumes before stat answers: ${JSON.stringify({ ...resumed, lookups })}`);
    assert(resumed.time > 12, 'resume keeps and advances the position');
    assert.equal(resumed.allowedImmediately, true, 'freshness never pauses a native press');
    assert.equal(resumed.pauses, 0, 'a slow unchanged check never interrupts playback');
    assert.equal(resumed.loads, 0, 'unchanged revision never reloads');
    assert.equal(lookups, 1, 'repeated presses share one lookup');
    // A late changed answer must not swap the source under active playback.
    await page.waitForTimeout(2000);
    assert.equal(await page.evaluate(() => window.resumeLoads), 0);
    let pendingReplay;
    if (repeated) {
      // The host stays slow. Its late confirmed revision must survive for
      // the next native Play, without a fast second lookup masking the bug.
      await page.evaluate(() => window.resumePlayer.pause());
      await press();
      await page.waitForFunction(() => window.resumeLoads === 1 && !window.resumePlayer.paused && window.resumePlayer.currentTime > 0);
      pendingReplay = await page.evaluate(() => ({ loads: window.resumeLoads, time: window.resumePlayer.currentTime, src: window.resumePlayer.src }));
      assert(pendingReplay.time < 2, 'late confirmed replacement starts from zero on the next press');
    }
    await page.screenshot({ path: join(artifacts, `${engine}-resume-${kind}-${repeated ? 'repeated' : 'single'}-${size.name}.png`) });
    return { scene: `stream-resume-${kind}${repeated ? '-repeated' : ''}-${takeover}`, size: size.name, ...resumed, lookups, interaction, pendingReplay, observedAfterMs: Date.now() - started };
  } finally { clearInterval(timer); await context.close(); }
}

/** A pass over native controls holds only while hovered, without changing
 * the reader's existing follow decision. No focus or pointerdown is used. */
async function hoverScene(browser, theme, size) {
  const { context, page, send } = await open(browser, theme, size);
  try {
    const player = page.locator('.prose-media.is-audio audio').first();
    await player.waitFor();
    await page.mouse.move(1, 1);
    await page.locator('.composer textarea').first().fill('Hover pass-through');
    await page.locator('.composer').getByRole('button', { name: 'Send', exact: true }).click();
    let seq = 0;
    const stream = event => send({ key: 'chat:chat-a', seq: ++seq, event: { type: 'stream_event', event } });
    stream({ type: 'message_start', message: { id: 'hover-stream', type: 'message', role: 'assistant', content: [], model: 'claude-opus' } });
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    const grow = () => stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '\n\nMore notes below the controls.' } });
    await page.waitForTimeout(100);
    await player.scrollIntoViewIfNeeded();
    await player.hover();
    const before = await player.boundingBox();
    for (let i = 0; i < 12; i++) { grow(); await page.waitForTimeout(45); }
    const after = await player.boundingBox();
    assert(Math.abs(after.y - before.y) < 1, 'hover keeps controls under the pointer');
    await page.mouse.move(1, 1);
    const gap = () => page.locator('.msgs').first().evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight);
    await page.waitForFunction(() => { const el = document.querySelector('.msgs'); return el.scrollHeight - el.scrollTop - el.clientHeight < 3; });
    for (let i = 0; i < 5; i++) { grow(); await page.waitForTimeout(45); }
    // Socket delivery and ResizeObserver run after the last send. Wait for
    // that final rendered growth before measuring the restored follow state.
    await page.waitForFunction(() => {
      const el = document.querySelector('.msgs');
      return el.textContent.split('More notes below the controls.').length === 18
        && el.scrollHeight - el.scrollTop - el.clientHeight < 3;
    });
    assert(await gap() < 3, 'pointer leave restores follow for subsequent stream growth');
    const anchor = await page.locator('.msgs').first().evaluate(el => getComputedStyle(el).overflowAnchor);
    assert.equal(anchor, 'auto', 'temporary hover returns browser anchoring');
    await page.screenshot({ path: join(artifacts, `${engine}-hover-leave-${size.name}.png`) });
    return { scene: 'hover-pass-through', size: size.name, drift: after.y - before.y, gap: await gap(), anchor };
  } finally { await context.close(); }
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
      // Touch composers keep Enter for newlines; Send submits on both sizes.
      await page.locator('.composer').getByRole('button', {name: 'Send', exact: true}).click();
      await page.waitForFunction(() => !document.querySelector('[data-mark=first]'));
    } else {
      // A genuine read/decode failure while the reply has no mounted owner.
      await page.evaluate(() => { const el = window.playedElement; el.src = '/file?path=/missing.mp4'; el.load(); });
      await page.locator('.now-playing [role=alert]').waitFor();
      assert.equal(await page.locator('.now-playing').getByRole('button', {name: 'Play', exact: true}).isDisabled(), true, label);
      await page.locator('.now-playing-back').click();
      await page.waitForFunction(() => document.querySelector('.msgs video') === window.playedElement);
      const retry = page.locator('.prose-media').getByRole('button', {name: 'Retry', exact: true});
      await retry.waitFor();
      assert.equal(await page.locator('.now-playing[data-shown=true]').count(), 0, label);
      await page.screenshot({path: join(artifacts, `${theme}-error-retry-${size.name}.png`), fullPage: true});
      // The failed file comes back. Retry reloads the retained element rather
      // than replacing the element nowPlaying and the reply slot know.
      FILES.set('/missing.mp4', FILES.get(VIDEO));
      try {
        await retry.click();
        await page.waitForFunction(() => window.playedElement.readyState >= 1 && !window.playedElement.error);
        await page.evaluate(() => window.playedElement.play());
        await advances(page, 0);
        assert.equal(await page.evaluate(() => document.querySelector('.msgs video') === window.playedElement), true, label);
        assert.equal(await retry.count(), 0, label);
        await pick(page, size.phone, 'Release notes');
        await page.waitForFunction(() => document.querySelector('.now-playing video') === window.playedElement);
        await advances(page, (await state(page)).time);
        assert.equal(await page.locator('.now-playing [role=alert]').count(), 0, label);
        assert.equal(await page.locator('.now-playing').getByRole('button', {name: 'Pause', exact: true}).isEnabled(), true, label);
        await page.screenshot({path: join(artifacts, `${theme}-error-recovered-${size.name}.png`), fullPage: true});
      } finally { FILES.delete('/missing.mp4'); }
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

/** Pass through the path to the native control, including after its menu has
 * opened. Deliberately no off-page pointer move, focus or scripted play here. */
async function pathMenuPlayScene(browser, theme, size, kind, rest, above = false) {
  // Exercise hover at phone width too; touch's always-visible actions have a
  // separate scene below. The App still uses its real responsive layout.
  const { context, page } = await open(browser, theme, { ...size, phone: false }, { text: above ? `The cut is ready: \`${kind === 'audio' ? AUDIO : VIDEO}\`\n\n\`${NOTE}\`` : undefined });
  try {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await startInline(page, kind);
    const player = page.locator('[data-mark=first]');
    await player.evaluate(el => { el.pause(); el.currentTime = 0; });
    await player.scrollIntoViewIfNeeded();
    const path = page.locator('.prose-file-actions').filter({ hasText: above ? 'notes.txt' : kind === 'audio' ? 'voice-note' : 'launch-take' }).first();
    await path.scrollIntoViewIfNeeded();
    const line = await path.locator('.prose-path').evaluate(el => {
      const r = [...el.getClientRects()].at(-1);
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const b = await player.boundingBox();
    const point = {
      x: b.x + (engine === 'webkit' ? kind === 'video' ? b.width / 2 : b.width < 400 ? 22 : 50 : 24),
      y: b.y + (engine === 'webkit' && kind === 'video' ? b.height / 2 : kind === 'video' ? b.height - 50 : b.height / 2),
    };
    const x = Math.max(line.x + 3, Math.min(point.x, line.x + line.width - 3));
    await page.mouse.move(x, above ? line.y + line.height + 12 : line.y - 12);
    await page.mouse.move(x, line.y + line.height / 2);
    await page.waitForTimeout(rest);
    const started = Date.now();
    // A short, continuous route at human pointer speed, rather than a single
    // protocol jump whose duration varies from a few ms to a busy frame.
    for (let step = 1; step <= 3; step++) {
      await page.waitForTimeout(40);
      await page.mouse.move(x + (point.x - x) * step / 3,
        line.y + line.height / 2 + (point.y - line.y - line.height / 2) * step / 3);
    }
    const travelMs = Date.now() - started;
    const target = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return { tag: el?.tagName, menu: !!el?.closest('.prose-file-action-menu') };
    }, point);
    assert.equal(target.menu, false, 'the first press reaches the native control');
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-mark=first]');
      return !el.paused && el.currentTime > 0.05;
    });
    const playback = await player.evaluate(el => ({ paused: el.paused, time: el.currentTime }));
    await page.screenshot({ path: join(artifacts, `${engine}-path-play-${kind}-${size.name}-rest${rest}-${above ? 'above' : 'below'}.png`) });
    return { scene: 'path-play', size: size.name, kind, rest, above, travelMs, target, ...playback };
  } finally { await context.close(); }
}

/** Both named actions remain reachable from the path, by pointer and keyboard;
 * touch retains its compact inline actions and the path's primary action. */
async function menuReady(menu) {
  await menu.getByRole('button').first().waitFor({ state: 'visible' });
  // A top-layer box can be measurable before its descendants have painted.
  // Assert geometry/hit testing on a rendered frame, as the person sees it.
  await menu.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function pathMenuActionsScene(browser, theme, size, kind, touch = false, motion = 'reduce') {
  const { context, page } = await open(browser, theme, { ...size, phone: touch });
  try {
    await page.emulateMedia({ reducedMotion: motion === 'normal' ? 'no-preference' : 'reduce' });
    await page.evaluate(() => {
      window.copiedPaths = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedPaths.push(text); } } });
    });
    const path = page.locator('.prose-file-actions').filter({ hasText: kind === 'audio' ? 'voice-note' : 'launch-take' }).first();
    const button = path.locator('.prose-path');
    const menu = path.locator('.prose-file-action-menu');
    await button.waitFor();
    await button.scrollIntoViewIfNeeded();
    const visible = () => menu.evaluate(el => getComputedStyle(el).visibility === 'visible');
    if (touch) {
      assert(await visible(), 'touch actions are always visible');
      assert.equal(await menu.evaluate(el => getComputedStyle(el).position), 'static');
      await menu.getByRole('button', { name: /^Copy path:/ }).tap();
    } else {
      // Record actual hover-to-visible time in the browser, including reduced
      // motion: intent delay remains, only the small fade is reduced.
      await path.evaluate(el => {
        window.menuHoverMs = null;
        el.addEventListener('pointerenter', () => {
          const start = performance.now();
          const check = () => {
            if (getComputedStyle(el.querySelector('.prose-file-action-menu')).visibility === 'visible') window.menuHoverMs = performance.now() - start;
            else requestAnimationFrame(check);
          };
          requestAnimationFrame(check);
        }, { once: true });
      });
      await button.hover();
      await menu.waitFor({ state: 'visible' });
      await menuReady(menu);
      await page.waitForFunction(() => window.menuHoverMs !== null);
      assert(await page.evaluate(() => window.menuHoverMs >= 140), 'passing hover does not instantly open the menu');
      const r = await menu.boundingBox();
      // Enter the menu by the touching edge, rather than crossing the gap of
      // some other layout. It must stay open while travelling into its body.
      await page.mouse.move(r.x + r.width / 2, r.y + r.height - 2, { steps: 6 });
      await page.mouse.move(r.x + r.width / 2, r.y + 15, { steps: 4 });
      assert(await visible(), 'path → menu keeps it open');
      await page.screenshot({ path: join(artifacts, `${engine}-path-hover-${kind}-${size.name}-${motion}.png`) });
      const player = await page.locator(`.prose-media.is-${kind}`).first().boundingBox();
      await page.mouse.move(player.x + player.width - 5, player.y + player.height / 2);
      await menu.waitFor({ state: 'hidden' });
      await page.waitForTimeout(250);
      assert.equal(await visible(), false, 'leave closes and cancels pending hover');
      await button.hover();
      await menuReady(menu);
      await menu.getByRole('button', { name: /^Copy path:/ }).click();
    }
    assert.equal(await page.evaluate(() => window.copiedPaths.length), 1, 'Copy path works');
    await menu.getByRole('button', { name: /^Open in OctiqFlow:/ })[touch ? 'tap' : 'click']();
    await page.locator('.fpanel.is-open').waitFor();
    if (touch) {
      await page.locator('.fpanel.is-open').getByRole('button', { name: 'Close', exact: true }).click();
      await page.locator('.fpanel').waitFor({ state: 'detached' });
      await button.tap();
      await page.locator('.fpanel.is-open').waitFor();
    }
    await page.screenshot({ path: join(artifacts, `${engine}-path-actions-${kind}-${size.name}-${touch ? 'touch' : 'hover-keyboard'}-${motion}.png`) });
    return { scene: 'path-actions', size: size.name, kind, touch, motion, copied: await page.evaluate(() => window.copiedPaths.length), hoverMs: await page.evaluate(() => window.menuHoverMs ?? null) };
  } finally { await context.close(); }
}

/** Keyboard starts in its own real App context, independent of FilePanel's
 * phone reader/inert state and the pointer action's native focus restoration. */
async function pathMenuKeyboardScene(browser, theme, size, kind, motion) {
  const { context, page } = await open(browser, theme, { ...size, phone: false });
  try {
    await page.emulateMedia({ reducedMotion: motion === 'normal' ? 'no-preference' : 'reduce' });
    await page.bringToFront();
    await page.evaluate(() => {
      window.copiedPaths = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedPaths.push(text); } } });
    });
    const path = page.locator('.prose-file-actions').filter({ hasText: kind === 'audio' ? 'voice-note' : 'launch-take' }).first();
    const button = path.locator('.prose-path');
    const menu = path.locator('.prose-file-action-menu');
    await button.waitFor();
    await button.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    await button.focus();
    assert(await button.evaluate(el => document.activeElement === el), 'keyboard focus reaches the path');
    await menuReady(menu);
    // macOS WebKit's default Tab skips buttons; Option-Tab visits them.
    const nextFocus = engine === 'webkit' ? 'Alt+Tab' : 'Tab';
    await page.keyboard.press(nextFocus);
    assert.match(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? ''), /^Copy path:/);
    await page.screenshot({ path: join(artifacts, `${engine}-path-keyboard-${kind}-${size.name}-${motion}.png`) });
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.copiedPaths.length), 1);
    await page.keyboard.press(nextFocus);
    assert.match(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? ''), /^Open in OctiqFlow:/);
    await page.keyboard.press('Enter');
    await page.locator('.fpanel.is-open').waitFor();
    return { scene: 'path-keyboard', size: size.name, kind, motion, copied: 1, opened: true };
  } finally { await context.close(); }
}

/** The menu escapes the scroller's first line and top bar. Exercise the first
 * line of a reply separately from a scrolled mid-reply path. */
async function pathMenuEdgeScene(browser, theme, size, scrolled) {
  const filler = Array.from({ length: 24 }, (_, i) => `Review paragraph ${i}.`).join('\n\n');
  const { context, page } = await open(browser, theme, { ...size, phone: false }, { text: `${scrolled ? filler + '\n\n' : ''}\`${NOTE}\`\n\n${filler}` });
  try {
    await page.evaluate(() => {
      window.copiedPaths = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedPaths.push(text); } } });
    });
    const path = page.locator('.prose-file-actions').filter({ hasText: 'notes.txt' }).first();
    const button = path.locator('.prose-path');
    const menu = path.locator('.prose-file-action-menu');
    await button.waitFor();
    if (scrolled) await button.evaluate(el => el.scrollIntoView({ block: 'start' }));
    else await page.locator('.msgs').evaluate(el => { el.scrollTop = 0; });
    const line = await button.evaluate(el => { const r = el.getClientRects()[0]; return { x: r.x, y: r.y, width: r.width, height: r.height }; });
    await page.mouse.move(line.x + Math.min(25, line.width / 2), line.y + line.height / 2);
    await menu.waitFor({ state: 'visible' });
    await menuReady(menu);
    const facts = await menu.evaluate(el => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: innerHeight, width: innerWidth,
        popover: el.matches(':popover-open'), pointer: getComputedStyle(el).pointerEvents,
        buttons: [...el.querySelectorAll('button')].map(b => { const r = b.getBoundingClientRect(); const target = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { hit: target === b || b.contains(target), target: target?.outerHTML.slice(0, 150), x: r.x + r.width / 2, y: r.y + r.height / 2 }; }) };
    });
    assert(facts.top >= 0 && facts.bottom <= facts.height && facts.left >= 0 && facts.right <= facts.width, JSON.stringify(facts));
    await page.screenshot({ path: join(artifacts, `${engine}-path-edge-${size.name}-${scrolled ? 'scroller' : 'reply'}.png`) });
    assert(facts.buttons.every(b => b.hit), `both full menu actions are above clipping/other bars: ${JSON.stringify(facts)}`);
    // Travel upwards from the first line into its adjacent menu.
    const r = await menu.boundingBox();
    await page.mouse.move(Math.max(r.x + 5, Math.min(line.x + 25, r.x + r.width - 5)), r.y + r.height - 2, { steps: 4 });
    await menu.getByRole('button', { name: /^Copy path:/ }).click();
    assert.equal(await page.evaluate(() => window.copiedPaths.length), 1);
    // Keep keyboard focus in the menu while scrolling, so a pointer leave
    // cannot mask a detached floating-menu bug.
    await page.locator('.msgs').evaluate(el => { el.scrollTop += 25; });
    await page.waitForFunction(() => {
      const el = document.querySelector('.prose-file-actions');
      const menu = el.querySelector('.prose-file-action-menu');
      const r = menu.getBoundingClientRect();
      return getComputedStyle(menu).visibility === 'hidden' || [...el.querySelector('.prose-path').getClientRects()]
        .some(p => Math.min(Math.abs(r.bottom - p.top), Math.abs(r.top - p.bottom), Math.abs(r.left - p.right), Math.abs(r.right - p.left)) < 1);
    }, null, { timeout: 2000 });
    const afterScroll = await path.evaluate(el => {
      const menu = el.querySelector('.prose-file-action-menu');
      const r = menu.getBoundingClientRect();
      const lines = [...el.querySelector('.prose-path').getClientRects()];
      return { visible: getComputedStyle(menu).visibility === 'visible', top:r.top,bottom:r.bottom,lines:lines.map(p=>({top:p.top,bottom:p.bottom})), attached: lines.some(p => Math.min(Math.abs(r.bottom - p.top), Math.abs(r.top - p.bottom), Math.abs(r.left - p.right), Math.abs(r.right - p.left)) < 1) };
    });
    assert(!afterScroll.visible || afterScroll.attached, `a scrolling menu stays attached or closes: ${JSON.stringify(afterScroll)}`);
    return { scene: 'path-edge', size: size.name, scrolled, facts, afterScroll };
  } finally { await context.close(); }
}

async function pathMenuStreamScene(browser, theme, size) {
  const { context, page, send } = await open(browser, theme, { ...size, phone: false });
  try {
    await page.locator('.composer textarea').first().fill('Continue the review.');
    await page.locator('.composer').getByRole('button', { name: 'Send', exact: true }).click();
    let seq = 0;
    const stream = event => send({ key: 'chat:chat-a', seq: ++seq, event: { type: 'stream_event', event } });
    stream({ type: 'message_start', message: { id: 'menu-stream', type: 'message', role: 'assistant', content: [], model: 'claude-opus' } });
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `\`${NOTE}\`\n\nWorking.` } });
    const path = page.locator('.prose-file-actions').filter({ hasText: 'notes.txt' }).last();
    await path.locator('.prose-path').waitFor();
    await path.locator('.prose-path').hover();
    await path.locator('.prose-file-action-menu').waitFor({ state: 'visible' });
    await menuReady(path.locator('.prose-file-action-menu'));
    const before = await path.boundingBox();
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '\n\nMore review notes.'.repeat(18) } });
    await page.waitForTimeout(500);
    const result = await path.evaluate(el => {
      const menu = el.querySelector('.prose-file-action-menu');
      const r = menu.getBoundingClientRect();
      const lines = [...el.querySelector('.prose-path').getClientRects()];
      return { visible: getComputedStyle(menu).visibility === 'visible', pathTop: el.getBoundingClientRect().top, menuTop: r.top, menuBottom: r.bottom,
        attached: lines.some(p => Math.min(Math.abs(r.bottom - p.top), Math.abs(r.top - p.bottom), Math.abs(r.left - p.right), Math.abs(r.right - p.left)) < 1) };
    });
    await page.screenshot({ path: join(artifacts, `${engine}-path-stream-${size.name}.png`) });
    assert(!result.visible || result.attached, `streaming never leaves a floating menu: ${JSON.stringify(result)}`);
    return { scene: 'path-stream', size: size.name, before: before.y, ...result };
  } finally { await context.close(); }
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
      if (process.env.OCTIQ_MEDIA_PATH_MENU_ONLY) {
        report.results.push(await pathMenuStreamScene(browser, theme, size));
        for (const scrolled of [false, true]) report.results.push(await pathMenuEdgeScene(browser, theme, size, scrolled));
        for (const kind of ['audio', 'video']) {
          for (const above of [false, true]) for (const rest of [0, 150, 350]) report.results.push(await pathMenuPlayScene(browser, theme, size, kind, rest, above));
          for (const motion of ['reduce', 'normal']) {
            report.results.push(await pathMenuActionsScene(browser, theme, size, kind, false, motion));
            report.results.push(await pathMenuKeyboardScene(browser, theme, size, kind, motion));
          }
          if (size.phone) report.results.push(await pathMenuActionsScene(browser, theme, size, kind, true));
        }
        continue;
      }
      report.results.push(await hoverScene(browser, theme, size));
      if (process.env.OCTIQ_MEDIA_HOVER_ONLY) continue;
      if (size.name === '1280') for (const kind of ['video', 'audio']) for (const takeover of ['hover', 'focus']) report.results.push(await resumeScene(browser, theme, size, kind, false, takeover));
      if (process.env.OCTIQ_MEDIA_INTERACTION_ONLY) continue;
      for (const kind of ['video', 'audio']) for (const repeated of [false, true]) report.results.push(await resumeScene(browser, theme, size, kind, repeated));
      if (process.env.OCTIQ_MEDIA_RESUME_ONLY) continue;
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
  await writeFile(join(artifacts, `${engine}-report.json`), JSON.stringify({ ...report, errors }, null, 2));
  await rm(scratch, { recursive: true, force: true });
}
