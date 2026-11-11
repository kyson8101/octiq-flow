// Real App and CSS, fixture socket only. No filesystem cleanup or paid calls.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node web/scripts/test-workspace-cleanup.mjs
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const webRoot = resolve(process.env.OCTIQ_WEB_ROOT || fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(join(webRoot, "package.json"));
const moduleUrl = (spec) => isAbsolute(spec) || spec.startsWith(".") ? pathToFileURL(resolve(spec)).href : spec;
const { createServer } = await import(moduleUrl(require.resolve("vite")));
const { chromium } = await import(moduleUrl(process.env.PLAYWRIGHT_MODULE || "playwright"));
const artifacts = process.env.OCTIQ_EVIDENCE_DIR || await mkdtemp(join(tmpdir(), "octiq-cleanup-card-"));
await mkdir(artifacts, { recursive: true });
const root = "/fixture/octiq-flow";
const now = Date.now();
const chats = ["coordinator", "other"].map((id) => ({ id, projectId: "octiq", title: id, customTitle: true,
  modelId: "codex:gpt-6.1-sol", access: "full", effort: "high", sessionId: `session-${id}`, cwd: root,
  createdAt: now - 500_000, updatedAt: now - 1000,
}));
const snapshot = { runs: [], tasks: [], attempts: [], gates: [], messages: [], notifications: [] };
const item = (i) => ({ id: `item-${i}`, kind: "task-worktree", title: `Finished task ${i} ${"whole title ".repeat(8)}`,
  runId: "finished-run", taskId: `t${i}`, worktrees: [{ branch: `feature/task-${i}`, path: `${root}/${"long-directory/".repeat(5)}task-${i}`,
    headCommit: `${String(i).padStart(40, "a")}`, baseBranch: "develop", ignoredFileCount: 0 }] });
const batch = { id: "batch-1", chatKey: "chat:coordinator", runIds: ["finished-run"], processing: false,
  items: [...Array.from({ length: 34 }, (_, i) => item(i)), { ...item(34), kind: "mission", title: "Finished mission",
    worktrees: [item(34).worktrees[0], { ...item(35).worktrees[0], ignoredFileCount: null }, { ...item(36).worktrees[0], ignoredFileCount: 7 }] },
  { ...item(37), kind: "mission", title: "Empty mission record", worktrees: [] }],
};
const pendingCommand = "orchestration_workspace_cleanup_request_pending";
const answerCommand = "orchestration_workspace_cleanup_request_answer";
const errors = [];
let server, browser;

function resultFor(request) {
  switch (request.cmd) {
    case "list_workspaces": return [{ id: "octiq", name: "octiq-flow", primary_path: root }];
    case "chat_index_list": return chats;
    case "chat_page": return { events: [], context: [], before: null };
    case "chat_queue_state": return { live: false, queuedTurnIds: [] };
    case "orchestration_snapshot": return snapshot;
    case "team_head": return null;
    case "team_home": return "octiq";
    case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
    case "usage_summary": return {};
    case "agent_models": return { source: "mock", models: [] };
    case "agent_installs": return [{ id: "codex", installed: true, path: "/mock/codex" }];
    case "pr_local_list": case "pr_remote_list": return { items: [], warnings: [] };
    case "agent_avatar_status": return { available: false, reason: "Fixture." };
    case "git_status_summary": return [{ path: root, repo_root: root, is_repo: true, branch: "develop", changed: 0, ahead: 0, behind: 0 }];
    case "git_local_branches": return { is_repo: true, current: "develop", branches: ["develop"], is_worktree: false };
    case "chat_task": return { chatId: request.args?.chatId, projectId: "octiq" };
    default: return [];
  }
}

try {
  server = await createServer({ root: webRoot, configFile: join(webRoot, "vite.config.ts"),
    cacheDir: join(artifacts, ".vite"), server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : { channel: "chrome" }) });
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    const commands = [];
    const answers = [];
    let socket, pending = [batch], heldAnswer;
    const reply = (request, result) => socket.send(JSON.stringify({ t: "reply", id: request.id, ok: true, result }));
    const emit = (payload) => socket.send(JSON.stringify({ t: "event", event: "orchestration-workspace-cleanup-request", payload }));
    await context.addInitScript((stored) => {
      localStorage.setItem("octiq.agentsMode", "off");
      localStorage.setItem("octiq.v2.gitColumn", "0");
      localStorage.setItem("octiq.v2.conversations", JSON.stringify(stored));
    }, chats.map((chat) => ({ ...chat, messages: [] })));
    await context.route("**/token", (route) => route.fulfill({ body: "fixture-token" }));
    await context.route("**/auth", (route) => route.fulfill({ body: "ok" }));
    await context.routeWebSocket(/.*/, (ws) => {
      socket = ws;
      ws.onMessage((raw) => {
        const request = JSON.parse(String(raw));
        if (request.t !== "invoke") return;
        commands.push(request);
        if (["chat_subscribe", "orchestration_summary", "orchestration_run_detail"].includes(request.cmd)) {
          socket.send(JSON.stringify({ t: "reply", id: request.id, ok: false, error: `'${request.cmd}' is not available on this backend` }));
        } else if (request.cmd === answerCommand) {
          answers.push(request); heldAnswer = request;
        } else reply(request, request.cmd === pendingCommand ? pending : resultFor(request));
      });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/#/p/octiq-flow/c/coordinator`, { waitUntil: "domcontentloaded", timeout: 180_000 });
    let card = page.locator('.workspace-cleanup-card:not(.is-settled)');
    await card.waitFor();
    assert.equal(commands.filter((c) => c.cmd === pendingCommand).length, 1, "one reader on connect");
    assert.equal(await card.getByRole("button", { name: "Show worktrees to remove" }).getAttribute("aria-expanded"), "false");
    assert.equal(await card.locator(".cleanup-item").count(), 0, "details start folded");
    if (width === 1280) assert.ok((await page.locator("body").innerText()).includes("Cleanup approval"), "chat row uses the shared pending reading");
    assert.equal(await card.locator("..").getAttribute("data-pending-keys"), "cleanup:batch-1");
    assert.ok((await card.innerText()).includes("Remove 37 finished worktrees and close 2 missions?"));
    await page.screenshot({ path: join(artifacts, `cleanup-folded-${width}.png`), fullPage: true });

    // A held Enter that opened the disclosure cannot answer after focus moves.
    const disclosure = card.getByRole("button", { name: "Show worktrees to remove" });
    await disclosure.focus();
    await page.keyboard.down("Enter");
    await card.locator(".cleanup-item").last().waitFor();
    const remove = card.getByRole("button", { name: "Remove all", exact: true });
    await remove.focus();
    await page.keyboard.down("Enter");
    await page.keyboard.up("Enter");
    assert.equal(answers.length, 0, "held Enter does not decide");
    assert.equal(await card.locator(".cleanup-item").count(), 36);
    assert.ok((await card.innerText()).includes("Unknown"));
    assert.ok((await card.innerText()).includes("7 ignored files at stake"));
    assert.ok((await card.innerText()).includes("close the mission record only"));
    const geometry = await card.evaluate((el) => {
      const box = el.querySelector(".card-fold-in"); box.scrollTop = box.scrollHeight;
      const last = box.querySelector(".cleanup-item:last-child").getBoundingClientRect();
      const bounds = box.getBoundingClientRect();
      return { scrolls: box.scrollHeight > box.clientHeight, lastReachable: last.bottom <= bounds.bottom + 1,
        fits: el.scrollWidth <= el.clientWidth && document.documentElement.scrollWidth <= innerWidth };
    });
    assert.deepEqual(geometry, { scrolls: true, lastReachable: true, fits: true });
    await page.screenshot({ path: join(artifacts, `cleanup-open-${width}.png`), fullPage: true });

    // Remember the disclosure press, then send its repeated spot onto Remove all.
    await card.evaluate((el) => {
      const toggle = el.querySelector('.card-fold-toggle');
      const point = toggle.getBoundingClientRect();
      const press = { bubbles: true, clientX: point.x + point.width / 2, clientY: point.y + point.height / 2 };
      toggle.dispatchEvent(new MouseEvent("click", { ...press, detail: 1 }));
      el.querySelector('.ask-btn.is-primary').dispatchEvent(new MouseEvent("click", { ...press, detail: 2 }));
    });
    assert.equal(answers.length, 0, "a repeated disclosure press is not approval");
    // Two deliberate keyboard clicks in one frame: lib/inFlight sends once.
    await remove.evaluate((button) => { button.click(); button.click(); });
    await page.waitForFunction(() => document.querySelector('.workspace-cleanup-card .ask-btn.is-primary')?.disabled);
    assert.equal(answers.length, 1);
    assert.deepEqual(answers[0].args, { id: batch.id, approve: true });
    assert.equal(await card.locator(".ask-btn:disabled").count(), 2);
    // The same request remains off after the card is unmounted and redrawn.
    await page.evaluate(() => { location.hash = "#/p/octiq-flow/c/other"; });
    await card.waitFor({ state: "detached" });
    await page.evaluate(() => { location.hash = "#/p/octiq-flow/c/coordinator"; });
    await card.waitFor();
    assert.equal(await card.locator(".ask-btn:disabled").count(), 2);
    assert.equal(answers.length, 1);
    const result = { id: batch.id, approved: true, items: batch.items.map((entry, i) => ({ id: entry.id,
      status: i === 34 ? "kept" : "removed", reason: i === 34 ? "HEAD changed; every root was kept." : `Removed safely ${i}.` })) };
    pending = [];
    emit({ state: "settled", id: batch.id, chatKey: batch.chatKey, result });
    reply(heldAnswer, result);
    const settled = page.locator(".workspace-cleanup-card.is-settled");
    await settled.waitFor();
    assert.ok((await settled.innerText()).includes("35 removed · 1 kept"));
    assert.equal(await settled.locator(".cleanup-item").count(), 0, "result folds to a quiet line");
    await settled.getByRole("button", { name: "Show cleanup results" }).click();
    assert.equal(await settled.locator(".cleanup-item").count(), 36);
    assert.ok((await settled.innerText()).includes("HEAD changed; every root was kept."));
    assert.ok((await settled.innerText()).includes("Removed safely 35."));

    // New host event, safe answer, and denial results: no removal claim.
    const deny = { ...batch, id: "batch-deny", items: [item(100)] };
    pending = [deny];
    emit({ state: "appeared", id: deny.id, request: deny });
    await card.waitFor();
    await card.getByRole("button", { name: "Keep them", exact: true }).click();
    await card.locator(".ask-btn:disabled").first().waitFor();
    assert.equal(answers.length, 2);
    assert.deepEqual(answers[1].args, { id: deny.id, approve: false });
    const denied = { id: deny.id, approved: false, items: [{ id: deny.items[0].id, status: "kept", reason: "The person chose to keep it." }] };
    reply(heldAnswer, denied); // RPC alone must settle too, even without an event.
    await page.getByText("Nothing removed · kept them all", { exact: true }).waitFor();
    await page.screenshot({ path: join(artifacts, `cleanup-${width}.png`), fullPage: true });
    assert.equal(commands.filter((c) => c.cmd === pendingCommand).length, 1, "chat changes do not create another reader");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, folded: true, allItemsReachable: true, oneReader: true, answers: answers.map((r) => r.args), heldEnterDropped: true, strayPressDropped: true, remountHeld: true, artifacts }));
    await context.close();
  }
} finally {
  await browser?.close();
  await server?.close();
}
