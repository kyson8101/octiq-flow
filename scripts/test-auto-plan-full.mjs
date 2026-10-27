// Real App, its normal entry point, CSS and WebSocket bridge; only host replies
// are stubbed. Host recordings are cloned for display identities and long lists.
// No live profile writes, model calls, production build or lasting service.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserPaths } from "./browser-paths.mjs";
const { webRoot, require, moduleUrl } = browserPaths(import.meta.url);
const { createServer } = await import(moduleUrl(require.resolve("vite")));
const { chromium } = await import(moduleUrl(process.env.PLAYWRIGHT_MODULE || "playwright"));
const artifacts = process.env.OCTIQ_EVIDENCE_DIR || await mkdtemp(join(tmpdir(), "octiq-auto-plan-full-"));
const facts = {};
for (const name of ["held_access", "full_peer_request"]) {
  facts[name] = JSON.parse(await readFile(join(webRoot, `src/lib/__fixtures__/host/auto_plan_${name}.json`), "utf8"));
}
const server = await createServer({ root: webRoot, configFile: join(webRoot, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, strictPort: false } });
const report = { artifacts, checks: [] };
const errors = [];
let browser;
async function scene(width, kind = "access") {
  const snapshot = structuredClone(facts[kind === "peer" ? "full_peer_request" : "held_access"]);
  const run = snapshot.runs[0];
  run.coordinatorChatKey = "chat:main";
  run.workspaceId = "qa";
  // Display-only changes: readable titles/assignees rather than scratch paths.
  for (const task of snapshot.tasks) task.assignee = { id: "video", name: "STAR VIDEO" };
  if (kind === "long") {
    const first = snapshot.tasks[0];
    first.title = "Prepare the complete Full access shot list with all character and camera details";
    for (let i = 1; i < 9; i++) snapshot.tasks.push({ ...first, id: `task-long-${i}`, title: `Verify every frame and transition for sequence ${i}`, assignee: { id: "qa", name: "STAR QA" } });
    run.autoPlan.held.taskIds = snapshot.tasks.map(task => task.id);
  }
  const now = Date.now();
  const chat = { id: "main", projectId: "qa", title: "Full access plan approval", customTitle: true,
    modelId: "claude:opus", access: "full", sessionId: "qa-main", cwd: "/test", coordinatesRun: true,
    createdAt: now - 10000, updatedAt: now - 1000 };
  const state = { setting: { chatKey: "chat:main", enabled: true, includeFull: kind === "peer", enabledAt: 1 },
    calls: [], sockets: new Set(), holdSave: false, failSave: false, refuseApproval: false, release: null };
  const emit = (event, payload) => { for (const socket of state.sockets) socket.send(JSON.stringify({ t: "event", event, payload })); };
  state.emit = emit;
  state.snapshot = snapshot;
  async function result(request) {
    const args = request.args;
    switch (request.cmd) {
      case "list_workspaces": return [{ id: "qa", name: "Full access QA", primary_path: "/test" }];
      case "chat_index_list": return [chat];
      case "chat_page": return { events: [
        { seq: 1, event: { type: "user", uuid: "qa-user", octiq_user_turn: true, message: { role: "user", content: [{ type: "text", text: "Prepare the plan." }] } } },
        { seq: 2, event: { type: "assistant", message: { id: "qa-answer", role: "assistant", content: [{ type: "text", text: "The Full access tasks are ready for review." }] } } },
      ], context: [], before: null };
      case "chat_queue_state": return { live: false, queuedTurnIds: [] };
      case "orchestration_snapshot": return snapshot;
      case "orchestration_auto_plan_get": return state.setting;
      case "orchestration_auto_plan_set": {
        if (state.holdSave) await new Promise(resolve => { state.release = resolve; });
        if (state.failSave) throw new Error("Could not save Full access consent");
        state.setting = { chatKey: args.chatKey, enabled: args.enabled,
          includeFull: args.enabled && (args.includeFull ?? state.setting.includeFull), enabledAt: 1 };
        emit("orchestration-auto-plan", state.setting);
        return state.setting;
      }
      case "orchestration_plan_approve":
        if (state.refuseApproval) throw new Error("The plan revision changed");
        run.planApproval.status = "approved";
        for (const task of snapshot.tasks) task.heldByPlan = false;
        emit("orchestration-changed", { runId: run.id });
        return {};
      case "chat_task": return { chatId: "main", projectId: "qa" };
      case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
      case "usage_summary": return {};
      case "agent_models": return { source: "mock", models: [] };
      case "agent_installs": return [{ id: "claude", installed: true, path: "/mock/claude" }];
      case "git_local_branches": return { is_repo: true, current: "develop", branches: ["develop"], is_worktree: false };
      default: return [];
    }
  }
  const context = await browser.newContext({ viewport: { width, height: 950 }, reducedMotion: "reduce" });
  await context.addInitScript(() => {
    localStorage.setItem("octiq.agentsMode", "off");
    localStorage.setItem("octiq.v2.gitColumn", "0");
    localStorage.setItem("octiq.v2.terminalOpen", "0");
  });
  await context.route("**/token", route => route.fulfill({ body: "mock-token" }));
  await context.route("**/auth", route => route.fulfill({ body: "ok" }));
  await context.routeWebSocket(/.*/, socket => {
    state.sockets.add(socket);
    socket.onMessage(async raw => {
      const request = JSON.parse(String(raw));
      if (request.t !== "invoke") return;
      state.calls.push(request);
      try { socket.send(JSON.stringify({ t: "reply", id: request.id, ok: true, result: await result(request) })); }
      catch (error) { socket.send(JSON.stringify({ t: "reply", id: request.id, ok: false, error: error.message })); }
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on("pageerror", error => errors.push(error.stack ?? error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/#/p/full-access-qa/c/main`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.locator(".plan-review").first().waitFor({ state: "attached" });
  // A mission opens to its task panel by default. Use its real navigation
  // door to the lead's chat, where the standing-consent tick belongs.
  const mainButton = page.getByRole("button", { name: /Main agent chat/ });
  if (await mainButton.isVisible()) await mainButton.click();
  await page.locator('.chat-plans .plan-review[data-folds="true"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  return { context, page, state };
}
const setCalls = state => state.calls.filter(call => call.cmd === "orchestration_auto_plan_set");
const approveCalls = state => state.calls.filter(call => call.cmd === "orchestration_plan_approve");
const fullName = "Also auto-approve Full access tasks in this chat";
const switchName = "Include Full access tasks";
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  for (const width of [1280, 390]) {
    console.log(`Real App ${width}px`);
    let { context, page, state } = await scene(width);
    const held = page.locator(".chat-plans .auto-plan-held");
    assert.match(await held.innerText(), /Waits for you: 1 task runs at Full access \(STAR VIDEO: Implement\)/);
    assert.equal(await page.locator(".chat-plans .plan-review .card-fold-toggle").getAttribute("aria-expanded"), "false");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(artifacts, `card-${width}.png`) });
    await page.getByRole("button", { name: "Task details", exact: true }).click();
    const fullSwitch = page.getByRole("switch", { name: switchName, exact: true });
    await fullSwitch.waitFor();
    assert.equal(await fullSwitch.getAttribute("aria-checked"), "false");
    await fullSwitch.scrollIntoViewIfNeeded();
    assert.equal(await page.locator(".auto-plan-setting p").evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1 && getComputedStyle(node).whiteSpace === "normal")), true);
    await page.screenshot({ path: join(artifacts, `details-${width}.png`) });
    // Both new switch and checkbox reject a held key and repeated foreign press.
    await fullSwitch.dispatchEvent("keydown", { key: "Enter", repeat: true });
    assert.equal(setCalls(state).length, 0);
    assert.deepEqual(await page.evaluate(() => {
      const other = document.createElement("button"); document.body.append(other);
      const press = () => new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1, clientX: 171, clientY: 151 });
      other.dispatchEvent(press());
      const el = [...document.querySelectorAll('[role="switch"]')].find(el => el.textContent.includes("Include Full"));
      const result = [el.dispatchEvent(press()), el.dispatchEvent(press())]; other.remove(); return result;
    }), [false, false]);
    assert.equal(setCalls(state).length, 0);
    console.log(`${width}: Details controls`);
    state.holdSave = true;
    await fullSwitch.focus(); await page.keyboard.press("Enter");
    await page.waitForFunction(() => [...document.querySelectorAll('[role="switch"]')].every(el => el.getAttribute("aria-disabled") === "true"));
    assert.equal(await fullSwitch.evaluate(el => document.activeElement === el && !el.disabled), true);
    await page.keyboard.press("Enter"); await fullSwitch.dispatchEvent("click", { detail: 0 });
    assert.equal(setCalls(state).length, 1);
    state.holdSave = false; state.release();
    await page.waitForFunction(() => [...document.querySelectorAll('[role="switch"]')].every(el => el.getAttribute("aria-checked") === "true"));
    assert.deepEqual(setCalls(state)[0].args, { chatKey: "chat:main", enabled: true, includeFull: true });
    assert.equal(await fullSwitch.evaluate(el => document.activeElement === el), true);
    // Successful event changes all hook consumers; narrowing sends explicit false.
    await fullSwitch.press("Enter");
    await page.waitForFunction(() => [...document.querySelectorAll('[role="switch"]')].some(el => el.textContent.includes("Include Full") && el.getAttribute("aria-checked") === "false"));
    assert.equal(setCalls(state).at(-1).args.includeFull, false);
    state.failSave = true; await fullSwitch.press("Enter");
    await page.getByRole("alert").filter({ hasText: "Could not save Full access consent" }).waitFor();
    assert.equal(await fullSwitch.getAttribute("aria-checked"), "false");
    state.failSave = false;
    await page.getByRole("switch", { name: "Auto-approve plans", exact: true }).press("Enter");
    await fullSwitch.waitFor({ state: "detached" });
    await page.getByRole("switch", { name: "Auto-approve plans", exact: true }).press("Enter");
    await fullSwitch.waitFor(); assert.equal(await fullSwitch.getAttribute("aria-checked"), "false");
    await context.close();

    console.log(`${width}: Approval and save failure`);
    // Approval commits first; failed future-consent save survives the removed card.
    ({ context, page, state } = await scene(width));
    const checkbox = page.getByRole("checkbox", { name: fullName, exact: true });
    for (const target of ["input", "span"]) {
      assert.deepEqual(await page.evaluate(target => {
        const other = document.createElement("button"); document.body.append(other);
        const press = () => new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1, clientX: 171, clientY: 151 });
        other.dispatchEvent(press());
        const control = document.querySelector(".auto-plan-future " + target);
        const result = [control.dispatchEvent(press()), control.dispatchEvent(press())]; other.remove(); return result;
      }, target), [false, false]);
      assert.equal(await checkbox.isChecked(), false);
    }
    await checkbox.press("Space"); assert.equal(await checkbox.isChecked(), true);
    // A new plan revision and a scope changed in another tab each need a new tick.
    state.snapshot.runs[0].planApproval.revision++;
    state.emit("orchestration-changed", { runId: state.snapshot.runs[0].id });
    await page.locator('.chat-plans .plan-review[data-revision="4"]').waitFor();
    assert.equal(await checkbox.isChecked(), false);
    await checkbox.press("Space");
    state.setting = { ...state.setting, includeFull: true };
    state.emit("orchestration-auto-plan", state.setting);
    await checkbox.waitFor({ state: "detached" });
    state.setting = { ...state.setting, includeFull: false };
    state.emit("orchestration-auto-plan", state.setting);
    await checkbox.waitFor(); assert.equal(await checkbox.isChecked(), false);
    await checkbox.press("Space");
    await checkbox.dispatchEvent("keydown", { key: " ", repeat: true }); assert.equal(await checkbox.isChecked(), true);
    state.failSave = true;
    await page.locator(".chat-plans").getByRole("button", { name: "Approve plan", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Could not save auto-approval: Could not save Full access consent" }).waitFor();
    assert.equal(await page.locator(".chat-plans").getByRole("button", { name: "Approve plan", exact: true }).count(), 0);
    assert.deepEqual(state.calls.filter(call => /orchestration_(plan_approve|auto_plan_set)$/.test(call.cmd)).map(call => call.cmd), ["orchestration_plan_approve", "orchestration_auto_plan_set"]);
    assert.equal(approveCalls(state).length, 1);
    assert.deepEqual(setCalls(state)[0].args, { chatKey: "chat:main", enabled: true, includeFull: true });
    await page.screenshot({ path: join(artifacts, `save-error-${width}.png`) });
    await context.close();

    ({ context, page, state } = await scene(width));
    state.refuseApproval = true;
    await page.getByRole("checkbox", { name: fullName, exact: true }).check();
    await page.locator(".chat-plans").getByRole("button", { name: "Approve plan", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "The plan revision changed" }).waitFor();
    assert.equal(setCalls(state).length, 0);
    state.refuseApproval = false;
    await page.locator(".chat-plans").getByRole("button", { name: "Approve plan", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".chat-plans .plan-review"));
    assert.equal(state.setting.includeFull, true);
    assert.equal(setCalls(state).length, 1);
    await context.close();

    console.log(`${width}: Whole held list and peer request`);
    ({ context, page } = await scene(width, "long"));
    await page.locator(".chat-plans").getByText(/Held tasks ·/).waitFor();
    assert.equal(await page.locator(".chat-plans .plan-review .card-fold-toggle").count(), 1);
    assert.doesNotMatch(await page.locator(".chat-plans .auto-plan-held").innerText(), /Prepare the complete/);
    await page.screenshot({ path: join(artifacts, `long-folded-${width}.png`) });
    await page.locator(".chat-plans .plan-review .card-fold-toggle").click();
    await page.locator(".chat-plans .auto-plan-held .card-fold-in").waitFor();
    assert.match(await page.locator(".chat-plans .auto-plan-held").innerText(), /STAR QA: Verify every frame and transition for sequence 8/);
    await page.screenshot({ path: join(artifacts, `long-open-${width}.png`) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await context.close();

    ({ context, page } = await scene(width, "peer"));
    await page.locator(".chat-plans").getByText("Waits for you: a peer request is always approved by you.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("checkbox", { name: fullName }).count(), 0);
    await page.screenshot({ path: join(artifacts, `peer-${width}.png`) });
    await context.close();
    report.checks.push({ width, heldNames: true, oneWholeFold: true, scopeSwitch: true, foreignPressGuards: true,
      heldKeys: true, busyAndFocus: true, scopeEvent: true, offClearsScope: true, approvalFirst: true,
      saveErrorAfterCardRemoved: true, refusedApprovalNeverSaves: true, cardScopeSaved: true, revisionAndScopeReset: true, peersManual: true, noOverflow: true, detailsWraps: true });
  }
  assert.deepEqual(errors, []);
  await writeFile(join(artifacts, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  for (const context of browser?.contexts() ?? []) for (const page of context.pages()) {
    await page.screenshot({ path: join(artifacts, "failure.png") }).catch(() => {});
    console.log(await page.locator(".plan-review").evaluateAll(nodes => nodes.map(node => ({html: node.outerHTML}))));
  }
  throw error;
} finally { await browser?.close(); await server.close(); }
