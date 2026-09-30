// App-shell regression for Settings › Agents (Manage agents) on a phone: the
// page and every scroller inside it keep to the screen's width in the list,
// the Edit form and the Add agent form, every field is 16px or larger so iOS
// Safari never zooms the page when one takes focus, and the section tabs take
// one row. A desktop pass checks the desktop typography did not move. The
// socket is mocked; everything else is the real App and Settings.
//
// OCTIQ_SOFT=1 collects failures instead of stopping at the first, which is
// how the before-and-after evidence was taken against the untouched page.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
// PLAYWRIGHT_BROWSER=webkit lays the page out with Safari's engine.
const engine = (await import(process.env.PLAYWRIGHT_MODULE || "playwright"))[process.env.PLAYWRIGHT_BROWSER || "chromium"];
const artifacts = process.env.OCTIQ_EVIDENCE_DIR
  || await mkdtemp(join(tmpdir(), "octiq-settings-agents-"));
await mkdir(artifacts, { recursive: true });
const soft = process.env.OCTIQ_SOFT === "1";
const failures = [];
const check = (ok, message) => {
  if (ok) return;
  if (!soft) assert.fail(message);
  failures.push(message);
};

const now = Date.now();
const agent = (id, name, over = {}) => ({
  id, name, role: "", agent: "claude", model: "opus", effort: "high", access: "auto",
  createdAt: now - 100_000, updatedAt: now - 100_000, ...over,
});
// Roles, names and projects the length real ones are.
const ROLE = "Pandahrms Leave module lead reporting to Potato Juice. Own Leave business rules, scope, API agreements and acceptance across core web/API, coordinating mobile consumers with Kiwi through Potato. Delegate web frontend to Lychee Juice and backend to Ginger Juice; review integrated flows before signoff.";
const PROJECT = "customer-success-platform-integration-workspace";
const team = [
  agent("potato", "Potato Juice", { role: "CTO. Owns technical direction across every project, routes each task to the right project and agent, and approves the plan before anyone starts.", agent: "codex", model: "gpt-5.5" }),
  agent("papaya", "Papaya Juice", { role: ROLE, reportsTo: "potato", teamId: "leave" }),
  agent("lychee", "Pineapple Lychee Passionfruit Juice", { role: ROLE, model: "sonnet", projectId: "long", reportsTo: "papaya", teamId: "leave" }),
  agent("guava", "Guava Juice", { role: ROLE, agent: "codex", model: "gpt-5.5", projectId: "long", reportsTo: "lychee" }),
  agent("kiwi", "Kiwi Juice", { role: "Mobile lead.", projectId: "long", reportsTo: "guava" }),
];
const teams = [{ id: "leave", name: "Pandahrms Leave cross-platform squad", projectId: null }];
const chats = [{
  id: "head-live", projectId: "general", title: "Plan the release", customTitle: true, modelId: "claude:opus",
  access: "auto", sessionId: "session-head", createdAt: now - 60_000, updatedAt: now - 50_000,
}];
const localChats = chats.map((item) => ({
  ...item,
  messages: [{ id: `m-${item.id}`, role: "assistant", streaming: false, blocks: [{ kind: "text", text: `${item.title} answer.` }] }],
}));
const errors = [];

const server = await createServer({
  root: new URL("../web", import.meta.url).pathname,
  configFile: new URL("../web/vite.config.ts", import.meta.url).pathname,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

function resultFor(request) {
  switch (request.cmd) {
    case "list_workspaces": return [
      { id: "general", name: "General", primary_path: "/Users/kyson/General" },
      { id: "long", name: PROJECT, primary_path: `/Users/kyson/03-projects/${PROJECT}`, color: "#16a34a" },
    ];
    case "chat_index_list": return chats;
    case "chat_index_deleted": return [];
    case "chat_page": return { events: [], context: [], before: null };
    case "chat_list": return [];
    case "chat_activity": return [];
    case "chat_queue_state": return { live: false, queuedTurnIds: [] };
    case "orchestration_snapshot": return { runs: [], tasks: [], attempts: [], gates: [], messages: [] };
    case "permission_pending": return [];
    case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
    case "usage_summary": return {};
    case "agent_installs": return [{ id: "claude", installed: true, path: "/mock/claude" }];
    case "team_list": return team;
    case "team_head": return team[0];
    case "team_leads": return [];
    case "team_home": return "long";
    case "agent_team_list": return teams;
    case "chat_task": return { chatId: request.args?.chatId, projectId: "general" };
    case "pr_repositories": return [];
    case "pr_local_list": case "pr_remote_list": return { items: [], warnings: [] };
    case "codex_skills": return [];
    case "agent_avatar_status": return { available: false, reason: "Not signed in to Codex." };
    default: return null;
  }
}

/** Everything on the page that is wider than the screen or scrolls sideways:
 *  the document, every element that can scroll and is wider than its box, and
 *  every visible element under the settings page whose box leaves the screen. */
const measure = (page) => page.evaluate(() => {
  const width = document.documentElement.clientWidth;
  const name = (el) => {
    const cls = typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/).join(".")}` : "";
    const label = el.getAttribute("aria-label") ? `[aria-label="${el.getAttribute("aria-label")}"]` : "";
    return `${el.tagName.toLowerCase()}${cls}${label}`;
  };
  const scrollers = [];
  for (const el of [document.scrollingElement, ...document.querySelectorAll(".settings-page, .settings-page *")]) {
    const style = getComputedStyle(el);
    const scrolls = el === document.scrollingElement || /auto|scroll/.test(style.overflowX);
    if (scrolls && el.scrollWidth > el.clientWidth + 1) {
      // Which of its children reach past its right edge: the deepest ones
      // are the cause, their ancestors only carry it.
      const edge = el === document.scrollingElement ? 0 : el.getBoundingClientRect().left + el.clientLeft;
      const wide = [...el.querySelectorAll("*")].filter((child) => {
        const box = child.getBoundingClientRect();
        return box.width > 0 && box.right - edge + el.scrollLeft > el.clientWidth + 1;
      }).filter((child, _, all) => !all.some((other) => other !== child && child.contains(other)));
      scrollers.push({
        el: name(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
        causes: wide.slice(0, 8).map((child) => ({ el: name(child), width: Math.round(child.getBoundingClientRect().width) })),
      });
    }
  }
  const outside = [];
  for (const el of document.querySelectorAll(".settings-page *")) {
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height || getComputedStyle(el).visibility === "hidden") continue;
    if (box.right > width + 0.5 || box.left < -0.5) {
      outside.push({ el: name(el), left: Math.round(box.left), right: Math.round(box.right) });
    }
  }
  return { width, scrollers, outside };
});

/** Every field on the page that a person can type in or choose from, with the
 *  size its text is drawn at. */
const fieldSizes = (page) => page.locator(".settings-page").evaluate((root) =>
  [...root.querySelectorAll("input:not([type=checkbox]):not([type=radio]):not([type=file]), select, textarea")]
    .filter((el) => el.getBoundingClientRect().width > 0)
    .map((el) => ({
      el: `${el.tagName.toLowerCase()}${el.getAttribute("aria-label") ? `[${el.getAttribute("aria-label")}]` : ""}${el.className ? `.${el.className}` : ""}`,
      size: parseFloat(getComputedStyle(el).fontSize),
    })));

const report = {};
let browser;
try {
  await server.listen();
  browser = await engine.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
  for (const [label, width, height] of [["375", 375, 667], ["390", 390, 844], ["desktop", 1440, 960]]) {
    const phone = width < 700;
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce", hasTouch: phone, isMobile: phone });
    await context.addInitScript((seed) => {
      if (!location.protocol.startsWith("http")) return;
      localStorage.setItem("octiq.agentsMode", "on");
      localStorage.setItem("octiq.v2.gitColumn", "0");
      localStorage.setItem("octiq.v2.conversations", JSON.stringify(seed));
    }, localChats);
    await context.route("**/token", (route) => route.fulfill({ body: "mock-token" }));
    await context.route("**/auth", (route) => route.fulfill({ body: "ok" }));
    await context.routeWebSocket(/.*/, (socket) => {
      socket.onMessage((raw) => {
        const request = JSON.parse(String(raw));
        if (request.t !== "invoke") return;
        socket.send(JSON.stringify({ t: "reply", id: request.id, ok: true, result: resultFor(request) }));
      });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on("pageerror", (error) => errors.push(error.stack ?? String(error)));
    await page.goto(`${base}#/p/general/c/head-live`, { waitUntil: "domcontentloaded" });
    await page.locator(".main").getByText("Plan the release answer.", { exact: true }).waitFor();

    // In by the path a person takes: Agents, then Manage agents.
    if (phone) await page.getByRole("button", { name: "Show chats", exact: true }).click();
    await page.locator(".sidebar-places").getByRole("button", { name: "Agents", exact: true }).click();
    await page.getByRole("button", { name: "Manage agents", exact: true }).click();
    const list = page.locator(".team-settings .team-list");
    await list.locator(".team-row-name", { hasText: "Kiwi Juice" }).waitFor();
    await page.evaluate(() => document.fonts.ready);

    // The section tabs: one row on a phone, every one of them on screen, each
    // a target a thumb can hit and each still named.
    const tabs = await page.locator(".settings-nav-item").evaluateAll((els) => els.map((el) => {
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), left: r.left, right: r.right, height: r.height, width: r.width };
    }));
    const tabNames = await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button").evaluateAll((els) =>
      els.map((el) => el.textContent.trim()));
    const rows = new Set(tabs.map((tab) => tab.top)).size;
    check(tabNames.every(Boolean), `${label}: a section tab has no name`);
    check(tabs.every((tab) => tab.left >= -0.5 && tab.right <= width + 0.5), `${label}: a section tab is off screen`);
    if (phone) {
      check(rows === 1, `${label}: the section tabs take ${rows} rows`);
      check(tabs.every((tab) => tab.height >= 44 && tab.width >= 44), `${label}: a section tab is under 44px`);
    }
    // Keyboard: each tab is a button that takes focus, and Enter picks it.
    const nav = page.getByRole("navigation", { name: "Settings sections" });
    const agentsTab = nav.getByRole("button", { name: /^Agents/ });
    check(await agentsTab.getAttribute("aria-current") === "page", `${label}: the Agents tab is not marked current`);
    await nav.getByRole("button", { name: /^Projects/ }).focus();
    await page.keyboard.press("Enter");
    await page.locator("#settings-projects-title").waitFor();
    // WebKit on a Mac leaves buttons out of the Tab order unless Safari is
    // told otherwise, so there the next tab is focused directly.
    if (engine.name() === "webkit") await agentsTab.focus();
    else await page.keyboard.press("Tab");
    check(await agentsTab.evaluate((el) => el === document.activeElement), `${label}: Tab does not move from Projects to Agents`);
    await page.keyboard.press("Enter");
    await list.locator(".team-row-name", { hasText: "Kiwi Juice" }).waitFor();
    if (phone) {
      // A choice beside a paragraph was a sliver; on a phone it has a line.
      const section = await page.locator(".team-settings").evaluate((el) => el.getBoundingClientRect().width);
      const choices = await page.locator(".team-head-select").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
      check(choices.every((w) => w >= section - 1), `${label}: a lead choice is ${Math.min(...choices)}px of ${section}px`);
    }

    const states = {};
    const state = async (key) => {
      await page.evaluate(() => document.fonts.ready);
      const found = await measure(page);
      const sizes = await fieldSizes(page);
      states[key] = { ...found, fields: sizes };
      await page.screenshot({ path: join(artifacts, `settings-agents-${key}-${label}.png`), fullPage: false });
      check(found.scrollers.length === 0, `${label} ${key}: sideways scroll in ${JSON.stringify(found.scrollers)}`);
      check(found.outside.length === 0, `${label} ${key}: past the screen edge: ${JSON.stringify(found.outside.slice(0, 12))}`);
      if (phone) {
        const small = sizes.filter((field) => field.size < 16);
        check(small.length === 0, `${label} ${key}: fields under 16px zoom iOS: ${JSON.stringify(small)}`);
      } else {
        // The desktop keeps its compact 13px fields.
        const moved = sizes.filter((field) => field.size !== 13);
        check(moved.length === 0, `${label} ${key}: desktop field sizes moved: ${JSON.stringify(moved)}`);
      }
    };

    await state("list");
    // The org chart is further down; its rows (deepest indent, Edit/Remove).
    await list.locator(":scope > li").last().scrollIntoViewIfNeeded();
    await state("list-rows");

    // Edit the deepest agent: the longest name, a project, a team.
    await list.locator(":scope > li").filter({ has: page.locator(".team-row-name", { hasText: "Pineapple Lychee" }) })
      .getByRole("button", { name: /^Edit / }).click();
    const form = page.locator(".team-form");
    await form.waitFor();
    check(await form.locator("textarea").inputValue() === ROLE, `${label}: the Edit form holds the whole role`);
    await form.scrollIntoViewIfNeeded();
    await state("edit");
    await form.getByRole("button", { name: "Cancel", exact: true }).click();
    await form.waitFor({ state: "detached" });

    await page.getByRole("button", { name: "Add agent", exact: true }).click();
    await form.waitFor();
    await form.scrollIntoViewIfNeeded();
    await state("add");
    await form.getByRole("button", { name: "Cancel", exact: true }).click();

    // A new peer-help team's form sits in the same page.
    await page.getByRole("button", { name: "Add team", exact: true }).click();
    const teamForm = page.locator(".team-group-form");
    await teamForm.waitFor();
    await teamForm.scrollIntoViewIfNeeded();
    await state("add-team");

    report[label] = { tabs: { rows, count: tabs.length }, states };
    await context.close();
  }
  check(errors.length === 0, `page errors: ${errors.join("\n")}`);
  await writeFile(join(artifacts, "measurements.json"), JSON.stringify(report, null, 2));
  if (failures.length) {
    console.error(JSON.stringify({ passed: false, failures, artifacts }, null, 2));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ passed: true, mockedBackend: true, artifacts }));
  }
} catch (error) {
  const page = browser?.contexts().at(-1)?.pages()[0];
  await page?.screenshot({ path: join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ error: String(error), errors, failures }));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
}
