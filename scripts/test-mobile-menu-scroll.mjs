// App-shell regression for the phone Chats menu (New conversation … Settings)
// that folds away as the chat list scrolls down and comes back on the way up.
//
// It used to spring back open at the BOTTOM of the list. Nothing the person
// did moved the list up there; the browser did:
//   * iOS lets a flick run past the end and springs back (rubber-banding), and
//     reports the overshoot in scrollTop. The spring-back read as a scroll UP.
//   * a list that gets shorter while you sit at its end (a chat leaves the
//     view, a row loses a line), or a viewport that gets taller, pulls
//     scrollTop down to the new end — again a "scroll up" nobody made.
//
// The socket is mocked; the list, the scroll handler and the CSS are the real
// App. This checks, in Chromium and WebKit, at 375 and 430 wide:
//   * a long list hides the menu going down and it stays hidden at the end,
//     through a rubber-band spring-back, a shrinking list and a taller viewport;
//   * a real scroll up from the end still brings it back, over the rows, with
//     no change to scrollTop, and going down hides it again;
//   * focusing a menu control brings it back; the top of the list shows it in
//     place;
//   * a list too short to scroll never moves the menu;
//   * reduced motion drops the slide;
//   * the desktop column's menu never folds away.
//
// There is no iPhone here. The rubber-band case replays an iOS-shaped
// scrollTop trace through the real handler, because no desktop engine
// overshoots; the shrinking-list and taller-viewport cases are the browsers'
// own clamping, not a replay.
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const engines = (process.env.BROWSERS || "chromium,webkit").split(",").map((name) => name.trim()).filter(Boolean);
const artifacts = process.env.OCTIQ_EVIDENCE_DIR
  || await mkdtemp(join(tmpdir(), "octiq-mobile-menu-scroll-"));
await mkdir(artifacts, { recursive: true });

const now = Date.now();
const chat = (index) => ({
  id: `chat-${index}`, projectId: "general", title: `Conversation number ${index + 1}`, customTitle: true,
  modelId: "claude:opus", access: "auto", sessionId: `session-${index}`,
  createdAt: now - 600_000 - index * 60_000, updatedAt: now - index * 60_000,
});
const LONG = Array.from({ length: 36 }, (_, index) => chat(index));
let chats = LONG;

const errors = [];
const failures = [];
const sockets = new Set();
const server = await createServer({
  root: new URL("../web", import.meta.url).pathname,
  configFile: new URL("../web/vite.config.ts", import.meta.url).pathname,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

function resultFor(request) {
  switch (request.cmd) {
    case "list_workspaces": return [{ id: "general", name: "General", primary_path: "/General" }];
    case "chat_index_list": return chats;
    case "chat_index_deleted": return [];
    case "chat_page": return { events: [], context: [], before: null };
    case "chat_list": return [];
    case "chat_activity": return [];
    case "chat_queue_state": return { live: false, queuedTurnIds: [] };
    case "orchestration_snapshot": return { runs: [], tasks: [], attempts: [], gates: [], messages: [] };
    case "sandbox_snapshot": return { defaultEnabled: false, environments: {} };
    case "permission_pending": return [];
    case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
    case "usage_summary": return {};
    case "agent_installs": return [{ id: "claude", installed: true, path: "/mock/claude" }];
    case "chat_task": return { chatId: request.args?.chatId, projectId: "general" };
    case "codex_skills": return [];
    default: return null;
  }
}
const send = (event, payload) => {
  for (const socket of sockets) socket.send(JSON.stringify({ t: "event", event, payload }));
};

// Collected rather than thrown, so a run against the old code lists every
// case it gets wrong instead of stopping at the first.
function check(label, ok, detail) {
  if (!ok) failures.push(`${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}`);
}

const SCROLLER = ".task-sidebar .task-chat-scroll";
const menu = (page) => page.evaluate((selector) => {
  const scroller = document.querySelector(selector);
  const bar = document.getElementById("chats-navigation");
  const box = bar.getBoundingClientRect();
  const frame = scroller.getBoundingClientRect();
  const style = getComputedStyle(bar);
  return {
    top: scroller.scrollTop,
    range: scroller.scrollHeight - scroller.clientHeight,
    floating: bar.classList.contains("is-floating"),
    hidden: bar.classList.contains("is-hidden"),
    // On screen = inside the list's frame and not faded out.
    shown: style.opacity !== "0" && box.bottom > frame.top + 1 && box.top < frame.bottom,
    barTop: Math.round(box.top - frame.top),
    position: style.position,
    transform: style.transform,
    opacity: style.opacity,
    transition: style.transitionDuration,
  };
}, SCROLLER);

async function settle(page) {
  let last = -1;
  let still = 0;
  for (let index = 0; index < 60 && still < 3; index += 1) {
    const top = await page.evaluate((selector) => document.querySelector(selector).scrollTop, SCROLLER);
    still = Math.abs(top - last) < 0.5 ? still + 1 : 0;
    last = top;
    await page.waitForTimeout(50);
  }
  // Let the menu's own slide finish, however slow the machine is.
  await page.waitForTimeout(50);
  await page.evaluate(() => Promise.all(document.getElementById("chats-navigation")
    .getAnimations().map((animation) => animation.finished.catch(() => {}))));
}

// The list moved a step a frame, the way a finger drags it: each step is a
// real scroll of the real scroller, so the engine clamps it and fires its own
// scroll event. (Headless Chromium drops synthetic wheel input over this list
// often enough to make wheel-driven checks flaky, so the wheel is not used.)
async function wheel(page, deltaY, steps) {
  await page.evaluate(async ({ selector, deltaY, steps }) => {
    const scroller = document.querySelector(selector);
    for (let index = 0; index < steps; index += 1) {
      scroller.scrollTop += deltaY;
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, { selector: SCROLLER, deltaY, steps });
  await settle(page);
}
async function toBottom(page) {
  for (let index = 0; index < 40; index += 1) {
    const state = await menu(page);
    if (state.top >= state.range - 1) return;
    await wheel(page, 40, 20);
  }
  throw new Error("never reached the bottom of the list");
}
// Chromium only: a real touch fling, momentum and all, through the
// compositor. The finger moves UP to scroll the list down.
async function fling(page, distance) {
  const frame = await page.locator(SCROLLER).boundingBox();
  const session = await page.context().newCDPSession(page);
  await session.send("Input.synthesizeScrollGesture", {
    x: Math.round(frame.x + frame.width / 2), y: Math.round(frame.y + frame.height * 0.6),
    yDistance: -distance, speed: 3000, gestureSourceType: "touch", preventFling: false,
  });
  await session.detach();
  await settle(page);
}

// What an iPhone reports when a flick runs out at the end of an overflow
// list: scrollTop goes PAST the end, then springs back to it. No desktop
// engine does this, so the trace is fed through the real scroll handler.
function bounceAtBottom(page) {
  return page.evaluate(async (selector) => {
    const scroller = document.querySelector(selector);
    const end = scroller.scrollHeight - scroller.clientHeight;
    for (const past of [6, 18, 31, 42, 48, 44, 35, 24, 14, 6, 1, 0]) {
      Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => end + past });
      scroller.dispatchEvent(new Event("scroll"));
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    }
    delete scroller.scrollTop;
  }, SCROLLER);
}

let browser;
try {
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}/`;

  for (const engine of engines) {
    browser = await playwright[engine].launch({ headless: true });

    async function open(viewport, { reducedMotion = "no-preference", list = LONG } = {}) {
      chats = list;
      const context = await browser.newContext({ viewport, reducedMotion, deviceScaleFactor: 2, hasTouch: viewport.width < 860 });
      await context.addInitScript(() => {
        if (location.protocol === "about:") return;
        localStorage.setItem("octiq.v2.gitColumn", "0");
        localStorage.setItem("octiq.theme", "dark");
      });
      await context.route("**/token", (route) => route.fulfill({ body: "mock-token" }));
      await context.route("**/auth", (route) => route.fulfill({ body: "ok" }));
      await context.routeWebSocket(/.*/, (socket) => {
        sockets.add(socket);
        socket.onMessage((raw) => {
          const request = JSON.parse(String(raw));
          if (request.t !== "invoke") return;
          socket.send(JSON.stringify({ t: "reply", id: request.id, ok: true, result: resultFor(request) }));
        });
        socket.onClose(() => sockets.delete(socket));
      });
      const page = await context.newPage();
      page.setDefaultTimeout(30_000);
      page.on("pageerror", (error) => errors.push(`${engine}: ${error.stack ?? error}`));
      // The first load has vite compile the whole app, which is slow on a busy
      // machine; later loads come from its cache.
      await page.goto(`${base}#/p/general`, { waitUntil: "domcontentloaded", timeout: 120_000 });
      if (viewport.width < 860) {
        const show = page.getByRole("button", { name: "Show chats" });
        await show.first().waitFor({ timeout: 10_000 }).catch(() => {});
        if (await show.count()) await show.first().click();
      }
      await page.locator(".sidebar .chat").first().waitFor();
      await page.waitForTimeout(300);
      return { context, page };
    }

    for (const [width, height] of [[375, 667], [430, 932]]) {
      const tag = `${engine} ${width}`;
      const shot = (page, name) => page.screenshot({ path: join(artifacts, `${engine}-${width}-${name}.png`) });
      const { context, page } = await open({ width, height });

      const start = await menu(page);
      check(`${tag}: a long list starts with the menu in place`, start.shown && !start.floating && !start.hidden, start);

      await toBottom(page);
      const bottom = await menu(page);
      check(`${tag}: scrolling down to the end folds the menu away`, bottom.floating && bottom.hidden && !bottom.shown, bottom);
      await shot(page, "1-bottom");

      await bounceAtBottom(page);
      await settle(page);
      const bounced = await menu(page);
      check(`${tag}: a rubber-band spring-back at the end leaves it folded`, bounced.hidden && !bounced.shown, bounced);
      await shot(page, "2-after-bounce");

      // Four chats leave the list while it sits at the end: the browser pulls
      // scrollTop down to the new end.
      const rows = await page.locator(".sidebar .chat").count();
      chats = LONG.slice(0, LONG.length - 4);
      send("chat-index-changed", {});
      await page.waitForFunction((count) => document.querySelectorAll(".sidebar .chat").length < count, rows);
      await settle(page);
      const shrunk = await menu(page);
      check(`${tag}: the list really did pull scrollTop down`, shrunk.top < bounced.top - 12, { before: bounced.top, after: shrunk.top });
      check(`${tag}: a shorter list at the end leaves it folded`, shrunk.hidden && !shrunk.shown, shrunk);
      await shot(page, "3-after-shrink");

      // The viewport gets taller at the end (a toolbar or keyboard going away).
      await page.setViewportSize({ width, height: height + 120 });
      await settle(page);
      const taller = await menu(page);
      check(`${tag}: the taller viewport really did pull scrollTop down`, taller.top < shrunk.top - 12, { before: shrunk.top, after: taller.top });
      check(`${tag}: a taller viewport at the end leaves it folded`, taller.hidden && !taller.shown, taller);
      await page.setViewportSize({ width, height });
      await settle(page);

      // A real scroll up still brings it back, over the rows, and the list
      // does not move under it.
      await toBottom(page);
      const end = await menu(page);
      await wheel(page, -30, 2);
      const revealed = await menu(page);
      check(`${tag}: scrolling up from the end brings the menu back`, revealed.floating && !revealed.hidden && revealed.shown, revealed);
      check(`${tag}: it comes back over the rows, at the top of the list`, Math.abs(revealed.barTop) <= 1 && revealed.position === "sticky", revealed);
      check(`${tag}: bringing it back does not move the list`,
        revealed.top === end.top - 60 && revealed.range === end.range, { end, now: revealed });
      await shot(page, "4-scrolled-up");
      await wheel(page, 60, 2);
      const again = await menu(page);
      check(`${tag}: going down again folds it away`, again.hidden && !again.shown, again);

      // The keyboard can always reach it.
      await page.locator("#chats-navigation").getByRole("button", { name: "Search chats" }).focus();
      await settle(page);
      let focused = await menu(page);
      for (let index = 0; index < 20 && !focused.shown; index += 1) {
        await page.waitForTimeout(100);
        focused = await menu(page);
      }
      check(`${tag}: focusing a menu control brings it back`, !focused.hidden && focused.shown, focused);
      await page.locator(".sidebar .chat .chat-btn").last().focus();

      // All the way back to the top: in place, not floating.
      for (let index = 0; index < 30 && (await menu(page)).top > 0; index += 1) await wheel(page, -240, 6);
      const top = await menu(page);
      check(`${tag}: the top of the list shows the menu in place`, top.top === 0 && !top.floating && !top.hidden && top.shown, top);
      await context.close();

      // Chromium can fling with a finger, momentum included, through the
      // compositor. It glows at the end rather than bouncing, so this is the
      // momentum half of the story; the bounce is the replay above.
      if (engine === "chromium") {
        const { context: touchContext, page: touchPage } = await open({ width, height });
        for (let index = 0; index < 20; index += 1) {
          const state = await menu(touchPage);
          if (state.top >= state.range - 1) break;
          await fling(touchPage, 600);
        }
        const flung = await menu(touchPage);
        check(`${tag}: a touch fling that runs out at the end leaves it folded`,
          flung.top >= flung.range - 1 && flung.hidden && !flung.shown, flung);
        await fling(touchPage, -160);
        const pulled = await menu(touchPage);
        check(`${tag}: a touch drag back up brings it back`, !pulled.hidden && pulled.shown && pulled.top < flung.top, pulled);
        await touchPage.screenshot({ path: join(artifacts, `${engine}-${width}-5-touch-up.png`) });
        await touchContext.close();
      }

      // A list too short to scroll never moves it.
      {
        const { context: shortContext, page: shortPage } = await open({ width, height }, { list: LONG.slice(0, 2) });
        await wheel(shortPage, 120, 4);
        const short = await menu(shortPage);
        check(`${tag}: a list too short to scroll leaves the menu alone`, short.range <= 0 && !short.floating && !short.hidden && short.shown, short);
        await shortContext.close();
      }

      // Reduced motion: it still folds away, without the slide.
      {
        const { context: calmContext, page: calmPage } = await open({ width, height }, { reducedMotion: "reduce" });
        await toBottom(calmPage);
        const calm = await menu(calmPage);
        check(`${tag}: reduced motion still folds it away`, calm.hidden && !calm.shown, calm);
        // The app's reduced-motion reset leaves a token 0.01ms rather than 0s.
        check(`${tag}: reduced motion has no slide`,
          calm.transition.split(",").every((part) => parseFloat(part) < 0.001), calm.transition);
        await calmContext.close();
      }
    }

    // Desktop: the column's menu is ordinary layout and never folds away.
    {
      const { context, page } = await open({ width: 1440, height: 900 });
      const before = await page.locator("#chats-navigation").boundingBox();
      const content = await page.locator(".task-sidebar .task-chat-content").boundingBox();
      await page.mouse.move(content.x + content.width / 2, content.y + content.height / 2);
      for (let index = 0; index < 20; index += 1) { await page.mouse.wheel(0, 240); await page.waitForTimeout(30); }
      await settle(page);
      const scrolled = await page.locator(".task-sidebar .task-chat-content").evaluate((el) => el.scrollTop);
      const after = await page.locator("#chats-navigation").boundingBox();
      const state = await menu(page);
      check(`${engine} 1440: the chat list scrolls under a menu that never moves`,
        scrolled > 0 && Math.abs(after.y - before.y) < 1 && state.position !== "sticky" && state.shown, { scrolled, before, after, state });
      await page.screenshot({ path: join(artifacts, `${engine}-1440-scrolled.png`) });
      await context.close();
    }

    await browser.close();
    browser = undefined;
  }

  check("no page errors", errors.length === 0, errors);
  assert.deepEqual(failures, [], `\n${failures.join("\n")}`);
  console.log(`mobile menu scroll: ok — evidence in ${artifacts}`);
} finally {
  await browser?.close();
  await server.close();
}
