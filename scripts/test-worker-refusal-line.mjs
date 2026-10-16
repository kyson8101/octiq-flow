// Draws the real App with two workers' auto-mode refusals waiting in their
// coordinator's chat (feedback 76cde28e: "<worker>: 1 action blocked by
// Claude's auto mode · nothing to approve"), one worker titled in CJK and
// Latin mixed, one in Latin alone, and checks the line is a row of the group
// above the composer:
//
//   - the chevron's centre, the icon's centre and the text box's centre are
//     within 1px of each other, folded and opened, at 1280 and at 390;
//   - the row starts on the group's left edge, with its icon in the group's
//     icon column, and is one line that stays inside the row;
//   - Enter opens it (the card is drawn and the chevron turns), Space shuts it;
//   - no browser marker is drawn.
//
// The socket is mocked; everything else is the real App and its CSS.
//
//   OCTIQ_THEMES=dark,light,manga,guofeng,xp   the modes (these by default)
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
const themes = (process.env.OCTIQ_THEMES || "dark,light,manga,guofeng,xp").split(",").map((t) => t.trim()).filter(Boolean);
const artifacts = process.env.OCTIQ_EVIDENCE_DIR || await mkdtemp(join(tmpdir(), "octiq-refusal-line-"));
await mkdir(artifacts, { recursive: true });

const now = Date.now();
const root = "/Users/kyson/03-projects/octiq-flow";
const CJK = "OUTSOURCED MV v5：补 1:15 三帧回闪";
const LATIN = "Check the release links";
const main = {
  id: "main", projectId: "octiq", title: "Tidy the release notes", customTitle: true, modelId: "claude:opus", access: "auto", effort: "high",
  sessionId: "session-main", cwd: root, createdAt: now - 500_000, updatedAt: now - 1_000, coordinatesRun: true,
};
const worker = (id, title) => ({ ...main, id, title, sessionId: `session-${id}`, coordinatesRun: false, updatedAt: now - 60_000 });
const chats = [main, worker("orch-w", CJK), worker("orch-x", LATIN)];

const record = [
  { type: "user", uuid: "u-1", octiq_user_turn: true, message: { content: [{ type: "text", text: "Ship the release notes." }] } },
  { type: "assistant", message: { id: "msg-1", role: "assistant", content: [{ type: "text", text: "Two workers are on it." }] } },
  { type: "result", subtype: "success", is_error: false, result: "Two workers are on it." },
].map((event, at) => ({ seq: at + 1, event }));

const task = (id, title, extra = {}) => ({
  id, runId: "run-1", title, spec: "Do the thing.", dependsOn: [], status: "running",
  destination: { projectId: "octiq", projectName: "OctiqFlow", repository: root }, heldByPlan: false,
  createdAt: now - 400_000, updatedAt: now - 20_000, ...extra,
});
const attempt = (id, taskId, chat) => ({
  id, runId: "run-1", taskId, number: 1, workerChatKey: `chat:${chat}`, agent: "claude", access: "auto",
  status: "running", cwd: root, branch: `feature/${taskId}`, isWorktree: true, filesModified: [],
  execution: { state: "executing", retryCount: 0, lastActivityAt: now - 1_000 }, createdAt: now - 60_000, updatedAt: now - 5_000,
});
const snapshot = {
  runs: [{
    id: "run-1", coordinatorChatKey: "chat:main", objective: main.title, workspaceId: "octiq", rootPath: root,
    status: "running", maxConcurrent: 2, createdAt: now - 450_000, updatedAt: now - 20_000,
    planApproval: { status: "approved", requestedAt: now - 440_000, decidedAt: now - 430_000 },
  }],
  tasks: [task("w", CJK, { activeAttemptId: "att-w" }), task("x", LATIN, { activeAttemptId: "att-x" })],
  attempts: [attempt("att-w", "w", "orch-w"), attempt("att-x", "x", "orch-x")],
  gates: [], messages: [], notifications: [],
};
const refusal = (id, chat) => ({
  id, chatKey: `chat:${chat}`, provider: "claude", kind: "high-risk-action",
  title: "Claude's auto mode blocked an action", summary: "Production Deploy",
  detail: "Permission for this action was denied by the Claude Code auto mode classifier.",
  action: "eas update --branch production",
});
const blocks = [refusal("sb-w", "orch-w"), refusal("sb-x", "orch-x")];

function resultFor(request) {
  switch (request.cmd) {
    case "list_workspaces": return [{ id: "octiq", name: "octiq-flow", primary_path: root }];
    case "chat_index_list": return chats;
    case "chat_index_deleted": return [];
    case "chat_page": return { events: request.args?.key === "chat:main" ? record : [], context: [], before: null };
    case "chat_since": return [];
    case "safety_block_pending": return blocks;
    case "permission_pending": case "question_pending": case "chat_list": case "chat_activity": case "access_request_pending":
    case "pr_repositories": case "codex_skills": case "image_preview_list": case "team_list": case "team_leads":
      return [];
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
const report = { artifacts, scenes: {} };

async function open(browser, theme, { width, height, phone = false }) {
  const context = await browser.newContext({
    viewport: { width, height }, reducedMotion: "reduce", deviceScaleFactor: 2,
    ...(phone ? { hasTouch: true, isMobile: true } : {}),
  });
  await context.addInitScript(({ mode, rows }) => {
    // The chats as this browser last listed them. With a socket that answers
    // at once, the deep link's own index read can land before the list's
    // rows reach the page's ref and put back only the chat it found; a
    // browser that has been here before holds the workers' titles already.
    localStorage.setItem("octiq.v2.conversations", JSON.stringify(rows));
    localStorage.setItem("octiq.agentsMode", "off");
    localStorage.setItem("octiq.theme", mode);
    localStorage.setItem("octiq.v2.terminalOpen", "0");
    localStorage.setItem("octiq.v2.gitColumn", "0");
  }, { mode: theme, rows: chats.map((chat) => ({ ...chat, messages: [], permission: chat.access, synced: true, schema: 4 })) });
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
  await page.locator(".worker-refusal-line > summary").nth(1).waitFor({ timeout: 180_000 });
  await page.evaluate(() => document.fonts.ready);
  return { context, page };
}

/** Where each part of every refusal row is, read off the page. */
const measure = (page) => page.evaluate(() => {
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, cy: (r.top + r.bottom) / 2, height: r.height };
  };
  const group = document.querySelector(".chat-status > *");
  const groupIcon = document.querySelector(".chat-status .status-row-icon");
  return [...document.querySelectorAll(".worker-refusal-line")].map((line) => {
    const summary = line.querySelector(":scope > summary");
    const text = summary.querySelector(".status-row-text");
    const range = document.createRange();
    range.selectNodeContents(text);
    const rects = [...range.getClientRects()];
    const marker = getComputedStyle(summary, "::marker");
    return {
      title: text.textContent,
      open: line.open,
      summary: box(summary),
      text: box(text),
      textLines: new Set(rects.map((r) => Math.round(r.top))).size,
      // The glyphs' own boxes, which a fallback font can make taller or
      // move: what the eye lines the chevron up with.
      glyphs: rects.length ? { top: Math.min(...rects.map((r) => r.top)), bottom: Math.max(...rects.map((r) => r.bottom)) } : null,
      textCut: text.scrollWidth > text.clientWidth,
      chevron: box(summary.querySelector(".status-row-chevron svg")),
      icon: box(summary.querySelector(".status-row-icon svg")),
      iconColumn: box(summary.querySelector(".status-row-icon")),
      chevronTurn: getComputedStyle(summary.querySelector(".status-row-chevron")).transform,
      display: getComputedStyle(summary).display,
      marker: marker.content,
      color: getComputedStyle(summary).color,
      fg3: getComputedStyle(document.documentElement).getPropertyValue("--fg-3").trim(),
      card: !!line.querySelector(".safety-card, .ask-card")?.checkVisibility(),
      group: box(group),
      groupIcon: box(groupIcon),
    };
  });
});

function check(rows, where) {
  for (const row of rows) {
    const at = `${where} · ${row.title.slice(0, 24)}`;
    assert.ok(Math.abs(row.chevron.cy - row.text.cy) <= 1, `${at}: chevron centre ${row.chevron.cy} vs text ${row.text.cy}`);
    assert.ok(Math.abs(row.icon.cy - row.text.cy) <= 1, `${at}: icon centre ${row.icon.cy} vs text ${row.text.cy}`);
    assert.equal(row.textLines, 1, `${at}: one line`);
    const glyphs = (row.glyphs.top + row.glyphs.bottom) / 2;
    assert.ok(Math.abs(row.chevron.cy - glyphs) <= 1, `${at}: chevron centre ${row.chevron.cy} vs glyphs ${glyphs}`);
    assert.ok(row.text.right <= row.chevron.left + 0.5, `${at}: words end before the chevron`);
    assert.ok(row.chevron.right <= row.summary.right + 0.5, `${at}: chevron inside the row`);
    assert.equal(row.display, "flex", `${at}: summary is a flex row`);
    assert.ok(row.marker === "none" || row.marker === '""' || row.marker === "normal", `${at}: no browser marker (${row.marker})`);
    if (row.group) assert.ok(Math.abs(row.summary.left - row.group.left) <= 0.5, `${at}: left edge ${row.summary.left} vs group ${row.group.left}`);
    if (row.groupIcon) assert.ok(Math.abs(row.iconColumn.left - row.groupIcon.left) <= 0.5, `${at}: icon column ${row.iconColumn.left} vs group ${row.groupIcon.left}`);
  }
}

await server.listen();
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
try {
  for (const theme of themes) {
    for (const [name, size] of [["1280", { width: 1280, height: 860 }], ["390", { width: 390, height: 844, phone: true }]]) {
      const { context, page } = await open(browser, theme, size);
      const where = `${theme}@${name}`;
      const folded = await measure(page);
      check(folded, `${where} folded`);
      assert.ok(folded.every((row) => !row.open && !row.card), `${where}: starts folded`);
      const shot = (state) => page.screenshot({ path: join(artifacts, `${theme}-${name}-${state}.png`) });
      const close = async (state) => {
        const top = await page.locator(".worker-refusal-line").first().boundingBox();
        const status = await page.locator(".chat-status").boundingBox();
        const y = Math.max(0, top.y - 8);
        await page.screenshot({ path: join(artifacts, `${theme}-${name}-${state}-rows.png`),
          clip: { x: 0, y, width: size.width, height: Math.min(size.height - y, (status ? status.y + status.height : top.y + 80) - y + 8) } });
      };
      await shot("folded");
      await close("folded");

      // The keyboard opens the first (the CJK title) and the card is drawn.
      const first = page.locator(".worker-refusal-line > summary").first();
      await first.focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.querySelector(".worker-refusal-line")?.open);
      const opened = await measure(page);
      check(opened, `${where} opened`);
      assert.equal(opened[0].open, true, `${where}: Enter opened it`);
      assert.equal(opened[0].card, true, `${where}: the card is drawn`);
      assert.match(opened[0].chevronTurn, /^matrix\(-1, .*-1, 0, 0\)$/, `${where}: chevron turned (${opened[0].chevronTurn})`);
      const ring = await first.evaluate((el) => ({ focus: el.matches(":focus-visible"), outline: getComputedStyle(el).outlineStyle }));
      assert.equal(ring.focus, true, `${where}: focus ring`);
      assert.equal(ring.outline, "solid", `${where}: focus ring drawn`);
      await shot("opened");
      await first.evaluate((el) => el.closest("details").scrollIntoView({ block: "nearest" }));
      await page.screenshot({ path: join(artifacts, `${theme}-${name}-opened-card.png`),
        clip: await page.locator(".worker-refusal-line").first().boundingBox().then((b) => ({ x: 0, y: Math.max(0, b.y - 8), width: size.width, height: Math.min(b.height + 16, size.height - Math.max(0, b.y - 8)) })) });
      await page.keyboard.press("Space");
      await page.waitForFunction(() => !document.querySelector(".worker-refusal-line")?.open);

      const sideways = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(sideways, false, `${where}: nothing scrolls sideways`);
      report.scenes[where] = {
        folded: folded.map((r) => ({ title: r.title.slice(0, 32), chevronVsText: +(r.chevron.cy - r.text.cy).toFixed(2), chevronVsGlyphs: +(r.chevron.cy - (r.glyphs.top + r.glyphs.bottom) / 2).toFixed(2), glyphHeight: +(r.glyphs.bottom - r.glyphs.top).toFixed(2), iconVsText: +(r.icon.cy - r.text.cy).toFixed(2), rowHeight: r.summary.height, left: r.summary.left, groupLeft: r.group?.left ?? null, cut: r.textCut, color: r.color })),
        opened: opened.map((r) => ({ open: r.open, chevronVsText: +(r.chevron.cy - r.text.cy).toFixed(2), turn: r.chevronTurn })),
      };
      await context.close();
    }
  }
  assert.deepEqual(errors, [], "no page errors");
  report.passed = true;
} catch (error) {
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  report.errors = errors;
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
  await server.close();
}
