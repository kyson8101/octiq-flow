// Real pointer/keyboard events against the App with mocked RPCs; no live chats change.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const server = await createServer({ root: new URL("../web", import.meta.url).pathname,
  server: { host: "127.0.0.1", port: 0, strictPort: false } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: process.env.OCTIQ_TEST_BROWSER || "chrome", headless: true });
  for (const touch of [false, true]) {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1280, height: 900 }, hasTouch: touch, isMobile: touch });
    const chats = ["a", "b"].map(id => ({ id, title: `Task ${id}`, projectId: "project", customTitle: true,
      modelId: "codex:sol", createdAt: 1, updatedAt: 2, sessionId: null, pinned: false }));
    const writes = [], errors = [];
    await context.addInitScript(chats => {
      localStorage.setItem("octiq.v2.conversations", JSON.stringify(chats.map(chat => ({ ...chat, messages: [] }))));
      localStorage.setItem("octiq.chat.filter", "all");
      localStorage.setItem("octiq.v2.gitColumn", "0");
    }, chats);
    await context.route("**/token", route => route.fulfill({ body: "mock-token" }));
    await context.route("**/auth", route => route.fulfill({ body: "ok" }));
    await context.routeWebSocket(/.*/, socket => socket.onMessage(raw => {
      const call = JSON.parse(String(raw));
      if (call.t !== "invoke") return;
      let result = [];
      if (call.cmd === "list_workspaces") result = [{ id: "project", name: "OctiqFlow", primary_path: "/test" }];
      if (call.cmd === "chat_index_list") result = chats;
      if (call.cmd === "chat_page") result = { events: [], context: [], before: null };
      if (call.cmd === "chat_queue_state") result = { live: false, queuedTurnIds: [] };
      if (call.cmd === "orchestration_snapshot") result = { runs: [], tasks: [], attempts: [], gates: [], messages: [] };
      if (call.cmd === "chat_set_done") writes.push(call.args);
      socket.send(JSON.stringify({ t: "reply", id: call.id, ok: true, result }));
    }));
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/#/p/octiqflow/c/a`, { timeout: 60000 });
    if (touch) await page.getByRole("button", { name: "Back to chats", exact: true }).tap();
    const badge = id => page.locator(`.chat-badge[aria-label$=": Task ${id}"]`);
    const activate = id => touch ? badge(id).tap() : badge(id).click();
    const pressed = id => badge(id).getAttribute("aria-pressed");

    await activate("a");
    assert.equal(await pressed("a"), "false", `${touch ? "touch" : "mouse"}: one tap must not mark done`);
    await page.waitForTimeout(600);
    await activate("a");
    assert.equal(await pressed("a"), "false", "widely separated taps must not combine");
    await activate("b");
    assert.equal(await pressed("b"), "false", "taps on different logos must not combine");
    await page.getByRole("searchbox", { name: "Search chats" }).focus();
    await activate("b");
    assert.equal(await pressed("b"), "false", "leaving the logo cancels the first tap");
    await page.getByRole("searchbox", { name: "Search chats" }).focus();

    if (touch) { await activate("a"); await activate("a"); }
    else await badge("a").dblclick();
    assert.equal(await pressed("a"), "true", "double activation marks done exactly once");
    await page.waitForTimeout(600);
    await activate("a");
    assert.equal(await pressed("a"), "true", "one tap must not undo completion");
    await page.waitForTimeout(600);
    if (touch) { await activate("a"); await activate("a"); }
    else await badge("a").dblclick();
    assert.equal(await pressed("a"), "false", "double activation can undo completion");

    await badge("a").focus();
    await page.keyboard.press("Enter");
    assert.equal(await pressed("a"), "true", "Enter remains accessible");
    await page.keyboard.press("Space");
    assert.equal(await pressed("a"), "false", "Space remains accessible");
    assert.deepEqual(errors, []);
    assert.equal(writes.length, 4, "only deliberate activations write completion");
    await context.close();
  }
  console.log("PASS: mouse and touch require double activation; slow/cross-row/blurred taps do nothing; keyboard works.");
} finally {
  await browser?.close();
  await server.close();
}
