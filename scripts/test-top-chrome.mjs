// App-shell check of the chrome above a chat: the top bar (the page's name
// and nothing else), the action bar under it, a desktop's usage row under
// that, and a phone's chat list, whose places menu scrolls away with the list.
//
// The socket is mocked; the top bar, the bars, the sidebar and the sheets are
// the real App, served by Vite from web/. It checks, in the browsers named by
// BROWSERS (chromium by default):
//   * a desktop draws three rows of fixed height, every action as a button
//     with an icon and a short word, and puts what does not fit behind More,
//     with what waits on the person counted on More;
//   * the usage row draws every window the host reports, never Antigravity,
//     and opens the full breakdown by a press;
//   * a phone's action bar scrolls sideways at one height with 44px targets
//     and no scrollbar, and its usage entry ends the bar;
//   * the bars are where they will be before the chat list and the ledger
//     answer: the layout shift of a cold open is printed, and bounded;
//   * a phone's places menu leaves with the list and comes back only at the
//     top; a desktop's stays put while the list scrolls;
//   * a wider font (WIDE_FONT=1 stands in for Segoe UI) moves buttons behind
//     More and never wraps or grows a bar;
//   * scrollbars that take room add nothing to the height of a bar.
//     CLASSIC_SCROLLBARS=1 starts Chromium with the 15px classic ones a
//     Windows browser draws (a Mac's are overlays and take none); the report
//     says how much room one takes (`classicScrollbar`).
//
// OCTIQ_WEB_ROOT points it at another copy of web/, and SHOTS_ONLY=1 takes
// the same screenshots with no assertions: that is how the "before" pictures
// of an older tree are made.
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
const playwright = await import(moduleUrl(process.env.PLAYWRIGHT_MODULE || "playwright"));
const engines = (process.env.BROWSERS || "chromium").split(",").map((name) => name.trim()).filter(Boolean);
const shotsOnly = process.env.SHOTS_ONLY === "1";
const wideFont = process.env.WIDE_FONT === "1";
const classic = process.env.CLASSIC_SCROLLBARS === "1";
const theme = process.env.OCTIQ_THEME || "dark";
const artifacts = process.env.OCTIQ_EVIDENCE_DIR || await mkdtemp(join(tmpdir(), "octiq-top-chrome-"));
await mkdir(artifacts, { recursive: true });

const now = Date.now();
const root = "/Users/kyson/03-projects/octiq-flow";
const title = "Quieten the area above the chat composer in the OctiqFlow web client: fix the removed-folder banner whose text spills out of its box, shorten it and the background-task notice to one short line each with the detail behind a disclosure or tooltip, and make the stacked rows read as one calm group.";
const head = {
  id: "head", name: "OCTIQ HEAD", role: "Lead", agent: "claude", model: "opus",
  effort: "high", access: "auto", projectId: "octiq", createdAt: now - 900_000, updatedAt: now - 900_000,
};
const filler = Array.from({ length: 40 }, (_, i) => ({
  id: `chat-${i}`, projectId: "octiq", title: `Conversation ${i + 1}`, customTitle: true, modelId: "claude:opus",
  access: "auto", sessionId: `session-${i}`, createdAt: now - 2_000_000 + i, updatedAt: now - 100_000 - 1_000 * i,
}));
const main = {
  id: "main", projectId: "octiq", title, customTitle: true, modelId: "claude:opus", access: "auto",
  sessionId: "session-main", cwd: root, createdAt: now - 500_000, updatedAt: now - 1_000, coordinatesRun: true,
};
const chats = [main, ...filler];
const said = (id, text) => ({
  id: `message-${id}`, role: "assistant", streaming: false, blocks: [{ kind: "text", text }],
});
const localChats = chats.map((chat) => ({ ...chat, messages: [said(chat.id, chat.id === "main" ? "The plan is ready." : "Done.")] }));
const task = (id, status, more = {}) => ({
  id, runId: "run-1", title: `Task ${id}`, spec: "Do the thing.", dependsOn: [], status,
  destination: { projectId: "octiq", projectName: "OctiqFlow", repository: root },
  createdAt: now - 400_000, updatedAt: now - 20_000, ...more,
});
const snapshot = {
  runs: [{
    id: "run-1", coordinatorChatKey: "chat:main", objective: title, workspaceId: "octiq", rootPath: root,
    status: "running", maxConcurrent: 2, createdAt: now - 450_000, updatedAt: now - 20_000,
  }],
  tasks: [task("a", "completed"), task("b", "ready"), task("c", "ready")],
  attempts: [],
  gates: [
    { id: "gate-1", runId: "run-1", createdByChatKey: "chat:main", targetChatKey: "chat:main", question: "Ship it?",
      options: ["Yes", "No"], status: "open", awaits: "person", createdAt: now - 30_000, updatedAt: now - 30_000 },
    { id: "gate-2", runId: "run-1", createdByChatKey: "chat:main", targetChatKey: "chat:main", question: "Which base?",
      options: ["develop", "main"], status: "open", awaits: "person", createdAt: now - 25_000, updatedAt: now - 25_000 },
  ],
  messages: [], notifications: [],
};
const usage = {
  claude: {
    available: true, plan: "max",
    fiveHour: { percent: 53, resetsAt: Math.round(now / 1000) + 2 * 3600 + 40 * 60 },
    weekly: { percent: 64, resetsAt: Math.round(now / 1000) + 3 * 86400 },
    models: [
      { name: "opus", percent: 88, resetsAt: Math.round(now / 1000) + 3 * 86400 },
      { name: "fable", percent: 21, resetsAt: Math.round(now / 1000) + 3 * 86400 },
    ],
  },
  codex: { available: true, plan: "pro", weekly: { percent: 30, resetsAt: Math.round(now / 1000) + 5 * 86400 } },
};

/** What the mocked host answers, and how late: the bars must not wait on it. */
let delays = {};
let usageAnswer = usage;
function resultFor(request) {
  switch (request.cmd) {
    case "list_workspaces": return [{ id: "octiq", name: "octiq-flow", primary_path: root }];
    case "chat_index_list": return chats;
    case "chat_index_deleted": return [];
    case "chat_page": return { events: [], context: [], before: null };
    case "chat_list": case "chat_activity": case "permission_pending": case "question_pending":
    case "safety_block_pending": case "pr_repositories": case "codex_skills":
      return [];
    case "team_list": return [head];
    case "team_head": return head;
    case "team_leads": return [{ chatKey: "chat:main", leadId: head.id, leadName: head.name, projectId: "octiq", crossProject: false, createdAt: now - 500_000 }];
    case "team_home": return "octiq";
    case "chat_queue_state": return { live: false, queuedTurnIds: [] };
    case "orchestration_snapshot": return snapshot;
    case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
    case "usage_summary": return usageAnswer;
    case "agent_installs": return [{ id: "claude", installed: true, path: "/mock/claude" }, { id: "antigravity", installed: true, path: "/mock/agy" }];
    case "pr_local_list": case "pr_remote_list": return { items: [], warnings: [] };
    case "agent_avatar_status": return { available: false, reason: "Not signed in to Codex." };
    case "git_status_summary": return [{ path: root, repo_root: root, is_repo: true, branch: "develop", changed: 3, ahead: 1, behind: 0 }];
    case "git_local_branches": return { is_repo: true, current: "develop", branches: ["develop"], is_worktree: false };
    case "chat_task": return {
      chatId: request.args?.chatId, projectId: "octiq",
      workspace: { cwd: root, exists: true, isRepo: true, repoRoot: root, primaryRoot: root, branch: "develop", isWorktree: false, changed: 3, ahead: 1, behind: 0, hasUpstream: true },
    };
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
const report = { artifacts, theme, wideFont, engines: {} };

/** A page at one size, with the socket mocked. `seed` is what this browser
 *  remembers of the chats (a cold browser remembers none). */
async function open(browser, { width, height, phone = false, seed = true, hash = "#/p/octiq-flow/c/main" }) {
  const context = await browser.newContext({
    viewport: { width, height }, reducedMotion: "reduce",
    ...(phone ? { hasTouch: true, isMobile: browser.browserType().name() !== "firefox" } : {}),
  });
  await context.addInitScript(({ chats: stored, seeded, mode, wide }) => {
    localStorage.setItem("octiq.agentsMode", "on");
    localStorage.setItem("octiq.v2.gitColumn", "0");
    localStorage.setItem("octiq.theme", mode);
    localStorage.setItem("octiq.v2.theme", mode);
    if (seeded) localStorage.setItem("octiq.v2.conversations", JSON.stringify(stored));
    // Layout shift, from the first frame.
    window.__shift = { total: 0, entries: [] };
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.hadRecentInput) continue;
          window.__shift.total += entry.value;
          window.__shift.entries.push({
            value: entry.value, at: Math.round(entry.startTime),
            nodes: (entry.sources || []).map((source) => source.node?.className || source.node?.nodeName || "?").slice(0, 4),
          });
        }
      }).observe({ type: "layout-shift", buffered: true });
    } catch { window.__shift.unsupported = true; }
    // A wider font stands in for a Windows fallback (Segoe UI is wider than SF).
    if (wide) addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = "*, *::before, *::after { font-family: Verdana, sans-serif !important; letter-spacing: 0.02em !important; }";
      document.head.append(style);
    });
  }, { chats: localChats, seeded: seed, mode: theme, wide: wideFont });
  await context.route("**/token", (route) => route.fulfill({ body: "mock-token" }));
  await context.route("**/auth", (route) => route.fulfill({ body: "ok" }));
  await context.routeWebSocket(/.*/, (socket) => socket.onMessage((raw) => {
    const request = JSON.parse(String(raw));
    if (request.t !== "invoke") return;
    const answer = () => socket.send(JSON.stringify({ t: "reply", id: request.id, ok: true, result: resultFor(request) }));
    const wait = delays[request.cmd] ?? 0;
    if (wait) setTimeout(answer, wait); else answer();
  }));
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  page.on("pageerror", (error) => errors.push(error.stack ?? String(error)));
  const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
  await page.goto(`${base}${hash}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  return { context, page };
}

const box = (page, selector) => page.evaluate((sel) => {
  const element = document.querySelector(sel);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };
}, selector);
/** Every button of the action bar's row, as drawn. */
const buttons = (page) => page.evaluate(() => [...document.querySelectorAll(".actionbar-row > .actionbar-item, .actionbar-row > .mobile-actions")]
  .filter((item) => item.getBoundingClientRect().width > 0)
  .map((item) => {
    const control = item.querySelector("button");
    const rect = control.getBoundingClientRect();
    return {
      id: item.dataset.action ?? "more",
      label: (control.querySelector(".topbar-action-label")?.textContent ?? "").trim(),
      name: control.getAttribute("aria-label") ?? "",
      icon: !!control.querySelector("svg"),
      w: Math.round(rect.width), h: Math.round(rect.height),
      top: Math.round(rect.top), bottom: Math.round(rect.bottom), right: Math.round(rect.right),
    };
  }));
const settle = (page, ms = 350) => page.waitForTimeout(ms);
/** The chat is drawn and the bars' entry gates have opened and finished. */
async function ready(page) {
  await page.locator(".main").getByText("The plan is ready.", { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector(".actionbar.gate-held, .actionbar.gate-entering, .usage-strip.gate-held, .usage-strip.gate-entering, .usage.gate-held, .usage.gate-entering")
    && [...document.querySelectorAll(".actionbar-item button")].every((each) => getComputedStyle(each).visibility === "visible"));
  await page.waitForTimeout(600);
}
const shift = (page) => page.evaluate(() => window.__shift);

async function desktop(browser, name, out) {
  const { context, page } = await open(browser, { width: 1280, height: 800 });
  if (shotsOnly) { await page.locator(".main").getByText("The plan is ready.", { exact: true }).waitFor(); await settle(page, 1500); }
  else await ready(page);
  await page.screenshot({ path: join(artifacts, `${name}-1280-chat.png`) });
  if (shotsOnly) { await context.close(); return out; }

  // Whether this browser draws classic scrollbars, the kind that take room
  // (Windows): the sideways scrollers below must not grow by one.
  out.classicScrollbar = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.cssText = "position:absolute;top:-999px;width:100px;height:100px;overflow:scroll";
    document.body.append(probe);
    const taken = probe.offsetHeight - probe.clientHeight;
    probe.remove();
    return taken;
  });

  // Three rows, each its own fixed height, in this order.
  const top = await box(page, ".shell-main > .topbar");
  const bar = await box(page, ".shell-main > .actionbar");
  const strip = await box(page, ".shell-main > .usage-strip");
  out.rows = { top, bar, strip };
  assert.equal(bar.h, 36, "the action bar is 36px tall");
  assert.equal(strip.h, 26, "the usage row is 26px tall");
  assert.equal(bar.y, top.y + top.h, "the action bar is directly under the top bar");
  assert.equal(strip.y, bar.y + bar.h, "the usage row is directly under the action bar");

  // The top bar: the page's name and status, and no action.
  assert.equal(await page.locator(".topbar button:not(.topbar-nav):not(.workflow-title-toggle):not(.chat-workflow-views button)").count(), 0,
    "no action is left in the top bar");
  assert.equal(await page.locator(".topbar .usage, .topbar .mobile-actions").count(), 0);

  // Every action is a button with an icon and a short word, in one line.
  const row = await buttons(page);
  out.buttons = row.map((each) => `${each.id}:${each.label}`);
  const order = ["tasks", "git", "focus", "details", "copy-id", "complete", "delete"];
  const words = { tasks: "Tasks", git: "Git", focus: "Focus", details: "Details", "copy-id": "Copy ID", complete: "Complete", delete: "Delete", more: "More" };
  const inRow = row.map((each) => each.id).filter((id) => id !== "more");
  // A wider font may already have put the last of them behind More here.
  if (!wideFont) assert.deepEqual(inRow, order, "the direct actions lead, then what was behind the menu, in its order");
  assert.deepEqual(inRow, order.filter((id) => inRow.includes(id)), "what is in the row is in the bar's order");
  assert.deepEqual(row.map((each) => each.label), row.map((each) => words[each.id]));
  for (const each of row) assert(each.right <= 1280, `${each.id} is inside the window`);
  if (classic) assert(out.classicScrollbar > 0, "this run draws scrollbars that take room");
  for (const each of row) {
    assert(each.icon, `${each.id} has an icon`);
    assert(each.name, `${each.id} has a name`);
    assert(each.top >= bar.y && each.bottom <= bar.y + bar.h, `${each.id} is inside the bar`);
  }
  assert.equal(new Set(row.map((each) => each.top)).size, 1, "the buttons are on one line");
  // Tasks keeps its count and, with the column put away, what waits on the person.
  const tasks = page.locator(".actionbar .tasks-toggle");
  assert.equal(await tasks.locator(".tasks-toggle-count").innerText(), "3");
  if (await tasks.getAttribute("aria-expanded") === "true") await tasks.click();
  await page.locator(".actionbar .tasks-toggle-owed").waitFor();
  out.owed = await page.locator(".actionbar .tasks-toggle-owed").innerText();
  assert.equal(out.owed, "2", "two decisions ride on the Tasks button while the column is put away");
  out.owedColour = await page.locator(".actionbar .tasks-toggle-owed").evaluate((el) => getComputedStyle(el).color);
  out.decide = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--decide)";
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  });
  assert.equal(out.owedColour, out.decide, "what waits on the person is the decision colour");
  await page.screenshot({ path: join(artifacts, `${name}-1280-tasks-owed.png`), clip: { x: 0, y: 0, width: 1280, height: 160 } });

  // The usage row: every window the host reports, and never Antigravity.
  const cells = await page.locator(".usage-strip .usage-cell").evaluateAll((list) => list.map((cell) => ({
    label: cell.querySelector(".usage-cell-label").textContent,
    value: cell.querySelector(".usage-val")?.textContent ?? cell.querySelector(".usage-cell-none")?.textContent,
    title: cell.getAttribute("title"),
    level: cell.querySelector(".usage-track")?.className.replace("usage-track", "").trim() ?? "",
  })));
  out.usage = cells.map((cell) => `${cell.label} ${cell.value} ${cell.level}`.trim());
  assert.deepEqual(cells.map((cell) => cell.label), ["Claude 5h", "Claude week", "Opus week", "Fable week", "Codex week"]);
  assert.deepEqual(cells.map((cell) => cell.level), ["", "is-warn", "is-danger", "", ""]);
  assert.match(cells[0].title, /Claude 5-hour window: 53% used · resets in 2h (39|40)m/);
  assert.equal(await page.locator(".usage-strip").getByText(/antigravity/i).count(), 0);
  // A press, or the keyboard, opens the breakdown with the reset times in words.
  await page.locator(".usage-strip-btn").focus();
  await page.keyboard.press("Enter");
  const pop = page.getByRole("dialog", { name: "Plan usage", exact: true });
  await pop.waitFor();
  // Its numbers roll into place a digit at a time, so the popover's own
  // text is not something to wait on: a wheel holds every digit it turns
  // through, and `resets in 2h` was true of the first frame only (it timed
  // out in Edge and Chrome on Windows). What is stable is that the wheels
  // are mounted and the words round them are there; the figures themselves
  // are read from the button's name, which is plain text.
  await page.waitForFunction(() => {
    const pop = document.querySelector(".usage-strip .usage-pop");
    return !!pop?.querySelector(".roll-text") && /resets in/.test(pop.textContent ?? "");
  });
  assert.match(await page.locator(".usage-strip-btn").getAttribute("aria-label"), /Claude 5-hour window: 53% used · resets in 2h/);
  const popBox = await box(page, ".usage-strip .usage-pop");
  assert(popBox.x >= 0 && popBox.x + popBox.w <= 1280, "the breakdown is inside the window");
  await page.screenshot({ path: join(artifacts, `${name}-1280-usage-open.png`) });
  await page.keyboard.press("Escape");
  await pop.waitFor({ state: "detached" });
  assert.equal((await box(page, ".shell-main > .usage-strip")).h, 26);

  // An agent the host cannot read: its name, a dash, the note in the tooltip.
  usageAnswer = { claude: usage.claude, codex: { available: false, note: "Codex has not run on this machine." } };
  await page.evaluate(() => localStorage.removeItem("octiq.v2.usage"));
  const second = await open(browser, { width: 1280, height: 800 });
  await second.page.locator(".usage-strip .usage-cell").first().waitFor();
  await settle(second.page, 600);
  const dash = second.page.locator('.usage-strip .usage-cell[data-provider="codex"]');
  assert.equal((await dash.innerText()).replace(/\s+/g, " ").trim(), "Codex —");
  assert.equal(await dash.getAttribute("title"), "Codex: Codex has not run on this machine.");
  await second.page.screenshot({ path: join(artifacts, `${name}-1280-usage-unavailable.png`), clip: { x: 0, y: 0, width: 1280, height: 160 } });
  await second.context.close();
  usageAnswer = usage;

  // Task details opens under its button, inside the window.
  if (await page.getByRole("button", { name: "Task details", exact: true }).count() === 0) await page.getByRole("button", { name: /^More actions/ }).click();
  await page.getByRole("button", { name: "Task details", exact: true }).click();
  const details = page.getByRole("dialog", { name: "Task and workspace", exact: true });
  await details.waitFor();
  const detailsBox = await box(page, ".chat-task-panel");
  const detailsButton = (await buttons(page)).find((each) => each.id === "details") ?? { bottom: bar.y + bar.h };
  out.details = { panel: detailsBox, button: { right: detailsButton.right, bottom: detailsButton.bottom } };
  assert(detailsBox.y >= detailsButton.bottom, "the panel opens under its button, from the frame it is drawn");
  assert(detailsBox.x >= 0 && detailsBox.x + detailsBox.w <= 1280, "the panel is inside the window");
  await page.screenshot({ path: join(artifacts, `${name}-1280-details.png`) });
  await details.getByRole("button", { name: "Close", exact: true }).click();
  await page.keyboard.press("Escape");

  // A narrower window: what does not fit goes behind More, lowest first, and
  // the bar keeps its height. Narrow enough, Tasks itself is behind More and
  // what waits on the person is counted there.
  const widths = [1100, 980, 900, 862];
  out.narrow = {};
  for (const width of widths) {
    await page.setViewportSize({ width, height: 800 });
    // The bar measures itself when its width changes and draws again; a dev
    // build under load takes a moment over that.
    await page.waitForFunction((edge) => [...document.querySelectorAll(".actionbar-row button")]
      .every((each) => each.getBoundingClientRect().right <= edge), width, { timeout: 5000 }).catch(() => {});
    await settle(page);
    const narrow = await buttons(page);
    const barBox = await box(page, ".shell-main > .actionbar");
    out.narrow[width] = narrow.map((each) => each.id).join(" ");
    out.room = { ...out.room, [width]: await page.locator(".actionbar-row").evaluate((el) => `${el.clientWidth}/${el.scrollWidth}`) };
    assert.equal(barBox.h, 36, `the action bar keeps its height at ${width}`);
    assert.equal((await box(page, ".shell-main > .usage-strip")).h, 26, `the usage row keeps its height at ${width}`);
    assert.equal(new Set(narrow.map((each) => each.top)).size, 1, `one line at ${width}`);
    for (const each of narrow) assert(each.right <= width, `${each.id} is inside the window at ${width}`);
    await page.screenshot({ path: join(artifacts, `${name}-${width}-chat.png`), clip: { x: 0, y: 0, width, height: 200 } });
  }
  assert(out.narrow[862].includes("more"), "at 862px some actions are behind More");
  const moreNames = async () => {
    await page.getByRole("button", { name: /^More actions/ }).click();
    const names = await page.locator(".mobile-actions-panel button").evaluateAll((list) => list.map((each) => each.getAttribute("aria-label")));
    await page.screenshot({ path: join(artifacts, `${name}-862-more-open.png`), clip: { x: 0, y: 0, width: 862, height: 420 } });
    await page.keyboard.press("Escape");
    return names;
  };
  out.behindMore = await moreNames();
  assert(out.behindMore.includes("Delete this chat"), "the lowest priority is behind More first");
  // The usage row scrolls sideways at this width instead of wrapping.
  out.usageScroll = await page.locator(".usage-strip-scroll").evaluate((el) => ({
    scroll: el.scrollWidth, client: el.clientWidth, bar: el.offsetHeight - el.clientHeight,
    cut: el.parentElement.dataset.cut,
  }));
  assert(out.usageScroll.scroll > out.usageScroll.client, "at 862px the usage row is wider than its place and scrolls");
  assert.equal(out.usageScroll.bar, 0, "the usage row draws no scrollbar");
  assert.equal(out.usageScroll.cut, "end", "the cut end of the usage row is faded");
  // Its first window is where the row starts: nothing is cut off at the start.
  assert((await box(page, ".usage-strip .usage-cell")).x >= (await box(page, ".usage-strip")).x);
  await page.locator(".usage-strip-scroll").evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await settle(page, 200);
  assert.equal(await page.locator(".usage-strip").getAttribute("data-cut"), "start");
  assert.equal((await box(page, ".shell-main > .usage-strip")).h, 26);
  await page.screenshot({ path: join(artifacts, `${name}-862-usage-scrolled.png`), clip: { x: 0, y: 0, width: 862, height: 200 } });

  // The desktop sidebar: the places menu stays where it is while the list scrolls.
  await page.setViewportSize({ width: 1280, height: 800 });
  await settle(page);
  const menuBefore = await box(page, "#chats-navigation");
  await page.locator(".task-chat-content").evaluate((el) => { el.scrollTop = 900; });
  await settle(page, 200);
  assert.deepEqual(await box(page, "#chats-navigation"), menuBefore, "a desktop's places menu does not move with the list");
  assert.equal(await page.locator(".task-chat-scroll").evaluate((el) => el.scrollTop), 0);
  out.desktopMenu = menuBefore;
  await page.screenshot({ path: join(artifacts, `${name}-1280-sidebar-scrolled.png`) });
  await context.close();

  // A page with no actions draws no bar; the usage row stays.
  const settings = await open(browser, { width: 1280, height: 800 });
  await settings.page.locator(".main").getByText("The plan is ready.", { exact: true }).waitFor();
  await settings.page.locator(".sidebar-places").getByRole("button", { name: "Settings", exact: true }).click();
  await settle(settings.page, 600);
  assert.equal((await box(settings.page, ".shell-main > .actionbar")).h, 0, "Settings has no actions and no bar");
  assert.equal((await box(settings.page, ".shell-main > .usage-strip")).h, 26);
  await settings.page.screenshot({ path: join(artifacts, `${name}-1280-settings.png`) });
  // A page with buttons of its own draws them in the bar.
  await settings.page.locator(".sidebar-places").getByRole("button", { name: "Projects", exact: true }).click();
  await settle(settings.page, 600);
  const projectsBar = await box(settings.page, ".shell-main > .actionbar");
  out.projectsBar = projectsBar;
  assert.equal(projectsBar?.h, 36, "Projects has a button of its own, so it has a bar");
  assert((await settings.page.locator(".actionbar .topbar-page-actions button").count()) > 0);
  await settings.page.screenshot({ path: join(artifacts, `${name}-1280-projects.png`) });
  await settings.context.close();
  return out;
}

async function phone(browser, name, out) {
  const { context, page } = await open(browser, { width: 390, height: 844, phone: true });
  if (shotsOnly) { await page.locator(".main").getByText("The plan is ready.", { exact: true }).waitFor(); await settle(page, 1500); }
  else await ready(page);
  await page.screenshot({ path: join(artifacts, `${name}-390-chat.png`) });
  if (!shotsOnly) {
    const top = await box(page, ".shell-main > .topbar, .app > .topbar");
    const bar = await box(page, ".actionbar");
    out.rows = { top, bar };
    assert.equal(bar.h, 45, "a phone's action bar is 44px of target and its rule");
    assert.equal(bar.y, top.y + top.h, "directly under the top bar");
    assert.equal(await page.locator(".usage-strip").count(), 0, "a phone has no usage row");
    assert.equal(await page.locator(".actionbar .mobile-actions").count(), 0, "a phone has no More: the row scrolls");
    const row = await buttons(page);
    out.buttons = row.map((each) => `${each.id}:${each.label}`);
    for (const each of row) {
      assert(each.h >= 44 && each.w >= 44, `${each.id} is a 44px target (${each.w}x${each.h})`);
      assert(each.icon && each.label, `${each.id} has an icon and a word`);
    }
    assert.equal(new Set(row.map((each) => each.top)).size, 1, "one line");
    const scroller = page.locator(".actionbar-row");
    const read = () => scroller.evaluate((el) => ({
      left: el.scrollLeft, scroll: el.scrollWidth, client: el.clientWidth,
      scrollbar: el.offsetHeight - el.clientHeight, cut: el.parentElement.dataset.cut,
      overscroll: getComputedStyle(el).overscrollBehaviorX, wrap: getComputedStyle(el).flexWrap,
    }));
    const start = await read();
    out.scroll = start;
    assert(start.scroll > start.client, "the row is wider than the phone and scrolls");
    assert.equal(start.scrollbar, 0, "no scrollbar takes room in the row");
    assert.equal(start.overscroll, "contain");
    assert.equal(start.wrap, "nowrap");
    assert.equal(start.cut, "end", "the cut end is faded before any scroll");
    await scroller.evaluate((el) => { el.scrollLeft = 60; });
    await settle(page, 200);
    assert.equal((await read()).cut, "start end");
    await page.screenshot({ path: join(artifacts, `${name}-390-bar-midway.png`), clip: { x: 0, y: 0, width: 390, height: 140 } });
    await scroller.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await settle(page, 200);
    assert.equal((await read()).cut, "start");
    assert.equal((await box(page, ".actionbar")).h, 45, "scrolling the row does not change the bar's height");
    // The page did not scroll sideways with it.
    assert.equal(await page.evaluate(() => document.scrollingElement.scrollLeft), 0);
    // Usage ends the bar, outside the scroller, and opens its popup as before.
    const usageBox = await box(page, ".actionbar > .usage");
    out.usage = usageBox;
    // A pixel of slack: each edge is rounded on its own.
    assert(usageBox && usageBox.x + usageBox.w <= 391 && usageBox.x > 290, "the usage entry ends the bar");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, "nothing makes the page wider than the phone");
    assert(usageBox.h >= 44);
    await page.locator(".actionbar > .usage .usage-btn").tap();
    const pop = page.getByRole("dialog", { name: "Plan usage", exact: true });
    await pop.waitFor();
    await pop.getByText("Antigravity does not report plan usage.", { exact: true }).waitFor();
    const popBox = await box(page, ".usage-pop");
    assert(popBox.x >= 0 && popBox.x + popBox.w <= 390, "the popup is inside the phone");
    await page.screenshot({ path: join(artifacts, `${name}-390-usage-open.png`) });
    await page.locator(".usage-scrim").tap({ position: { x: 20, y: 600 } });
    await pop.waitFor({ state: "detached" });
    // Task details, from inside the scrolling row, is not clipped by it.
    await scroller.evaluate((el) => { el.scrollLeft = 0; });
    await page.getByRole("button", { name: "Task details", exact: true }).scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: "Task details", exact: true }).tap();
    await page.getByRole("dialog", { name: "Task and workspace", exact: true }).waitFor();
    const detailsBox = await box(page, ".chat-task-panel");
    out.details = detailsBox;
    await page.screenshot({ path: join(artifacts, `${name}-390-details.png`) });
    assert(detailsBox.x >= 0 && detailsBox.x + detailsBox.w <= 390 && detailsBox.h > 100, "the panel is whole and inside the phone");
    assert(detailsBox.y >= bar.y + bar.h - 2, "the panel opens under the bar");
    await page.getByRole("dialog", { name: "Task and workspace", exact: true }).getByRole("button", { name: "Close", exact: true }).tap();
  }

  // The chat list: its places menu is the first thing in the scroller.
  await page.getByRole("button", { name: "Show chats", exact: true }).click();
  const list = page.locator(".task-sidebar .task-chat-scroll");
  await page.locator(".task-chat-list .chat").nth(39).waitFor({ state: "attached" });
  await settle(page, 400);
  await page.screenshot({ path: join(artifacts, `${name}-390-chats-top.png`) });
  const menu = () => page.evaluate(() => {
    const scroller = document.querySelector(".task-sidebar .task-chat-scroll").getBoundingClientRect();
    const element = document.querySelector("#chats-navigation");
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      // How much of the menu is inside the list's box.
      seen: Math.max(0, Math.round(Math.min(rect.bottom, scroller.bottom) - Math.max(rect.top, scroller.top))),
      height: Math.round(rect.height), position: style.position, opacity: style.opacity, transform: style.transform,
      classes: element.className,
    };
  });
  const scrollTo = async (target) => {
    const from = await list.evaluate((el) => el.scrollTop);
    const steps = Math.max(1, Math.ceil(Math.abs(target - from) / 40));
    for (let i = 1; i <= steps; i += 1) {
      await list.evaluate((el, at) => { el.scrollTop = at; }, from + ((target - from) * i) / steps);
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(400);
  };
  const end = await list.evaluate((el) => el.scrollHeight - el.clientHeight);
  await scrollTo(end);
  const atEnd = await menu();
  await page.screenshot({ path: join(artifacts, `${name}-390-chats-end.png`) });
  await scrollTo(end - 400);
  const afterUp = await menu();
  await page.screenshot({ path: join(artifacts, `${name}-390-chats-scrolled-up.png`) });
  out.menu = { atEnd, afterUp };
  if (!shotsOnly) {
    assert.equal(atEnd.seen, 0, "scrolled to the end, the places menu is out of sight");
    assert.equal(afterUp.seen, 0, "scrolling up 400px does not bring the menu back over the rows");
    assert.equal(afterUp.position, "static");
    assert.equal(afterUp.classes, "sidebar-toolbar");
    // Half-way back up it is still gone; only the top shows it.
    await scrollTo(Math.round(end / 2));
    assert.equal((await menu()).seen, 0);
    await scrollTo(0);
    const atTop = await menu();
    assert.equal(atTop.seen, atTop.height, "at the top the whole menu is in view, in place");
    // The keyboard reaches it from anywhere: focus scrolls it into view.
    await scrollTo(end);
    await page.locator(".sidebar-new-chat").focus();
    await settle(page, 300);
    const focused = await menu();
    out.menu.focused = focused;
    assert(focused.seen > 40, "focus moving into the menu scrolls it into view");
    assert(await list.evaluate((el) => el.scrollTop) < end, "by scrolling the list, the native way");
    await page.screenshot({ path: join(artifacts, `${name}-390-chats-focused.png`) });
  }
  await context.close();
  return out;
}

/** A cold open of a chat's link: no chat remembered, and everything the bars
 *  draw answers late, the ledger last and well after the chat list (the
 *  other order is the page's own known step, AGENTS.md "A linked chat that
 *  is not open yet"). The bars must already be where they will be. */
async function coldOpen(browser, name, { width, height, phone: isPhone = false }) {
  delays = { list_workspaces: 300, chat_index_list: 600, chat_task: 900, git_status_summary: 1200, usage_summary: 1500, orchestration_snapshot: 2500 };
  const { context, page } = await open(browser, { width, height, phone: isPhone, seed: false });
  const seen = [];
  const sample = async (label) => seen.push({ label, ...(await page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return box.height ? [Math.round(box.y), Math.round(box.height)] : null;
    };
    return { top: rect(".topbar"), bar: rect(".actionbar"), strip: rect(".usage-strip"), body: rect(".body") };
  })) });
  await page.locator(".topbar").waitFor();
  await sample("first");
  await page.screenshot({ path: join(artifacts, `${name}-${width}-cold-first.png`) });
  await page.waitForTimeout(5000);
  await sample("settled");
  await page.screenshot({ path: join(artifacts, `${name}-${width}-cold-settled.png`) });
  const measured = await shift(page);
  delays = {};
  await context.close();
  return { rows: seen, shift: Number(measured.total.toFixed(4)), entries: measured.entries, unsupported: !!measured.unsupported };
}

try {
  await server.listen();
  for (const engine of engines) {
    const browser = await playwright[engine].launch({
      headless: true,
      ...(classic && engine === "chromium"
        ? { ignoreDefaultArgs: ["--hide-scrollbars"], args: ["--disable-features=OverlayScrollbar"] } : {}),
      ...(engine === "chromium" && process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
    });
    // Filled as it goes, so a check that fails still leaves what was measured.
    const out = { desktop: {}, phone: {} };
    report.engines[engine] = out;
    try {
      if (!process.env.ONLY || process.env.ONLY === "desktop") await desktop(browser, engine, out.desktop);
      if (!process.env.ONLY || process.env.ONLY === "phone") await phone(browser, engine, out.phone);
      out.cold = {
        desktop: await coldOpen(browser, engine, { width: 1280, height: 800 }),
        phone: await coldOpen(browser, engine, { width: 390, height: 844, phone: true }),
      };
      if (!shotsOnly) {
        for (const [where, cold] of Object.entries(out.cold)) {
          const [first, settled] = cold.rows;
          assert.deepEqual(first.bar, settled.bar, `${where}: the action bar is where it will be from the first paint`);
          assert.deepEqual(first.body, settled.body, `${where}: the page under the bars does not move`);
          if (where === "desktop") assert.deepEqual(first.strip, settled.strip, "the usage row is there from the first paint");
          // What is left of the shift inside the bars is a button moving
          // along its row as another arrives beside it: asked of the nodes
          // that moved, not of a total that the page's other work moves.
          const inBars = cold.entries.filter((entry) => entry.nodes.some((node) => /actionbar|usage-(strip|cell)/.test(String(node))))
            .reduce((sum, entry) => sum + entry.value, 0);
          cold.inBars = Number(inBars.toFixed(4));
          assert(inBars < 0.01, `${where}: the bars' own layout shift is ${inBars}`);
        }
      }
    } finally {
      await browser.close();
    }
  }
  if (!shotsOnly) assert.deepEqual(errors, []);
  console.log(JSON.stringify(report, null, 2));
  console.log(`top chrome: ${shotsOnly ? "SHOTS" : "PASS"} (${artifacts})`);
} catch (error) {
  console.error(error);
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  await server.close();
}
