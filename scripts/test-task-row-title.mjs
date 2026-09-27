// App-shell regression for the run panel's task rows: the title has a line of
// its own and wraps whole, while status, time, assignee, branch and the row's
// controls sit on the line below without running under each other. The socket
// is mocked; everything else is the real App, run panel and CSS.
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const artifacts = process.env.OCTIQ_EVIDENCE_DIR
  || await mkdtemp(join(tmpdir(), "octiq-task-row-title-"));
await mkdir(artifacts, { recursive: true });

const now = Date.now();
const LONG = "Show running activity on chat project logos while the coordinator waits on its workers, and leave completed rows still";
const UNBROKEN = "Give-orchestration-task-titles-a-full-width-line-that-wraps-instead-of-ending-in-an-ellipsis";
const SHORT = "Record final evidence";
const agent = (id, name, over = {}) => ({
  id, name, role: "", agent: "claude", model: "opus", effort: "high", access: "auto",
  createdAt: now - 100_000, updatedAt: now - 100_000, ...over,
});
const team = [
  agent("maya", "Maya", { role: "CTO" }),
  agent("lena", "Lena", { role: "Project lead", projectId: "general", reportsTo: "maya" }),
  agent("noah", "Mango Juice", { role: "Frontend engineer", projectId: "general", reportsTo: "lena" }),
];
const chat = (id, title) => ({
  id, projectId: "general", title, customTitle: true, modelId: "claude:opus", access: "auto",
  sessionId: `session-${id}`, createdAt: now - 200_000, updatedAt: now - 190_000,
});
const chats = [chat("lead", "Ship the logo ring"), chat("orch-1", LONG), chat("orch-2", UNBROKEN)];
const task = (id, over) => ({
  id, runId: "run-lead", spec: "", dependsOn: [], createdAt: now - 180_000, updatedAt: now - 20_000,
  assignee: { id: "noah", name: "Mango Juice" }, ...over,
});
const attempt = (id, taskId, chatKey, over = {}) => ({
  id, runId: "run-lead", taskId, number: 1, workerChatKey: chatKey, agent: "claude", access: "auto",
  status: "running", cwd: "/w", isWorktree: true, filesModified: [],
  execution: { state: "executing", retryCount: 0, lastActivityAt: now - 1_000 },
  createdAt: now - 141_000, updatedAt: now - 1_000, ...over,
});
const snapshot = {
  runs: [
    { id: "run-lead", coordinatorChatKey: "chat:lead", objective: "Show a loading indicator around the project logo", workspaceId: "general",
      rootPath: "/Users/kyson/General", status: "running", maxConcurrent: 4, createdAt: now - 190_000, updatedAt: now - 20_000,
      planApproval: { status: "approved", requestedAt: now - 189_000, decidedAt: now - 188_000 } },
  ],
  tasks: [
    task("t1", { title: LONG, status: "running", activeAttemptId: "a1" }),
    task("t2", { title: UNBROKEN, status: "running", activeAttemptId: "a2" }),
    task("t3", { title: SHORT, status: "pending", activeAttemptId: null, dependsOn: ["t1"] }),
  ],
  attempts: [
    attempt("a1", "t1", "chat:orch-1", { branch: "feature/octiq-57d5348d6b0b4b3f9de3389fda92388f" }),
    attempt("a2", "t2", "chat:orch-2", { branch: "feature/a-really-long-descriptive-branch-name-that-keeps-on-going", execution: undefined }),
  ],
  gates: [], messages: [],
  reports: {
    "chat:orch-2": { objective: UNBROKEN, reportedAt: now - 30_000, steps: [
      { title: "Read the row component", state: "done" },
      { title: "Validating every viewport width with lengthy titles and branch names", state: "active" },
      { title: "Commit", state: "pending" },
    ] },
  },
};

const logs = new Map();
const record = (key, event) => {
  const log = logs.get(key) ?? [];
  const frame = { seq: log.length + 1, event };
  log.push(frame);
  logs.set(key, log);
};
for (const { id, title } of chats) {
  record(`chat:${id}`, { type: "user", uuid: `u-${id}`, octiq_user_turn: true, message: { content: [{ type: "text", text: `Start: ${title}` }] } });
  record(`chat:${id}`, { type: "item.completed", item: { id: `i-${id}`, type: "agent_message", text: `First answer in ${id}.` } });
  record(`chat:${id}`, { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
}

const errors = [];
const server = await createServer({
  root: new URL("../web", import.meta.url).pathname,
  configFile: new URL("../web/vite.config.ts", import.meta.url).pathname,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
function resultFor(request) {
  switch (request.cmd) {
    case "list_workspaces": return [{ id: "general", name: "General", primary_path: "/Users/kyson/General" }];
    case "chat_index_list": return chats;
    case "chat_index_deleted": return [];
    case "chat_page": return { events: logs.get(request.args?.key) ?? [], context: [], before: null };
    case "chat_since": return (logs.get(request.args?.key) ?? []).filter((frame) => frame.seq > (request.args?.after ?? 0));
    case "chat_list": return ["chat:lead", "chat:orch-1", "chat:orch-2"];
    case "chat_activity": return [];
    case "chat_queue_state": return { live: true, queuedTurnIds: [] };
    case "orchestration_snapshot": return snapshot;
    case "permission_pending": return [];
    case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
    case "usage_summary": return {};
    case "agent_installs": return [{ id: "codex", installed: true, path: "/mock/codex" }, { id: "claude", installed: true, path: "/mock/claude" }];
    case "team_list": return request.args?.all ? team : team.filter((a) => !a.projectId);
    case "team_head": return team[0];
    case "team_leads": return [{ chatKey: "chat:lead", leadId: "lena", leadName: "Lena", projectId: "general", createdAt: now - 200_000 }];
    case "team_home": return "general";
    case "chat_task": return { chatId: request.args?.chatId, projectId: "general" };
    case "sandbox_snapshot": return { defaultEnabled: false, environments: {} };
    case "codex_skills": return [];
    default: return null;
  }
}

const rowOf = (page, title) => page.locator(".orch-task").filter({ has: page.locator(".orch-task-title", { hasText: title }) });
const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

/** Every visible row: the title is whole and on its own line; nothing overlaps. */
async function checkRows(page, label, { touch }) {
  const rows = await page.locator(".orch-task").evaluateAll((articles) => articles.filter((a) => a.offsetParent).map((article) => {
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
    const title = article.querySelector(".orch-task-title");
    const style = getComputedStyle(title);
    const meta = article.querySelector(".orch-task-meta");
    return {
      text: title.textContent,
      title: box(title),
      clipped: title.scrollWidth > title.clientWidth + 1,
      ellipsis: style.textOverflow === "ellipsis" || style.whiteSpace === "nowrap" || style.webkitLineClamp !== "none",
      lineHeight: parseFloat(style.lineHeight),
      summary: box(article.querySelector(".orch-task-summary")),
      heading: box(article.querySelector(".orch-task-heading")),
      meta: box(meta),
      metaChildren: [...meta.children].map(box),
      state: box(article.querySelector(".orch-task-state")),
      actions: box(article.querySelector(".orch-task-actions")),
      controls: [...article.querySelectorAll(".orch-task-actions > button")].map(box),
    };
  }));
  assert(rows.length >= 3, `${label}: three rows on show (${rows.length})`);
  const overlaps = (a, b) => a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5;
  for (const row of rows) {
    const name = `${label} · ${row.text.slice(0, 24)}`;
    assert.equal(row.ellipsis, false, `${name}: no ellipsis, nowrap or clamp`);
    assert.equal(row.clipped, false, `${name}: the title is not cut`);
    // Full width: from after the glyph to the summary's right edge, over the controls' column.
    assert(row.title.r >= row.actions.r - 1, `${name}: title reaches the row's right edge (${row.title.r} vs ${row.actions.r})`);
    assert(row.title.b <= row.meta.t + 0.5, `${name}: status line is under the title`);
    assert(row.title.b <= row.actions.t + 0.5, `${name}: controls are under the title`);
    assert(Math.abs(row.state.l - row.meta.l) < 1 && row.state.t < row.meta.t + row.meta.h / 2, `${name}: status leads line two`);
    for (const child of row.metaChildren) {
      assert(!overlaps(child, row.actions), `${name}: line two never runs under the controls`);
      assert(child.r <= row.heading.r + 0.5, `${name}: line two stays inside the row`);
    }
    assert(row.actions.b <= row.heading.b + 0.5, `${name}: controls inside the row`);
    for (const control of row.controls) {
      const min = touch ? 44 : 32;
      assert(control.w >= min - 0.5 && control.h >= min - 0.5, `${name}: ${min}px control (${control.w}x${control.h})`);
    }
  }
  // On a phone neither fits one line, so both must wrap (the clip check above
  // already proves nothing is cut at any width).
  if (touch) {
    for (const text of [LONG, UNBROKEN]) {
      const row = rows.find((candidate) => candidate.text === text);
      assert(row.title.h >= row.lineHeight * 2 - 1, `${label}: "${text.slice(0, 16)}" wraps (${row.title.h})`);
    }
  }
  return rows;
}

async function openRunPanel(page, phone) {
  if (phone) {
    const tasksView = page.locator("button[aria-pressed]").filter({ hasText: /^(Tasks|Run)/ }).first();
    await tasksView.waitFor();
    if (await tasksView.getAttribute("aria-pressed") !== "true") await tasksView.click();
  }
  const toggle = page.locator(".orch-run-accordion-toggle").first();
  if (await toggle.count() && await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
  await rowOf(page, SHORT).waitFor();
}

let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
  const viewports = [
    { name: "375", width: 375, height: 812, phone: true },
    { name: "430", width: 430, height: 932, phone: true },
    { name: "1024", width: 1024, height: 800, phone: false },
    { name: "1440", width: 1440, height: 960, phone: false },
  ];
  const results = {};
  for (const viewport of viewports) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height }, reducedMotion: "reduce",
      ...(viewport.phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
    });
    await context.addInitScript(() => {
      if (location.protocol === "about:") return;
      localStorage.setItem("octiq.agentsMode", "on");
      localStorage.setItem("octiq.v2.gitColumn", "0");
    });
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
    page.on("pageerror", (error) => errors.push(`${viewport.name}: ${error.stack ?? error}`));
    await page.goto(`${base}#/p/general/c/lead`, { waitUntil: "domcontentloaded" });
    if (viewport.width === 1024) {
      // The run column folds into a tab below 1181px.
      await page.locator(".main").getByText("First answer in lead.", { exact: true }).waitFor();
    }
    await openRunPanel(page, viewport.width < 1181);
    const touch = viewport.phone;
    const rows = await checkRows(page, viewport.name, { touch });
    results[viewport.name] = rows.map((row) => ({ title: row.text.slice(0, 30), titleLines: Math.round(row.title.h / row.lineHeight), rowHeight: Math.round(row.heading.h) }));
    assert.equal(await noHorizontalScroll(page), true, `${viewport.name}: no sideways scroll`);
    const panel = page.locator(".orch-run-accordion").first();
    await panel.screenshot({ path: join(artifacts, `${viewport.name}-rows.png`) });
    await page.screenshot({ path: join(artifacts, `${viewport.name}-page.png`) });

    // Expand and collapse a row's progress: the controls keep their place.
    const expand = page.getByRole("button", { name: `Expand task progress: ${UNBROKEN}`, exact: true });
    await expand.click();
    await page.getByRole("button", { name: `Collapse task progress: ${UNBROKEN}`, exact: true }).waitFor();
    await rowOf(page, UNBROKEN).locator(".orch-task-detail").waitFor({ state: "visible" });
    await checkRows(page, `${viewport.name} expanded`, { touch });
    await panel.screenshot({ path: join(artifacts, `${viewport.name}-row-expanded.png`) });
    await page.getByRole("button", { name: `Collapse task progress: ${UNBROKEN}`, exact: true }).click();
    await rowOf(page, UNBROKEN).locator(".orch-task-detail").waitFor({ state: "hidden" });

    // The run's own disclosure: rows go away and come back as they were.
    const accordion = page.locator(".orch-run-accordion-toggle").first();
    if (await accordion.count()) {
      await accordion.click();
      await rowOf(page, SHORT).waitFor({ state: "hidden" });
      await accordion.click();
      await rowOf(page, SHORT).waitFor();
      await checkRows(page, `${viewport.name} reopened`, { touch });
    }

    // The row still opens its chat — from line two as well as the title — and
    // shows it selected; the row on screen drops its beside button.
    const lineTwo = rowOf(page, LONG).locator(".orch-task-state");
    await lineTwo.click();
    await page.waitForURL(/\/c\/orch-1$/);
    if (viewport.width < 1181) {
      // Where the run panel is a tab, the chat takes its place; bring it back.
      await openRunPanel(page, true);
    }
    const selected = rowOf(page, LONG);
    await selected.locator(".orch-task-summary[aria-current=page]").waitFor();
    assert.equal(await selected.locator(".orch-task-beside").count(), 0);
    await checkRows(page, `${viewport.name} selected`, { touch });
    await page.locator(".orch-run-accordion").first().screenshot({ path: join(artifacts, `${viewport.name}-row-selected.png`) });

    // Open beside main from the other row's control.
    await rowOf(page, UNBROKEN).getByRole("button", { name: `Open beside main: ${UNBROKEN}`, exact: true }).click();
    await page.waitForURL(/\/c\/lead\/beside\/orch-2$/);
    assert.equal(await noHorizontalScroll(page), true, `${viewport.name}: no sideways scroll beside`);
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, mockedBackend: true, artifacts, results }));
} catch (error) {
  const page = browser?.contexts()[0]?.pages().at(-1);
  await page?.screenshot({ path: join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ error: String(error), errors, url: page?.url() }));
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
