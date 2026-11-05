// Real App and CSS with a mocked socket; never starts a host or sweeps a folder.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs PLAYWRIGHT_CHANNEL=chrome node scripts/test-worktree-lifespan.mjs
// OCTIQ_LIFESPAN_CHECK=flight OCTIQ_LIFESPAN_MUTATION=flight runs a negative control.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const webRoot = resolve(process.env.OCTIQ_WEB_ROOT || fileURLToPath(new URL("../web", import.meta.url)));
const require = createRequire(join(webRoot, "package.json"));
const { createServer } = await import(pathToFileURL(require.resolve("vite")).href);
const pw = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = await import(isAbsolute(pw) ? pathToFileURL(pw).href : pw);
const check = process.env.OCTIQ_LIFESPAN_CHECK || "all";
const mutation = process.env.OCTIQ_LIFESPAN_MUTATION || "";
const themes = process.env.OCTIQ_LIFESPAN_THEMES?.split(",") || ["dark", "light", "fun", "manga", "guofeng", "xp", "cyberpunk"];
const checks = ["layout", "flight", "repeat", "refusal", "ignored", "older", "flow"];
assert.ok(check === "all" || checks.includes(check), `Unknown check: ${check}`);
assert.ok(!mutation || checks.includes(mutation), `Unknown mutation: ${mutation}`);
const evidence = process.env.OCTIQ_EVIDENCE_DIR || await mkdtemp(join(tmpdir(), "octiq-worktree-lifespan-"));
const calls = [], errors = [], results = [];
let server, browser;
let mutations = 0;
const now = 1793860000000;
const owner = label => ({ kind: "task", label, runId: "run", taskId: label });
const item = (key, patch = {}) => ({ key, path: `/work/very-long-project-name/.worktrees/${key}/deep-folder`, repo: "/work/very-long-project-name", branch: `feature/${key}`, head: `head-${key}`, statusHash: `status-${key}`, owner: owner(key), state: "finished", pinned: false, idleDays: 15, bytes: 4200000000, buildBytes: 2100000000, dirtyFiles: 0, untrackedFiles: 0, ignoredFiles: 0, ignoredBytes: 0, unmergedCommits: 0, pushed: null, stripAt: now + 86400000, removeAt: now + 7 * 86400000, why: "The host confirmed this task has finished. " + "Whole reason. ".repeat(15), ...patch });
function fixture() {
  return { settings: { enabled: true, buildAfterDays: 3, removeAfterDays: 14 }, lastSweepAt: now, scanning: true,
    items: [item("abandoned", { state: "abandoned", dirtyFiles: 3, untrackedFiles: 2, unmergedCommits: 1, pushed: false, stripAt: null, removeAt: null }), item("finished"), item("idle", { state: "idle", stripAt: now + 1000 }), item("kept", { pinned: true }), item("active", { state: "active" }), item("unknown", { state: "abandoned", owner: { kind: "unknown", label: "Unknown ownership" }, bytes: null, buildBytes: null })],
    archives: [{ key: "archive", ref: "refs/octiq/archive/previous", repo: "/work/project", branch: "feature/previous", path: "/work/project/.worktrees/previous", archivedAt: now, files: 2, restoredAt: null }],
    history: [{ at: now, stripped: 2, removed: [{ path: "/removed/" + "whole-path/".repeat(20), branch: "feature/removed", owner: owner("Old work"), bytes: null }], freedBytes: 3700000000, failed: [{ path: "/failed/" + "whole-path/".repeat(20), why: "Host refusal: open files " + "reason stays whole. ".repeat(20) }] }] };
}
function resultFor(cmd) {
  switch (cmd) {
    case "list_workspaces": return [{ id: "octiq", name: "octiq-flow", primary_path: "/work/project" }];
    case "chat_index_list": case "chat_index_deleted": case "chat_since": case "permission_pending": case "question_pending": case "chat_list": case "chat_activity": case "safety_block_pending": case "access_request_pending": case "pr_repositories": case "codex_skills": case "team_list": case "team_leads": case "git_status_summary": case "agent_installs": return [];
    case "chat_page": return { events: [], context: [], before: null };
    case "chat_queue_state": return { live: false, queuedTurnIds: [] };
    case "orchestration_snapshot": return { runs: [], tasks: [], attempts: [], gates: [], messages: [], notifications: [] };
    case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
    case "usage_summary": return {};
    case "agent_models": return { source: "mock", models: [] };
    case "pr_local_list": case "pr_remote_list": return { items: [], warnings: [] };
    case "disk_scan_state": return { running: null, report: null };
    default: return null;
  }
}
function mutate(code, id) {
  let next = code;
  if (mutation === "layout" && id.includes("WorktreeLifespan.css")) next = code.replace(".worktree-lifespan { min-width: 0;", ".worktree-lifespan { min-width: 1800px;");
  if (mutation === "flight" && /\/inFlight.ts(?:\?|$)/.test(id)) next = code.replaceAll("out.has(key)", "false");
  if (mutation === "repeat" && id.includes("WorktreeLifespan.tsx")) next = code.replace("if (repeatsAnother(event)) return;", "/* negative control: no repeat guard */");
  if (mutation === "refusal" && id.includes("WorktreeLifespan.tsx")) next = code.replace("[key]: words(reason)", "[key]: 'Hidden host refusal'");
  if (mutation === "older" && id.includes("worktreeLifespan.ts") && !id.includes(".tsx")) next = code.replace("export const lifespanUnavailable = (message: string) =>", "export const lifespanUnavailable = (_message: string) => false &&");
  if (mutation === "flow" && id.includes("WorktreeLifespan.tsx")) next = code.replace('"worktree-lifespan-changed", () => void reload()', '"worktree-lifespan-changed", () => {}');
  if (mutation === "ignored" && id.includes("worktreeLifespan.ts") && !id.includes(".tsx")) next = code.replace("will be deleted and", "will be archived and");
  if (next !== code) { mutations++; return next; }
}
async function open(width, theme) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
  await context.addInitScript(mode => {
    localStorage.setItem("octiq.theme", mode); localStorage.setItem("octiq.web.token", "fixture");
    localStorage.setItem("octiq.v2.gitColumn", "0"); localStorage.setItem("octiq.v2.navShut", "0");
  }, theme);
  const data = fixture(), localCalls = [], held = [];
  let hold = false, old = false, socket, rejectArchive = true;
  const event = (name = "worktree-lifespan-changed", payload = {}) => socket.send(JSON.stringify({ t: "event", event: name, payload }));
  const reply = (request, result, error) => socket.send(JSON.stringify({ t: "reply", id: request.id, ok: !error, ...(error ? { error } : { result }) }));
  const answer = request => {
    const { cmd, args } = request;
    if (cmd.startsWith("worktree_lifespan_") && old) return reply(request, null, `'${cmd}' is not available on this backend — it may be older than the page asking for it`);
    if (cmd === "worktree_lifespan_list") return reply(request, data);
    if (cmd === "worktree_lifespan_keep") {
      if (hold) { held.push(request); return; }
      data.items.find(item => item.key === args.key).pinned = args.keep;
      reply(request, null); event(); return;
    }
    if (cmd === "worktree_lifespan_archive") {
      if (data.items.find(item => item.key === args.key)?.ignoredFiles == null) return reply(request, null, "Host could not check for ignored files; archive refused.");
      if (rejectArchive) return reply(request, null, "Host refused: worktree changed since it was drawn.");
      const index = data.items.findIndex(item => item.key === args.key);
      data.items.splice(index, 1); reply(request, data.archives[0]); event(); return;
    }
    if (cmd === "worktree_lifespan_restore") {
      data.archives[0].restoredAt = now + 1;
      reply(request, { path: "/restored/new-worktree-path", branch: "feature/restored-new-branch" }); event(); return;
    }
    if (cmd === "worktree_lifespan_set") { data.settings = args; reply(request, null); event(); return; }
    reply(request, resultFor(cmd));
  };
  await context.route("**/token", route => route.fulfill({ body: "fixture" }));
  await context.route("**/auth", route => route.fulfill({ body: "ok" }));
  await context.routeWebSocket(/\/ws\?token=/, ws => { socket = ws; ws.onMessage(raw => { const request = JSON.parse(String(raw)); if (request.t !== "invoke") return; localCalls.push(request); calls.push({ width, theme, ...request }); answer(request); }); });
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on("pageerror", error => errors.push(String(error.stack ?? error)));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`, { waitUntil: "domcontentloaded", timeout: 180000 });
  const disk = page.getByRole("button", { name: "Disk", exact: true });
  if (!await disk.isVisible()) await page.getByRole("button", { name: /Show chats|Show sidebar/ }).first().click();
  await disk.click();
  await page.getByRole("region", { name: "Worktrees", exact: true }).waitFor();
  await page.getByRole("article", { name: "abandoned", exact: true }).waitFor();
  return { page, context, data, localCalls, event, hold: value => { hold = value; }, held, release: () => { hold = false; held.splice(0).forEach(answer); }, older: () => { old = true; event(); }, allowArchive: () => { rejectArchive = false; } };
}
const row = (page, name) => page.getByRole("article", { name, exact: true });
const keyClick = async locator => { await locator.focus(); await locator.press("Enter"); };
async function layout(app, width, theme) {
  const { page, data } = app;
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.locator(".wt-group").evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label")).join("|")), "Needs you|Waiting to clear|Kept|In use|Archived");
  assert.equal(await page.getByRole("region", { name: "Waiting to clear", exact: true }).getByRole("article").evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label")).join("|")), "idle|finished");
  assert.equal(await row(page, "Unknown ownership").getByRole("button", { name: /Keep|Archive and remove/ }).count(), 0);
  assert.match(await row(page, "Unknown ownership").textContent(), /OctiqFlow leaves it alone/);
  assert.match(await row(page, "abandoned").textContent(), /3 changed · 2 new files · 1 commit not merged · Not pushed/);
  assert.equal(await page.getByRole("heading", { name: /Worktrees · 6/ }).textContent(), "Worktrees · 6", "An unknown size must omit the total");
  await keyClick(row(page, "Unknown ownership").getByRole("button", { name: "Show details for Unknown ownership" }));
  assert.doesNotMatch(await row(page, "Unknown ownership").textContent(), /Build output|Pushed|Not pushed|0 changed|0 new|0 commits|null|undefined/);
  assert.equal(await row(page, "finished").getByText(data.items[1].path, { exact: true }).count(), 0, "Path starts folded");
  await keyClick(row(page, "finished").getByRole("button", { name: "Show details for finished" }));
  assert.equal(await row(page, "finished").getByText(data.items[1].path, { exact: true }).textContent(), data.items[1].path);
  await keyClick(page.getByRole("button", { name: "Show past sweeps", exact: true }));
  assert.equal(await page.getByText(data.history[0].removed[0].path, { exact: true }).textContent(), data.history[0].removed[0].path);
  assert.equal(await page.getByText(data.history[0].failed[0].why, { exact: false }).count(), 1);
  assert.equal(await page.locator(".disk-page").evaluate(el => el.scrollWidth > el.clientWidth + 1 || el.querySelector(".disk-body").scrollWidth > el.querySelector(".disk-body").clientWidth + 1 || document.documentElement.scrollWidth > innerWidth), false, "No horizontal scroll, including long open paths and failures");
  await page.locator(".disk-body").evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: join(evidence, `${theme}-${width}.png`) });
}
async function flight(app) {
  const { page, data, localCalls } = app;
  app.hold(true);
  const button = () => row(page, "finished").getByRole("button", { name: "Keep", exact: true });
  await keyClick(button());
  assert.equal(await button().isDisabled(), true, "Initial request is held");
  const saved = data.items.find(item => item.key === "finished");
  data.items = data.items.filter(item => item.key !== "finished"); app.event();
  await row(page, "finished").waitFor({ state: "detached" });
  data.items.push(saved); app.event(); await row(page, "finished").waitFor();
  assert.equal(await button().isDisabled(), true, "Held worktree request survives row removal and remount");
  await button().evaluate(el => { el.click(); el.click(); });
  assert.equal(localCalls.filter(call => call.cmd === "worktree_lifespan_keep").length, 1, "One keep request while held");
  await keyClick(page.getByRole("button", { name: "Back to Chat", exact: true }));
  const disk = page.getByRole("button", { name: "Disk", exact: true });
  if (!await disk.isVisible()) await keyClick(page.getByRole("button", { name: /Show chats|Show sidebar/ }).first());
  await keyClick(disk);
  await row(page, "finished").waitFor();
  assert.equal(await button().isDisabled(), true, "Held request survives the whole Disk page remount");
  app.release();
  await row(page, "finished").getByRole("button", { name: "Stop keeping", exact: true }).waitFor();
}
async function repeat(app) {
  const { page, localCalls } = app;
  const button = row(page, "idle").getByRole("button", { name: "Keep", exact: true });
  const before = localCalls.filter(call => call.cmd === "worktree_lifespan_keep").length;
  const dropped = await button.evaluate(el => {
    const prior = document.querySelector(".wt-head h2");
    // Capture knows the real previous target. The same spot now reaches an answer.
    prior.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1, clientX: 17, clientY: 19 }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2, clientX: 17, clientY: 19 }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 3, clientX: 17, clientY: 19 }));
    const held = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", repeat: true });
    return !el.dispatchEvent(held);
  });
  assert.equal(dropped, true, "Held Enter is prevented");
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(localCalls.filter(call => call.cmd === "worktree_lifespan_keep").length, before, "Repeated pointer press is dropped");
  await keyClick(button);
  await row(page, "idle").getByRole("button", { name: "Stop keeping", exact: true }).waitFor();
}
async function refusal(app) {
  const { page, data, localCalls } = app;
  const archive = () => row(page, "abandoned").getByRole("button", { name: "Archive and remove", exact: true });
  await keyClick(archive());
  const dialog = page.getByRole("alertdialog"); await dialog.waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Keep worktree" }).evaluate(el => el === document.activeElement), true);
  await page.keyboard.press("Enter"); await dialog.waitFor({ state: "detached" });
  assert.equal(localCalls.filter(call => call.cmd === "worktree_lifespan_archive").length, 0, "Second Enter cancels");
  await keyClick(archive()); await dialog.waitFor();
  assert.match(await dialog.textContent(), /3 changed · 2 new files/);
  assert.match(await dialog.textContent(), /Ignored files are not kept/);
  const before = localCalls.filter(call => call.cmd === "worktree_lifespan_list").length;
  // The displayed row's tokens are captured before a newer host list arrives.
  const snapshot = { head: data.items[0].head, hash: data.items[0].statusHash };
  data.items[0].head = "new-head"; data.items[0].statusHash = "new-status"; data.items[0].dirtyFiles = 4; app.event();
  await row(page, "abandoned").getByText(/4 changed/).waitFor();
  await page.keyboard.press("Tab"); await page.keyboard.press("Enter");
  await row(page, "abandoned").getByRole("alert").waitFor();
  assert.equal(await row(page, "abandoned").getByRole("alert").textContent(), "Host refused: worktree changed since it was drawn.", "Refusal preserves host words");
  assert.deepEqual(localCalls.find(call => call.cmd === "worktree_lifespan_archive").args, { key: "abandoned", expectedHead: snapshot.head, expectedStatusHash: snapshot.hash });
  assert.ok(localCalls.filter(call => call.cmd === "worktree_lifespan_list").length > before, "Archive refusal refetches");
  await archive().waitFor();
}
async function older(app) {
  const { page } = app;
  app.older();
  await page.getByText("Worktree lifespan is not available on this backend.", { exact: true }).waitFor();
  await page.getByText("Development leftovers", { exact: true }).waitFor();
  assert.equal(await page.locator(".worktree-lifespan [role=alert]").count(), 0, "Older backend is quiet");
  assert.equal(await page.getByRole("button", { name: "Scan", exact: true }).isEnabled(), true, "Manual Disk scan remains usable");
  await keyClick(page.getByRole("button", { name: "Back to Chat", exact: true }));
  const disk = page.getByRole("button", { name: "Disk", exact: true });
  if (!await disk.isVisible()) await keyClick(page.getByRole("button", { name: /Show chats|Show sidebar/ }).first());
  await keyClick(disk);
  await page.getByText("Worktree lifespan is not available on this backend.", { exact: true }).waitFor();
  assert.equal(await page.locator(".worktree-lifespan [role=alert]").count(), 0, "An older backend is quiet on the first read too");
}
async function ignored(app) {
  const { page, data, localCalls } = app;
  const abandoned = data.items.find(item => item.key === "abandoned");
  const archive = () => row(page, "abandoned").getByRole("button", { name: "Archive and remove", exact: true });
  const dialog = page.getByRole("alertdialog");
  const before = localCalls.filter(call => call.cmd === "worktree_lifespan_archive").length;
  Object.assign(abandoned, { ignoredFiles: 2, ignoredBytes: 1200000000 }); app.event();
  await row(page, "abandoned").getByText(/2 ignored files \(1.2 GB\)/).waitFor();
  await keyClick(archive()); await dialog.waitFor();
  assert.match(await dialog.locator(".ask-body").textContent(), /^2 ignored files \(1.2 GB\) will be deleted and are not in the archive\./, "Ignored files warning names deletion outside the archive");
  await page.screenshot({ path: join(evidence, `ignored-${page.viewportSize().width}.png`) });
  await page.keyboard.press("Escape"); await dialog.waitFor({ state: "detached" });
  abandoned.ignoredBytes = null; app.event();
  await page.waitForFunction(() => !document.querySelector('[aria-label="abandoned"]')?.textContent.includes("1.2 GB"));
  await keyClick(archive()); await dialog.waitFor();
  assert.match(await dialog.locator(".ask-body").textContent(), /^2 ignored files will be deleted and are not in the archive\./);
  await page.keyboard.press("Escape"); await dialog.waitFor({ state: "detached" });
  abandoned.ignoredFiles = null; app.event();
  await row(page, "abandoned").getByText("The host could not check for ignored files. Archive and remove is unavailable.", { exact: true }).waitFor();
  assert.equal(await archive().count(), 0, "Unknown ignored-file count offers no archive action");
  assert.equal(await row(page, "abandoned").getByRole("button", { name: "Keep", exact: true }).isEnabled(), true);
  assert.doesNotMatch(await row(page, "abandoned").textContent(), /0 ignored|No ignored|null|undefined/);
  abandoned.ignoredFiles = 0; abandoned.ignoredBytes = 0; app.event(); await archive().waitFor();
  await keyClick(archive()); await dialog.waitFor();
  assert.match(await dialog.locator(".ask-body").textContent(), /The archive keeps tracked changes and new files before removing this worktree\. Ignored files are not kept\.$/);
  assert.doesNotMatch(await dialog.locator(".ask-body").textContent(), /will be deleted|could not check/);
  await page.keyboard.press("Escape"); await dialog.waitFor({ state: "detached" });
  assert.equal(localCalls.filter(call => call.cmd === "worktree_lifespan_archive").length, before, "Review and cancellation do not send deletion");
}
async function flow(app) {
  const { page, data, localCalls } = app;
  const before = localCalls.filter(call => call.cmd === "worktree_lifespan_list").length;
  data.scanning = false; data.items = data.items.filter(item => item.key !== "active"); app.event();
  await row(page, "active").waitFor({ state: "detached" });
  assert.ok(localCalls.filter(call => call.cmd === "worktree_lifespan_list").length > before, "Change event refetches");
  const swept = localCalls.filter(call => call.cmd === "worktree_lifespan_list").length;
  data.history[0].freedBytes = 8000000000; app.event("worktree-swept", data.history[0]);
  await page.getByText(/Last sweep removed 1 and freed 8 GB/).waitFor();
  assert.ok(localCalls.filter(call => call.cmd === "worktree_lifespan_list").length > swept, "Sweep event refetches");
  const build = page.getByRole("spinbutton", { name: "Build output idle days" });
  await build.fill("20");
  await page.getByText("Build output must clear no later than folders.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Save settings" }).isDisabled(), true);
  await build.fill("4"); await keyClick(page.getByRole("button", { name: "Save settings" }));
  await page.waitForFunction(() => document.querySelector('.wt-settings button')?.disabled);
  assert.deepEqual(localCalls.find(call => call.cmd === "worktree_lifespan_set").args, { enabled: true, buildAfterDays: 4, removeAfterDays: 14 });
  await keyClick(page.getByRole("button", { name: "Restore", exact: true }));
  await page.getByText("/restored/new-worktree-path", { exact: true }).waitFor();
  assert.match(await page.getByRole("article", { name: "Archive feature/previous", exact: true }).textContent(), /feature\/restored-new-branch/);
  app.allowArchive();
  await keyClick(row(page, "abandoned").getByRole("button", { name: "Archive and remove" }));
  await page.getByRole("alertdialog").waitFor(); await page.keyboard.press("Tab"); await page.keyboard.press("Enter");
  await row(page, "abandoned").waitFor({ state: "detached" });
}
try {
  await mkdir(evidence, { recursive: true });
  server = await createServer({ root: webRoot, configFile: join(webRoot, "vite.config.ts"), plugins: [{ name: "lifespan-negative-control", enforce: "pre", transform: mutate }], server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  for (const theme of themes) for (const width of [1280, 390]) {
    const app = await open(width, theme);
    try {
      for (const name of checks) if ((check === "all" || check === name) && (name === "layout" || theme === themes[0])) {
        await ({ layout, flight, repeat, refusal, ignored, older, flow })[name](app, width, theme);
        results.push({ width, theme, check: name, passed: true });
        // Older host replaces this section; no later actions in that context.
        if (name === "older" && check === "all") break;
      }
    } finally { await app.context.close(); }
    console.log(`PASS ${theme} ${width}: ${check}`);
  }
  // Run full success flow separately from the older-host context.
  if (check === "all") for (const width of [1280, 390]) {
    const app = await open(width, themes[0]);
    try { await flow(app); results.push({ width, theme: themes[0], check: "flow", passed: true }); } finally { await app.context.close(); }
  }
  assert.deepEqual(errors, [], "No page errors");
  if (mutation) assert.ok(mutations > 0, "Negative control must change source");
  await writeFile(join(evidence, "results.json"), JSON.stringify({ results, calls, errors, mutation, mutations }, null, 2));
  console.log(`Evidence: ${evidence}`);
} finally {
  try { await browser?.close(); } finally { await server?.close(); }
}
