// App-shell regression for long agent roles in the Agents page and in
// Settings → Agents, at 375px, 430px and a desktop width. The socket is
// mocked; everything else is the real App, Sidebar, AgentsDashboard and
// AgentsSettings. A role is two lines until asked for, by touch or keyboard,
// and the whole stored role is what opens.
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const artifacts = process.env.OCTIQ_EVIDENCE_DIR
  || await mkdtemp(join(tmpdir(), "octiq-agent-roles-"));
await mkdir(artifacts, { recursive: true });

const now = Date.now();
const agent = (id, name, over = {}) => ({
  id, name, role: "", agent: "claude", model: "opus", effort: "high", access: "auto",
  createdAt: now - 100_000, updatedAt: now - 100_000, ...over,
});
// Roles the length real ones are: a paragraph or two, written for the agent.
const AVOCADO = "Workspace product lead reporting to Potato Juice. Own scope, architecture, business rules, API agreements and acceptance for customer-success-platform. Delegate frontend to Apple Juice and backend to Carrot Juice; review integration and complete user flows before signoff. Work only in the workspace repositories and never in another module's checkout. Keep personal memory short: responsibilities, open decisions, gotchas and what to pick up next, never a task log. Before approving, read the actual diff and the acceptance criteria, run the relevant checks yourself, and say plainly what was verified and what was not.";
const PAPAYA = "Pandahrms Leave module lead reporting to Potato Juice. Own Leave business rules, scope, API agreements and acceptance across core web/API, coordinating mobile consumers with Kiwi through Potato. Delegate web frontend to Lychee Juice and backend to Ginger Juice; review integrated flows and matching behaviour between web and mobile before signoff.\n\nKeep entitlement, accrual, carry-forward and approval rules in one shared spec, and refuse changes that would let the two clients disagree. Escalate cross-module work to Potato rather than reaching into another team's code.";
const LYCHEE = "Pandahrms Leave frontend engineer reporting to Papaya Juice. Own Leave web screens, forms, validation presentation, accessibility and frontend verification in core-v1/Pandahrms_Web. Work only on Leave within pandahrms-leave; the API repository is for contract reference unless specifically assigned. Coordinate contract changes with Ginger Juice and hand finished work to Papaya for review.";
const team = [
  agent("potato", "Potato Juice", { role: "CTO. Owns technical direction across every project.", agent: "codex", model: "gpt-5.5" }),
  agent("avocado", "Avocado Juice", { role: AVOCADO, reportsTo: "potato" }),
  agent("apple", "Apple Juice", { role: "Workspace frontend engineer.", model: "sonnet", effort: "medium", projectId: "octiq", reportsTo: "avocado" }),
  agent("papaya", "Papaya Juice", { role: PAPAYA, reportsTo: "potato" }),
  agent("lychee", "Pineapple Lychee Juice", { role: LYCHEE, model: "sonnet", projectId: "panda", reportsTo: "papaya" }),
  agent("guava", "Guava Juice", { role: LYCHEE, agent: "codex", model: "gpt-5.5", projectId: "panda", reportsTo: "lychee" }),
];
const byName = Object.fromEntries(team.map((item) => [item.name, item]));
const chats = [{
  id: "head-live", projectId: "general", title: "Plan the release", customTitle: true, modelId: "claude:opus",
  access: "auto", sessionId: "session-head", createdAt: now - 60_000, updatedAt: now - 50_000,
}];
const localChats = chats.map((item) => ({
  ...item,
  messages: [{ id: `m-${item.id}`, role: "assistant", streaming: false, blocks: [{ kind: "text", text: `${item.title} answer.` }] }],
}));
const snapshot = { runs: [], tasks: [], attempts: [], gates: [], messages: [] };
const saved = [];
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
      { id: "octiq", name: "OctiqFlow", primary_path: "/repo/octiq", color: "#3b82f6" },
      { id: "panda", name: "Pandahrms Leave", primary_path: "/repo/panda", color: "#16a34a" },
    ];
    case "chat_index_list": return chats;
    case "chat_index_deleted": return [];
    case "chat_page": return { events: [], context: [], before: null };
    case "chat_list": return [];
    case "chat_activity": return [];
    case "chat_queue_state": return { live: false, queuedTurnIds: [] };
    case "orchestration_snapshot": return snapshot;
    case "permission_pending": return [];
    case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
    case "usage_summary": return {};
    case "agent_installs": return [{ id: "claude", installed: true, path: "/mock/claude" }];
    case "team_list": return team;
    case "team_head": return team[0];
    case "team_leads": return [];
    case "team_home": return "general";
    case "team_save": saved.push(request.args); return request.args?.agent ?? null;
    case "chat_task": return { chatId: request.args?.chatId, projectId: "general" };
    case "pr_repositories": return [];
    case "pr_local_list": case "pr_remote_list": return { items: [], warnings: [] };
    case "codex_skills": return [];
    case "agent_avatar_status": return { available: false, reason: "Not signed in to Codex." };
    default: return null;
  }
}

const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const rowOf = (list, name) => list.locator(":scope > li").filter({ has: list.page().locator(".team-row-name", { hasText: name }) });

/** How tall a role is, in lines of its own text. */
const roleLines = (role) => role.evaluate((el) => {
  const style = getComputedStyle(el);
  const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.45;
  return el.getBoundingClientRect().height / line;
});

/** Everything a person reads or presses in a row stays inside the viewport. */
async function assertInside(page, row, what) {
  const width = page.viewportSize().width;
  const boxes = await row.locator("button:visible, .team-row-name, .team-row-meta, .agent-role-text").evaluateAll((els) =>
    els.map((el) => { const r = el.getBoundingClientRect(); return { cls: el.className, left: r.left, right: r.right }; }));
  for (const box of boxes) {
    assert(box.left >= -0.5 && box.right <= width + 0.5, `${what}: ${box.cls} spills outside ${width}px (${box.left}–${box.right})`);
  }
}

/** A list's rows: role at most two lines shut; its toggle opens the whole
 *  stored text by pointer and by keyboard; indentation stays shallow. */
async function checkList(page, list, where, phone) {
  for (const name of ["Avocado Juice", "Papaya Juice", "Pineapple Lychee Juice"]) {
    const row = rowOf(list, name);
    await row.waitFor();
    const role = row.locator(".agent-role-text");
    assert.equal(await role.count(), 1, `${where}: ${name} has one role preview`);
    const lines = await roleLines(role);
    assert(lines <= 2.05, `${where}: ${name}'s role is ${lines.toFixed(2)} lines shut`);
    const toggle = row.getByRole("button", { name: `Full role for ${name}` });
    assert.equal(await toggle.isVisible(), true, `${where}: ${name}'s long role offers its full text`);
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    if (phone) {
      const box = await toggle.boundingBox();
      assert(box.height >= 44, `${where}: ${name}'s toggle is ${box.height}px tall`);
    }
    await assertInside(page, row, `${where} ${name}`);
    // The name is never ellipsised: identity comes first.
    const nameCut = await row.locator(".team-row-name").first().evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    assert.equal(nameCut, false, `${where}: ${name}'s name is cut`);
  }
  // A short role has nothing more to show, so it offers nothing.
  assert.equal(await rowOf(list, "Apple Juice").getByRole("button", { name: /Full role/ }).count(), 0,
    `${where}: a role that fits has no toggle`);

  // Deep reports stay readable: indentation stops growing after three
  // levels, and a level is half as wide on a phone.
  const left = async (name) => (await rowOf(list, name).locator(".agent-avatar").first().boundingBox()).x;
  const indent = await left("Guava Juice") - await left("Potato Juice");
  assert(indent <= (phone ? 36.5 : 66.5), `${where}: depth-3 indent is ${indent}px`);
  assert(indent > 0, `${where}: hierarchy still shows`);

  // Pointer: open shows every stored word, including its paragraph break.
  const papaya = rowOf(list, "Papaya Juice");
  await papaya.getByRole("button", { name: "Full role for Papaya Juice" }).click();
  const less = papaya.getByRole("button", { name: "Show less of Papaya Juice's role" });
  assert.equal(await less.getAttribute("aria-expanded"), "true");
  const role = papaya.locator(".agent-role-text");
  assert.equal(await role.evaluate((el) => el.scrollHeight <= el.clientHeight + 1), true, `${where}: open role is whole`);
  assert.equal((await role.textContent()), PAPAYA, `${where}: the open role is the stored role, unchanged`);
  assert((await roleLines(role)) > 3, `${where}: the open role is longer than the preview`);
  assert.equal(await noHorizontalScroll(page), true, `${where}: an open role scrolls nothing sideways`);
  await page.screenshot({ path: join(artifacts, `${where}-open.png`), fullPage: true });
  await less.click();
  assert((await roleLines(role)) <= 2.05, `${where}: Show less shuts it again`);

  // Keyboard: the same toggle, reached and pressed without a pointer.
  const avocado = rowOf(list, "Avocado Juice").getByRole("button", { name: "Full role for Avocado Juice" });
  await avocado.focus();
  await page.keyboard.press("Enter");
  assert.equal(await rowOf(list, "Avocado Juice").getByRole("button", { name: "Show less of Avocado Juice's role" }).getAttribute("aria-expanded"), "true");
  await page.keyboard.press("Space");
  assert.equal(await avocado.getAttribute("aria-expanded"), "false");
}

let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
  for (const [label, width, height] of [["375", 375, 812], ["430", 430, 932], ["desktop", 1440, 960]]) {
    const phone = width < 700;
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce", hasTouch: phone, isMobile: phone });
    await context.addInitScript((seed) => {
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

    // ── The Agents page.
    if (phone) await page.getByRole("button", { name: "Show chats", exact: true }).click();
    await page.locator(".sidebar-places").getByRole("button", { name: "Agents", exact: true }).click();
    const dashboard = page.getByRole("region", { name: "Agents" }).locator(".agents-dashboard-list");
    await rowOf(dashboard, "Guava Juice").waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(artifacts, `agents-${label}.png`), fullPage: true });
    assert.equal(await noHorizontalScroll(page), true, `agents-${label}: no sideways scroll`);
    // Model metadata stays on the row even when a role is set.
    assert.match(await rowOf(dashboard, "Avocado Juice").locator(".team-row-meta").innerText(), /Claude opus · All projects/);
    await checkList(page, dashboard, `agents-${label}`, phone);

    // ── Settings → Agents, through the page's own Manage agents.
    await page.getByRole("button", { name: "Manage agents", exact: true }).click();
    const settings = page.locator(".team-settings .team-list");
    await rowOf(settings, "Guava Juice").waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.locator(".team-settings .team-group").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(artifacts, `settings-agents-${label}.png`), fullPage: true });
    assert.equal(await noHorizontalScroll(page), true, `settings-${label}: no sideways scroll`);
    assert.match(await rowOf(settings, "Pineapple Lychee Juice").locator(".team-row-meta").innerText(), /Claude .*Sonnet.* · high · Pandahrms Leave/i);
    await checkList(page, settings, `settings-agents-${label}`, phone);
    // Edit and Remove stay named, visible and big enough to press.
    for (const action of ["Edit", "Remove"]) {
      const button = rowOf(settings, "Papaya Juice").getByRole("button", { name: `${action} Papaya Juice` });
      assert.equal(await button.isVisible(), true, `settings-${label}: ${action} is visible`);
      if (phone) assert((await button.boundingBox()).height >= 44, `settings-${label}: ${action} is a 44px target`);
    }
    // Editing starts from the whole stored role, and saves it back untouched.
    await rowOf(settings, "Papaya Juice").getByRole("button", { name: "Edit Papaya Juice" }).click();
    const textarea = page.locator(".team-form textarea");
    assert.equal(await textarea.inputValue(), PAPAYA, `settings-${label}: the form holds the whole role`);
    await page.locator(".team-form").getByRole("button", { name: "Save", exact: true }).click();
    await page.locator(".team-form").waitFor({ state: "detached" });
    const last = saved.at(-1)?.agent;
    assert.equal(last?.role, PAPAYA, `settings-${label}: Save writes the stored role back unchanged`);
    assert.equal(last?.reportsTo, byName["Papaya Juice"].reportsTo, `settings-${label}: reporting line kept`);
    assert.equal(last?.access, byName["Papaya Juice"].access, `settings-${label}: access kept`);
    // The lead picker names each lead with a short role, not a paragraph.
    const options = await page.locator("select.team-head-select").first().locator("option").allInnerTexts();
    assert(options.every((text) => text.length <= 80), `settings-${label}: lead options stay short: ${options.join(" | ")}`);
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, mockedBackend: true, artifacts }));
} catch (error) {
  const page = browser?.contexts().at(-1)?.pages()[0];
  await page?.screenshot({ path: join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ error: String(error), errors }));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
}
