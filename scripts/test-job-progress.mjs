// Draws the real App with jobs an agent registered with the host (`lib/jobs`)
// and checks every place the page says them, at 1280 and at 390:
//
//   - the line above the composer: the job's label, its phase, a bar and its
//     own percent, on one line that stays inside the composer;
//   - the tool card that ran `octiq-job`: `in background · 40%`, on that one
//     card and on no other;
//   - the worker's row in the run panel: `Encoding · 60%`;
//   - the turn that woke the agent when an earlier job ended: `Job finished`
//     with `Build · exit 0`, the host's words behind a disclosure;
//   - a `chat-job` event moves the strip and the card to the new percent,
//     and a job's end takes it off both.
//
// The socket is mocked (`chat_jobs` answers as the contract says, and the
// script sends `chat-job` events); everything else is the real App and its
// CSS. Waits are on conditions, never on a clock.
//
//   OCTIQ_THEMES=dark,light   the modes (dark by default)
//   OCTIQ_EVIDENCE_DIR        where the screenshots go (a temp folder otherwise)
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
const themes = (process.env.OCTIQ_THEMES || "dark").split(",").map((t) => t.trim()).filter(Boolean);
const artifacts = process.env.OCTIQ_EVIDENCE_DIR || await mkdtemp(join(tmpdir(), "octiq-job-progress-"));
await mkdir(artifacts, { recursive: true });

const now = Date.now();
const root = "/Users/kyson/03-projects/octiq-flow";
const main = {
  id: "main", projectId: "octiq", title: "Render the launch video", customTitle: true, modelId: "claude:opus", access: "auto", effort: "high",
  sessionId: "session-main", cwd: root, createdAt: now - 900_000, updatedAt: now - 1_000, coordinatesRun: true,
};
const workerChat = { ...main, id: "orch-w", title: "Cut the trailer", sessionId: "session-w", coordinatesRun: false, updatedAt: now - 60_000 };
const chats = [main, workerChat];

const BUILD = "octiq-job --label Build -- cargo build --release";
const RENDER = `octiq-job --label "Render mp4" -- npx remotion render src/index.ts Main out.mp4`;
const WAKE = "The job Build (job_0) finished with exit code 0 after 2m 10s.\nLast lines:\n    Finished `release` profile [optimized] target(s)";
const toolUse = (msg, id, command, text) => ({
  type: "assistant",
  message: { id: msg, role: "assistant", content: [{ type: "text", text }, { type: "tool_use", id, name: "Bash", input: { command, description: text } }] },
});
const toolResult = (id, text) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
/** A recorded turn and Claude's echo of it: the echo is what says it reached
 *  the agent. */
const turn = (id, text) => [
  { type: "user", uuid: id, octiq_user_turn: true, message: { content: [{ type: "text", text }] } },
  { type: "user", isReplay: true, uuid: `echo-${id}`, octiq_user_turn_id: id, message: { role: "user", content: [{ type: "text", text }] } },
];
const record = [
  ...turn("u-1", "Build it, then render the launch video."),
  toolUse("msg-1", "toolu_build", BUILD, "Building first."),
  toolResult("toolu_build", "Registered job job_0 (Build). You will be woken when it ends."),
  { type: "assistant", message: { id: "msg-2", role: "assistant", content: [{ type: "text", text: "The build runs as a job; I will pick up when it ends." }] } },
  { type: "result", subtype: "success", is_error: false, result: "The build runs as a job." },
  ...turn("octiq-job-job_0", WAKE),
  toolUse("msg-3", "toolu_render", RENDER, "Build passed. Rendering now."),
  toolResult("toolu_render", "Registered job job_1 (Render mp4). You will be woken when it ends."),
  { type: "assistant", message: { id: "msg-4", role: "assistant", content: [{ type: "text", text: "The render is running as a job." }] } },
  { type: "result", subtype: "success", is_error: false, result: "The render is running as a job." },
].map((event, at) => ({ seq: at + 1, event }));

/** A job exactly as the contract says the host sends it. */
const job = (over) => ({
  id: "job_x", chatKey: "chat:main", label: "Job", source: "wrapper", status: "running",
  elapsedMs: 60_000, sinceUpdateMs: 300, wake: true, ...over,
});
const jobs = {
  build: job({ id: "job_0", label: "Build", status: "done", exitCode: 0, elapsedMs: 130_000, sinceUpdateMs: 120_000, command: "cargo build --release" }),
  render: job({ id: "job_1", label: "Render mp4", phase: "Encoding", done: 120, total: 300, unit: "frames", elapsedMs: 95_000, command: "npx remotion render src/index.ts Main out.mp4" }),
  worker: job({ id: "job_w", chatKey: "chat:orch-w", label: "Trailer cut", phase: "Encoding", done: 60, total: 100, unit: "percent", elapsedMs: 40_000, command: "ffmpeg -i in.mov out.mp4" }),
};

const task = { id: "w", runId: "run-1", title: "Cut the trailer", spec: "Cut it.", dependsOn: [], status: "running",
  destination: { projectId: "octiq", projectName: "OctiqFlow", repository: root }, heldByPlan: false,
  activeAttemptId: "att-w", createdAt: now - 400_000, updatedAt: now - 20_000 };
const attempt = { id: "att-w", runId: "run-1", taskId: "w", number: 1, workerChatKey: "chat:orch-w", agent: "claude", access: "auto",
  status: "running", cwd: root, branch: "feature/w", isWorktree: true, filesModified: [],
  execution: { state: "executing", retryCount: 0, lastActivityAt: now - 1_000 }, createdAt: now - 60_000, updatedAt: now - 5_000 };
const snapshot = {
  runs: [{ id: "run-1", coordinatorChatKey: "chat:main", objective: main.title, workspaceId: "octiq", rootPath: root,
    status: "running", maxConcurrent: 2, createdAt: now - 450_000, updatedAt: now - 20_000,
    planApproval: { status: "approved", requestedAt: now - 440_000, decidedAt: now - 430_000 } }],
  tasks: [task], attempts: [attempt], gates: [], messages: [], notifications: [],
};

function resultFor(request) {
  switch (request.cmd) {
    case "chat_jobs": {
      const all = Object.values(jobs);
      return { jobs: request.args?.chatKey ? all.filter((j) => j.chatKey === request.args.chatKey) : all };
    }
    case "list_workspaces": return [{ id: "octiq", name: "octiq-flow", primary_path: root }];
    case "chat_index_list": return chats;
    case "chat_index_deleted": return [];
    case "chat_page": return { events: request.args?.key === "chat:main" ? record : [], context: [], before: null };
    case "chat_since": return [];
    case "permission_pending": case "question_pending": case "chat_list": case "chat_activity": case "access_request_pending":
    case "safety_block_pending": case "pr_repositories": case "codex_skills": case "image_preview_list": case "team_list": case "team_leads":
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
/** The page on screen, for a picture of it when a check fails. */
let current = null;

async function open(browser, theme, { width, height, phone = false }) {
  const context = await browser.newContext({
    viewport: { width, height }, reducedMotion: "reduce", deviceScaleFactor: 2,
    ...(phone ? { hasTouch: true, isMobile: true } : {}),
  });
  await context.addInitScript(({ mode, rows }) => {
    localStorage.setItem("octiq.v2.conversations", JSON.stringify(rows));
    localStorage.setItem("octiq.agentsMode", "off");
    localStorage.setItem("octiq.theme", mode);
    localStorage.setItem("octiq.v2.terminalOpen", "0");
    localStorage.setItem("octiq.v2.gitColumn", "0");
  }, { mode: theme, rows: chats.map((chat) => ({ ...chat, messages: [], permission: chat.access, synced: true, schema: 4 })) });
  await context.route("**/token", (route) => route.fulfill({ body: "mock-token" }));
  await context.route("**/auth", (route) => route.fulfill({ body: "ok" }));
  const sockets = [];
  await context.routeWebSocket(/.*/, (socket) => {
    sockets.push(socket);
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw));
      if (request.t !== "invoke") return;
      socket.send(JSON.stringify({ t: "reply", id: request.id, ok: true, result: resultFor(request) }));
    });
  });
  const send = (event, payload) => { for (const socket of sockets) socket.send(JSON.stringify({ t: "event", event, payload })); };
  const page = await context.newPage();
  page.setDefaultTimeout(180_000);
  page.on("pageerror", (error) => errors.push(error.stack ?? String(error)));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/#/p/octiq-flow/c/main`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  await page.locator(".composer-hint .job-percent").waitFor({ timeout: 180_000 });
  await page.evaluate(() => document.fonts.ready);
  return { context, page, send };
}

/** What the page says of the jobs, read off it. */
const read = (page) => page.evaluate(() => {
  const text = (el) => el?.textContent?.replace(/\s+/g, " ").trim() ?? null;
  const box = (el) => { const r = el?.getBoundingClientRect(); return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height } : null; };
  const said = document.querySelector(".composer-hint-said");
  const lineHeight = said ? parseFloat(getComputedStyle(said).lineHeight) || 16 : 16;
  const chips = [...document.querySelectorAll(".tool-state.is-background")];
  const fill = document.querySelector(".composer-hint .job-fill");
  // The label is drawn by `RollingText`, whose wheels hold every digit they
  // turn through: its words are read from the title, and the rest of the
  // line from the line with the label taken out.
  const label = said?.querySelector(".bgwork-said");
  const rest = said?.cloneNode(true);
  rest?.querySelector(".bgwork-said")?.remove();
  return {
    strip: said ? `${label?.title.split("\n")[0].split(" · ")[0] ?? ""} ${text(rest) ?? ""}`.replace(/\s+/g, " ").trim() : null,
    stripBox: box(said),
    stripLines: said ? Math.round(said.getBoundingClientRect().height / lineHeight) : null,
    stripCut: said ? said.scrollWidth > said.clientWidth : null,
    composer: box(document.querySelector(".composer")),
    percent: text(document.querySelector(".composer-hint .job-percent")),
    phase: text(document.querySelector(".composer-hint .job-phase")),
    fillWidth: fill?.style.width ?? null,
    fillColor: fill ? getComputedStyle(fill).backgroundColor : null,
    chips: chips.map(text),
    chipCard: chips.map((chip) => text(chip.closest(".tool")?.querySelector(".tool-detail, .tool-head"))),
    rowNote: text(document.querySelector('.run-row-note[data-job]')),
    wakeLabel: text(document.querySelector('.wrap-up-note[data-mark="job"] .wrap-up-note-label')),
    wakeDetail: text(document.querySelector('.wrap-up-note[data-mark="job"] .wrap-up-note-detail')),
    wakeSummary: text(document.querySelector('.wrap-up-note[data-mark="job"] summary')),
    wakeActions: text(document.querySelector('.wrap-up-note[data-mark="job"]')?.closest(".message-bubble")?.querySelector(".message-delivery")),
    wakeQuoted: [...document.querySelectorAll(".msg-user .user-text, .msg-user .msg-body > p")].some((el) => el.textContent.includes("finished with exit code 0")),
    sideways: document.documentElement.scrollWidth > innerWidth,
  };
});

await server.listen();
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
try {
  for (const theme of themes) {
    for (const [name, size] of [["1280", { width: 1280, height: 860 }], ["390", { width: 390, height: 844, phone: true }]]) {
      const { context, page, send } = await open(browser, theme, size);
      current = { page, at: `${theme}-${name}` };
      const where = `${theme}@${name}`;
      const shot = (state) => page.screenshot({ path: join(artifacts, `${theme}-${name}-${state}.png`) });
      const clip = async (selector, state) => {
        const target = page.locator(selector).first();
        await target.scrollIntoViewIfNeeded();
        const b = await target.boundingBox();
        const y = Math.max(0, b.y - 8);
        await page.screenshot({ path: join(artifacts, `${theme}-${name}-${state}.png`),
          clip: { x: 0, y, width: size.width, height: Math.min(size.height - y, b.height + 16) } });
      };

      // The wake turn is the first thing in the transcript worth a look.
      await page.locator('.wrap-up-note[data-mark="job"]').waitFor();
      await page.locator(".tool-state.is-background").first().waitFor();
      const first = await read(page);
      assert.match(first.strip, /^Render mp4 · Encoding · 40%$/, `${where}: strip says ${first.strip}`);
      assert.equal(first.fillWidth, "40%", `${where}: bar at the job's percent`);
      assert.equal(first.stripLines, 1, `${where}: strip is one line`);
      assert.ok(first.stripBox.right <= first.composer.right + 0.5, `${where}: strip inside the composer`);
      assert.deepEqual(first.chips, ["in background · 40%"], `${where}: one card marked (${JSON.stringify(first.chips)})`);
      assert.equal(first.wakeLabel, "Job finished", `${where}: wake label`);
      assert.equal(first.wakeDetail, "Build · exit 0", `${where}: wake detail`);
      assert.match(first.wakeSummary, /^What the agent was told · 3 lines$/, `${where}: wake disclosure`);
      assert.equal(first.wakeQuoted, false, `${where}: the host's words are not drawn as the person's`);
      assert.equal(first.wakeActions, "Sent", `${where}: a delivered wake turn offers nothing (${first.wakeActions})`);
      assert.equal(first.sideways, false, `${where}: nothing scrolls sideways`);
      await shot("chat");
      await clip(".composer-hint", "strip");
      await clip('.tool:has(.tool-state.is-background)', "card");
      await clip('.wrap-up-note[data-mark="job"]', "wake");

      // The worker's row. Beside the chat on a desktop; on a phone, behind
      // the action bar's Tasks.
      if (!(await page.locator(".run-row-note[data-job]").first().isVisible().catch(() => false))) {
        await page.getByRole("button", { name: /^Tasks/ }).first().click();
      }
      await page.locator(".run-row-note[data-job]").first().waitFor();
      const row = await read(page);
      assert.equal(row.rowNote, "Encoding · 60%", `${where}: run row says ${row.rowNote}`);
      await clip(".orch-task.run-row", "run-row");
      await shot("run-panel");
      if (size.phone) {
        // A phone draws the run in the chat's place; its own Chat tab goes back.
        await page.locator('button:text-is("Chat"), [role="tab"]:text-is("Chat")').first().click();
        await page.waitForFunction(() => [...document.querySelectorAll(".composer-hint .job-percent")].some((el) => el.checkVisibility()));
      }

      // The job moves: the strip and the card follow its own numbers.
      send("chat-job", { chatKey: "chat:main", job: { ...jobs.render, phase: "Muxing", done: 165, total: 300, elapsedMs: 120_000 } });
      await page.waitForFunction(() => document.querySelector(".composer-hint .job-percent")?.textContent === "55%");
      const moved = await read(page);
      assert.match(moved.strip, /^Render mp4 · Muxing · 55%$/, `${where}: moved strip says ${moved.strip}`);
      assert.deepEqual(moved.chips, ["in background · 55%"], `${where}: card moved`);

      // A job that has said nothing for ten minutes is muted grey.
      send("chat-job", { chatKey: "chat:main", job: { ...jobs.render, phase: "Muxing", done: 165, total: 300, elapsedMs: 800_000, sinceUpdateMs: 11 * 60_000 } });
      await page.waitForFunction(() => !!document.querySelector('.composer-hint .job-progress[data-stale]'));
      const stale = await read(page);
      assert.notEqual(stale.fillColor, moved.fillColor, `${where}: stale fill is not the in-flight fill`);
      await clip(".composer-hint", "strip-stale");

      // It ends: off the strip and off the card.
      send("chat-job", { chatKey: "chat:main", job: { ...jobs.render, status: "done", exitCode: 0, done: 300, total: 300, elapsedMs: 900_000 } });
      await page.waitForFunction(() => !document.querySelector(".composer-hint .job-percent"));
      const ended = await read(page);
      assert.deepEqual(ended.chips, [], `${where}: no card marked once it ended`);
      await clip(".composer-hint", "strip-ended");

      report.scenes[where] = { first, row: row.rowNote, moved: moved.strip, stale: stale.strip, ended: ended.strip };
      await context.close();
    }
  }
  assert.deepEqual(errors, [], "no page errors");
  report.passed = true;
} catch (error) {
  report.error = String(error.stack || error);
  process.exitCode = 1;
  if (current) await current.page.screenshot({ path: join(artifacts, `${current.at}-failed.png`) }).catch(() => {});
} finally {
  report.errors = errors;
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
  await server.close();
}
