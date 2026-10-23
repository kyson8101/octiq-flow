// App-shell check of what an `ask_user` question shows, over the question
// and the answered line the host itself recorded
// (`web/src/lib/__fixtures__/host/question_media_pending.json`,
// `question_answered_media.json`).
//
//   ask       the question in the transcript: an image with its caption, a
//             video, a recording and a picture that will not load under the
//             heading; `Keep` with a picture in its row, `Change` without
//   answered  the same question answered: the line's folded thumbnails, then
//             the line opened
//
// What a press does, which no render test can show:
//   - the block's height is known before a picture arrives: the button under
//     it does not move when the pictures land;
//   - a press on a picture under the question, and on the control beside an
//     option's picture, opens the shared viewer and selects nothing; Escape
//     shuts it;
//   - a press on the picture inside an option's row selects that row;
//   - a picture that will not load leaves its name in words, and its place,
//     unframed, says it could not be shown: nothing under it moves;
//   - nothing reaches past the block's edge, and the page never scrolls
//     sideways.
//
// The host's question is changed in a copy only: its `chatKey` is set to the
// mock's chat, and a recording and a picture that will not load are added
// beside its image and video (the host test recorded two files). The files
// are this repo's own pictures (`assets/agents`), and a short video and
// recording ffmpeg makes at the start; without ffmpeg those two are served as
// failures and the run says so.
//
// The socket and `/file` are mocked; everything else is the real App and CSS.
//
//   OCTIQ_THEME=light|dark|fun|manga|guofeng|xp|cyberpunk   the appearance mode (dark)
//   OCTIQ_EVIDENCE_DIR=<dir>   where the screenshots go
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
const { chromium } = await import(moduleUrl(process.env.PLAYWRIGHT_MODULE || "playwright"));
const theme = process.env.OCTIQ_THEME || "dark";
const artifacts = process.env.OCTIQ_EVIDENCE_DIR || await mkdtemp(join(tmpdir(), "octiq-question-media-"));
await mkdir(artifacts, { recursive: true });

const SIZES = [{ name: "1280", width: 1280, height: 900, phone: false }, { name: "390", width: 390, height: 844, phone: true }];
const fixture = async (file) => JSON.parse(await readFile(join(webRoot, "src/lib/__fixtures__/host", `${file}.json`), "utf8"));

/* ---- The files ------------------------------------------------------------- */

const scratch = await mkdtemp(join(tmpdir(), "octiq-question-media-files-"));
let played = true;
try {
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=24:duration=2", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(scratch, "take.mp4")]);
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "aac", join(scratch, "voice.m4a")]);
} catch {
  played = false;
}

const pending = await fixture("question_media_pending");
const line = await fixture("question_answered_media");
const [home, take] = pending.media;
const face = pending.options[0].image;
const voice = { ...take, id: "c0ffee00c0ffee00c0ffee00c0ffee00", kind: "audio", mime: "audio/mp4", name: "voice.m4a", path: take.path.replace(/[^/]+$/, "c0ffee00c0ffee00c0ffee00c0ffee00.m4a"), bytes: 33_000, caption: "How the new chime sounds" };
const lost = { ...home, id: "dead0000dead0000dead0000dead0000", name: "gone.png", path: home.path.replace(/[^/]+$/, "dead0000dead0000dead0000dead0000.png"), caption: undefined };
/** The bytes `/file` answers for each snapshot path; a path not here is 404. */
const FILES = new Map([
  [home.path, { file: join(repoRoot, "assets/agents/frontend.png"), type: "image/png" }],
  [face.path, { file: join(repoRoot, "assets/agents/architect.png"), type: "image/png" }],
  ...(played ? [
    [take.path, { file: join(scratch, "take.mp4"), type: "video/mp4" }],
    [voice.path, { file: join(scratch, "voice.m4a"), type: "audio/mp4" }],
  ] : []),
]);

const question = { ...pending, chatKey: "chat:main", media: [home, take, voice, lost] };
/** The call as the agent made it: paths, which the host snapshotted. */
const call = (result) => ({
  kind: "tool", id: "toolu_ask", name: "mcp__octiq__ask_user", argsJson: "{}", state: result ? "done" : "running", ...(result ? { result } : {}),
  args: { question: pending.question, media: [{ path: "/abs/home.png" }, { path: "/abs/take.mp4" }], options: [{ label: "Keep", image: "/abs/face.png" }, "Change"] },
});

function mock(scene) {
  const stamp = 1792461219629;
  const main = { id: "main", projectId: "octiq", title: "Home screen layout", customTitle: true, modelId: "claude:opus", access: "auto", sessionId: "session-main", cwd: repoRoot, createdAt: stamp - 600_000, updatedAt: stamp };
  const lead = { kind: "text", text: "Before I change the layout, one thing." };
  const messages = scene === "ask"
    ? [{ id: "m1", role: "assistant", streaming: false, blocks: [lead, call()] }]
    : [
        { id: "m1", role: "assistant", streaming: false, blocks: [lead, call("Keep")] },
        // The host's line, as the reducer keeps it (`chat.ts`, `octiq-answered-<id>`).
        { id: `octiq-answered-${line.id}`, role: "assistant", streaming: false, blocks: [{ kind: "answered", answered: { ...line, questions: line.questions.map((q) => ({ ...q, media: [...q.media, voice] })) } }] },
        { id: "m2", role: "assistant", streaming: false, blocks: [{ kind: "text", text: "Keeping it. Moving on." }] },
      ];
  const stored = [{ ...main, messages }];
  const resultFor = (request) => {
    switch (request.cmd) {
      case "list_workspaces": return [{ id: "octiq", name: "octiq-flow", primary_path: repoRoot }];
      case "chat_index_list": return [main];
      case "chat_index_deleted": return [];
      case "chat_page": return { events: [], context: [], before: null };
      case "question_pending": return scene === "ask" ? [question] : [];
      case "chat_list": case "chat_activity": case "permission_pending": case "safety_block_pending":
      case "pr_repositories": case "codex_skills": case "access_request_pending":
        return [];
      case "team_list": return [];
      case "chat_queue_state": return { live: false, queuedTurnIds: [] };
      case "orchestration_snapshot": return { runs: [], tasks: [], attempts: [], gates: [], messages: [] };
      case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
      case "usage_summary": return {};
      case "agent_installs": return [{ id: "claude", installed: true, path: "/mock/claude" }];
      case "pr_local_list": case "pr_remote_list": return { items: [], warnings: [] };
      case "git_status_summary": return [{ path: repoRoot, repo_root: repoRoot, is_repo: true, branch: "develop", changed: 0, ahead: 0, behind: 0 }];
      case "git_local_branches": return { is_repo: true, current: "develop", branches: ["develop"], is_worktree: false };
      case "chat_task": return { chatId: request.args?.chatId, projectId: "octiq" };
      default: return null;
    }
  };
  return { stored, resultFor };
}

const server = await createServer({ root: webRoot, configFile: join(webRoot, "vite.config.ts"), server: { host: "127.0.0.1", port: 0, strictPort: false, fs: { strict: false } } });
const errors = [];
const report = { artifacts, theme, played, scenes: {} };

async function open(browser, scene, { width, height, phone }) {
  const { stored, resultFor } = mock(scene);
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce", ...(phone ? { hasTouch: true, isMobile: true } : {}) });
  await context.addInitScript(({ chats, mode }) => {
    localStorage.setItem("octiq.v2.gitColumn", "0");
    localStorage.setItem("octiq.theme", mode);
    localStorage.setItem("octiq.v2.theme", mode);
    localStorage.setItem("octiq.v2.conversations", JSON.stringify(chats));
  }, { chats: stored, mode: theme });
  await context.route("**/token", (route) => route.fulfill({ body: "mock-token" }));
  await context.route("**/auth", (route) => route.fulfill({ body: "ok" }));
  // `/file`, held until `release()`: what a picture arriving late does to the
  // block is measured between the two.
  const held = [];
  let holding = true;
  const serve = async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path");
    const known = FILES.get(path);
    if (!known) return route.fulfill({ status: 404, body: "no such file" });
    return route.fulfill({ status: 200, contentType: known.type, body: await readFile(known.file) });
  };
  await context.route(/\/file\?/, (route) => (holding ? held.push(route) : serve(route)));
  const release = async () => { holding = false; await Promise.all(held.splice(0).map(serve)); };
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
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/#/p/octiq-flow/c/main`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  return { context, page, release };
}

const box = (locator) => locator.evaluate((el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; });
const noSidewaysScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
/** Every part of the strip inside the block's own edges. */
const inside = (page, scope) => page.evaluate((selector) => {
  const root = document.querySelector(selector);
  const edge = root.getBoundingClientRect();
  return [...root.querySelectorAll(".qa-media-item, .qa-media-box, .qa-row-shot, .qa-row-zoom, .qa-thumb, .qa-media-cap")]
    .filter((el) => el.getClientRects().length)
    .filter((el) => { const r = el.getBoundingClientRect(); return r.left < edge.left - 0.5 || r.right > edge.right + 0.5; })
    .map((el) => el.className);
}, scope);
/** Wait until every picture the scope draws has decoded. */
const pictures = (page, scope, count) => page.waitForFunction(({ selector, n }) => {
  const imgs = [...document.querySelectorAll(`${selector} img`)];
  return imgs.length >= n && imgs.every((img) => img.complete && img.naturalWidth > 0);
}, { selector: scope, n: count }, { timeout: 60_000 }).catch(async (error) => {
  // Say which picture never arrived.
  const seen = await page.evaluate((selector) => [...document.querySelectorAll(`${selector} img`)]
    .map((img) => ({ alt: img.alt, complete: img.complete, width: img.naturalWidth })), scope);
  throw new Error(`${scope}: wanted ${count} pictures decoded, saw ${JSON.stringify(seen)}: ${error.message}`);
});
const checked = (page) => page.evaluate(() => [...document.querySelectorAll(".qa-block input:checked")].map((input) => input.closest(".qa-row")?.querySelector(".qa-row-label")?.firstChild?.textContent));

async function askScene(browser, size) {
  const label = `ask ${size.name}`;
  const { context, page, release } = await open(browser, "ask", size);
  const out = {};
  const block = page.locator(".qa-block").first();
  await block.waitFor();
  await block.scrollIntoViewIfNeeded();
  await page.locator(".qa-media").first().waitFor();
  // Before anything arrives: every box is drawn at its size.
  const submitBefore = await box(page.locator(".qa-submit").first());
  const blockBefore = await box(block);
  out.imageBox = await box(page.locator(".qa-media-box.is-image").first());
  out.videoBox = played ? await box(page.locator(".qa-media-box.is-video").first()) : null;
  out.rowShot = await box(page.locator(".qa-row-shot").first());
  assert.equal(Math.round(out.imageBox.w), 168, `${label}: a picture's box is 168 wide before it arrives`);
  assert.equal(Math.round(out.imageBox.h), 112, `${label}: and 112 high`);
  assert.equal(Math.round(out.rowShot.w), 64, `${label}: an option's picture is a 64px square`);
  out.zoom = await box(page.locator(".qa-row-zoom").first());
  // The enlarge control is at the picture's top-right corner, never over its
  // middle, and covers at most a quarter of it: a press on most of the
  // picture is a press on the row.
  const [zoom, shot] = [out.zoom, out.rowShot];
  const shotMid = { x: (shot.l + shot.r) / 2, y: (shot.t + shot.b) / 2 };
  const covered = Math.max(0, Math.min(zoom.r, shot.r) - Math.max(zoom.l, shot.l)) * Math.max(0, Math.min(zoom.b, shot.b) - Math.max(zoom.t, shot.t));
  const where = JSON.stringify({ zoom, shot });
  assert.ok(zoom.l > shotMid.x && zoom.b < shotMid.y && zoom.r >= shot.r - 4 && zoom.t <= shot.t + 4, `${label}: the enlarge control sits at the picture's top-right corner, clear of its middle (${where})`);
  assert.ok(covered <= shot.w * shot.h / 4, `${label}: and covers at most a quarter of it (${covered} of ${shot.w * shot.h})`);
  out.coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
  if (out.coarse) assert.ok(zoom.w >= 32 && zoom.h >= 32, `${label}: a finger's enlarge control is at least 32px (${where})`);
  out.zoomCovers = Math.round(100 * covered / (shot.w * shot.h));
  out.middleHits = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".qa-row-zoom, label.qa-row")?.className ?? null, shotMid);
  assert.match(out.middleHits ?? "", /qa-row\b/, `${label}: the picture's middle is the row's (${out.middleHits})`);
  await page.screenshot({ path: join(artifacts, `${theme}-ask-waiting-${size.name}.png`) });

  await release();
  // A picture is asked for once it is near what the transcript's scroller
  // shows, as a reply's are: bring each box to the screen.
  for (const each of await page.locator(".qa-block .qa-media-box, .qa-block .qa-row-shot").all()) await each.scrollIntoViewIfNeeded();
  await pictures(page, ".qa-block", 2);
  // Players have their metadata or have failed.
  await page.waitForFunction(() => [...document.querySelectorAll(".qa-block video, .qa-block audio")].every((el) => el.readyState >= 1), null, { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(300);
  const submitAfter = await box(page.locator(".qa-submit").first());
  const blockAfter = await box(block);
  // Measured from the block's own top: the transcript scrolled in between.
  out.moved = { submit: (submitAfter.t - blockAfter.t) - (submitBefore.t - blockBefore.t), height: blockAfter.h - blockBefore.h };
  // The picture that will not load keeps its place, unframed, in words.
  const lostItem = page.locator('.qa-media-item[data-media="dead0000dead0000dead0000dead0000"]');
  const lostBox = lostItem.locator(".qa-media-box.is-failed");
  assert.equal(await lostBox.count(), 1, `${label}: a picture that will not load keeps its place`);
  assert.equal(await lostBox.locator("img").count(), 0, `${label}: with no picture in it`);
  assert.equal(await lostBox.evaluate((el) => getComputedStyle(el).borderTopColor), "rgba(0, 0, 0, 0)", `${label}: and no frame`);
  assert.match(await lostItem.innerText(), /Could not be shown\s+gone\.png · 316 B/, `${label}: its name stays in words`);
  assert.ok(Math.abs(out.moved.submit) < 1, `${label}: the button stays where it was as the files arrive (${out.moved.submit})`);
  assert.ok(Math.abs(out.moved.height) < 1, `${label}: and so does the block's height (${out.moved.height})`);
  if (played) {
    assert.equal(await page.locator(".qa-block video").count(), 1, `${label}: the video is a player`);
    assert.equal(await page.locator(".qa-block audio").count(), 1, `${label}: the recording is a player`);
    assert.equal(await page.locator(".qa-block video").getAttribute("preload"), "metadata");
    const videoAfter = await box(page.locator(".qa-media-box.is-video").first());
    assert.equal(Math.round(videoAfter.h), Math.round(out.videoBox.h), `${label}: the video's box keeps its height once it has its first frame`);
  }
  assert.deepEqual(await inside(page, ".qa-block"), [], `${label}: nothing reaches past the block`);
  assert.equal(await noSidewaysScroll(page), true, `${label}: no sideways scroll`);
  await page.screenshot({ path: join(artifacts, `${theme}-ask-${size.name}.png`) });
  await block.screenshot({ path: join(artifacts, `${theme}-ask-block-${size.name}.png`) });

  // A press on a picture under the question opens the viewer and selects nothing.
  assert.deepEqual(await checked(page), ["Keep"], `${label}: the recommended option is selected`);
  await page.locator("label.qa-row", { hasText: "Change" }).click();
  assert.deepEqual(await checked(page), ["Change"], `${label}: a press on a row selects it`);
  await page.locator(".qa-media-box.is-image").first().click();
  await page.locator('.viewer[role="dialog"]').waitFor();
  assert.equal(await page.locator(".viewer-name").innerText(), home.path.split("/").pop(), `${label}: the viewer shows the snapshot`);
  await page.screenshot({ path: join(artifacts, `${theme}-viewer-${size.name}.png`) });
  await page.keyboard.press("Escape");
  await page.locator(".viewer").waitFor({ state: "detached" });
  assert.deepEqual(await checked(page), ["Change"], `${label}: opening a picture selected nothing`);

  // The control beside an option's picture opens it and selects nothing.
  await page.locator(".qa-row-zoom").first().click();
  await page.locator('.viewer[role="dialog"]').waitFor();
  await page.keyboard.press("Escape");
  await page.locator(".viewer").waitFor({ state: "detached" });
  assert.deepEqual(await checked(page), ["Change"], `${label}: the enlarge control selected nothing`);
  // The picture inside the row is the row.
  await page.locator(".qa-row-shot").first().click();
  assert.deepEqual(await checked(page), ["Keep"], `${label}: a press on the picture in a row selects that row`);
  assert.equal(await page.locator(".qa-submit").getAttribute("aria-disabled"), "false");
  report.scenes[label] = out;
  await context.close();
}

async function answeredScene(browser, size) {
  const label = `answered ${size.name}`;
  const { context, page, release } = await open(browser, "answered", size);
  await release();
  const out = {};
  const line = page.locator(".qa-media-line").first();
  await line.waitFor();
  await line.scrollIntoViewIfNeeded();
  await pictures(page, ".qa-thumbs", 2);
  out.thumbs = await page.locator(".qa-thumb").evaluateAll((els) => els.map((el) => ({ cls: el.className, w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height), text: el.textContent })));
  assert.equal(out.thumbs.filter((t) => t.cls.includes("is-image")).length, 2, `${label}: two picture thumbnails (the question's and the chosen option's)`);
  assert.deepEqual(out.thumbs.filter((t) => t.cls.includes("is-named")).map((t) => t.text), ["take.mp4", "voice.m4a"], `${label}: players by kind and name`);
  assert.ok(out.thumbs.every((t) => t.h === 28), `${label}: every thumbnail is 28 high`);
  assert.match(await line.innerText(), /2 images, 1 video, 1 recording/);
  const toggle = line.locator(".card-fold-toggle");
  assert.equal(await toggle.getAttribute("aria-expanded"), "false", `${label}: folded`);
  assert.equal(await page.locator(".qa-media-opened").count(), 0, `${label}: the full media is not drawn while folded`);
  assert.equal(await page.locator(".qa-asked details, .qa-asked [aria-expanded]").count(), 1, `${label}: one disclosure on the line`);
  assert.deepEqual(await inside(page, ".qa-asked"), [], `${label}: nothing reaches past the line`);
  await page.screenshot({ path: join(artifacts, `${theme}-answered-${size.name}.png`) });

  await toggle.click();
  await page.locator(".qa-media-opened").waitFor();
  for (const each of await page.locator(".qa-media-opened .qa-media-box").all()) await each.scrollIntoViewIfNeeded();
  await pictures(page, ".qa-media-opened", 2);
  assert.match(await page.locator(".qa-media-opened").innerText(), /Chosen · Keep/);
  assert.deepEqual(await inside(page, ".qa-asked"), [], `${label}: nothing reaches past the opened line`);
  assert.equal(await noSidewaysScroll(page), true, `${label}: no sideways scroll`);
  await page.locator(".qa-media-opened").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifacts, `${theme}-answered-open-${size.name}.png`) });
  report.scenes[label] = out;
  await context.close();
}

let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  for (const size of SIZES) {
    await askScene(browser, size);
    await answeredScene(browser, size);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, mockedBackend: true, ...report }, null, 1));
} catch (error) {
  const page = browser?.contexts().at(-1)?.pages().at(-1);
  await page?.screenshot({ path: join(artifacts, `${theme}-failure.png`), fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ error: String(error), errors, report }, null, 1));
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
