// Draws the real App in one appearance mode, at 1280 and at 390, for the
// screens a mode has to get right: a chat with a reply, a permission card and
// a question waiting on the person, the run panel beside the chat, the
// terminal, Settings' appearance tiles and the empty page. It also checks what
// a mode must never break: the phone keeps the phone's layout, nothing scrolls
// the page sideways, and the action bar keeps its height (36px, 45px on a
// phone).
//
// The socket is mocked; everything else is the real App and its CSS.
//
//   OCTIQ_THEME=light|dark|fun|manga|guofeng|xp   the mode (xp)
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
    await resume.hover();
    await empty.page.waitForTimeout(250);
    await empty.page.screenshot({ path: join(artifacts, `${theme}-button-hover.png`), clip: await resume.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.left - 12, y: r.top - 12, width: r.width + 24, height: r.height + 24 }; }) });
  }
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
  const { desktop: d, phone: p } = report.scenes;
  assert.equal(d.frame.theme, theme === "dark" ? null : theme);
  assert.equal(d.frame.sideways, false, "no sideways scroll at 1280");
  assert.equal(p.frame.sideways, false, "no sideways scroll at 390");
  assert.equal(d.frame.actionBar, 36, "the action bar is 36px on a desktop");
  assert.equal(p.frame.actionBar, 45, "the action bar is 45px on a phone");
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
