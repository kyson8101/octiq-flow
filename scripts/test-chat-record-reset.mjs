// Real App + reducer + IndexedDB; isolated socket fixture, no agents or user data.
// Run serially with other probes sharing OCTIQ_WEB_ROOT.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserPaths } from "./browser-paths.mjs";
const { webRoot, require, moduleUrl } = browserPaths(import.meta.url);
const { createServer } = await import(moduleUrl(require.resolve("vite")));
const { chromium } = await import(moduleUrl(process.env.PLAYWRIGHT_MODULE || "playwright"));
const output = await mkdtemp(join(tmpdir(), "octiq-chat-windows-"));
// Recorded tool/result vocabulary, expanded in this fixture only. The original
// captures stay verbatim. Each durable chat represents 12 of these large pages.
const capture = (await readFile(join(webRoot, "src/lib/__fixtures__/file-edits.jsonl"), "utf8"))
  .trim().split("\n").map(line => JSON.parse(line));
const source = capture.find(e => e.type === "assistant" && e.message?.content?.some(b => b.type === "tool_use"));
assert.ok(source, "recorded tool call");
const chats = Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, projectId: "fixture", title: `Window ${i}`,
  modelId: "claude-sonnet", createdAt: 1, updatedAt: 2, access: "read" }));
function recordedPage(id, part) {
  const events = [];
  for (let i = 0; i < 32; i++) {
    const seq = part * 96 + i * 3 + 1, prefix = `${id}-${part}`;
    events.push({ seq, event: { type: "user", uuid: `${prefix}-u-${i}`, message: { role: "user", content: `Question ${id} ${i}` } } });
    events.push({ seq: seq + 1, event: { ...source, uuid: `${prefix}-a-${i}`, message: { ...source.message, id: `${prefix}-m-${i}`,
      content: [{ type: "text", text: `Retained answer ${id} ${i}` }, { type: "tool_use", id: `${prefix}-t-${i}`, name: "Read", input: { file_path: `/fixture/${i}.txt` } }] } } });
    events.push({ seq: seq + 2, event: { type: "user", uuid: `${prefix}-r-${i}`, message: { role: "user",
      content: [{ type: "tool_result", tool_use_id: `${prefix}-t-${i}`, content: "Large recorded-shape tool output\n".repeat(1800) }] } } });
  }
  return { events, context: [], before: part ? part * 96 + 1 : null };
}
const transcripts = Object.fromEntries(chats.map(({ id }) => [id, Array.from({ length: 12 }, (_, part) => recordedPage(id, part))]));
const pages = Object.fromEntries(chats.map(({ id }) => [id, transcripts[id].at(-1)]));
const instrumentation = {
  name: "chat-record-reset-probe", enforce: "pre",
  transform(code, id) {
    if (!id.endsWith("/src/App.tsx")) return code;
    return code.replace("  // Load the task beside the main chat", `
  window.__extras = {clear: () => send("/clear"), cover: () => setAppSettings(true)};
  window.__probeOpen = id => openConversation(conversationsRef.current.find(c => c.id === id));
  window.__probeState = () => Object.fromEntries(Object.entries(chatsRef.current).map(([id, state]) => [id,
    {held: catchUp.current.holds(keyFor(id)), messages: state.messages.length, seq: catchUp.current.mark(keyFor(id)), generation: catchUp.current.generation(keyFor(id))}]));
  window.__probeIdle = () => chatReads.current.size === 0;
  // Load the task beside the main chat`);
  },
};
const server = await createServer({ root: webRoot, server: { host: "127.0.0.1", port: 0, strictPort: false }, plugins: [instrumentation] });


// Adapted from OCTIQ DEV BACKUP's /tmp/octiq-ef-review-supp.mjs.
// The socket-only head/event contract is simulated; no real host or agents.
let browser;
const review = [];
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, channel: process.env.OCTIQ_TEST_BROWSER || "chrome" });
  for (const scenario of ["broadcast", "missed-event", "generation", "checkpoint", "visible", "clear-failure", "clear-save-first"]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    const sockets = [], calls = [], errors = [];
    let generation = "before-clear";
    let finishForget, forgetAnswered = false;
    const hostError = "The profile folder /fixture/profile is not available right now: nothing was saved. Put the original folder back and retry.";
    for (const c of chats) pages[c.id] = transcripts[c.id].at(-1);
    await context.addInitScript(() => {
      localStorage.setItem("octiq.web.token", "isolated-fixture"); localStorage.setItem("octiq.agentsMode", "off"); localStorage.setItem("octiq.v2.gitColumn", "0");
    });
    await context.route("**/auth", r => r.fulfill({ body: "ok" }));
    await context.routeWebSocket(/.*/, ws => {
      sockets.push(ws);
      ws.onMessage(raw => {
        const d = JSON.parse(String(raw)); if (d.t !== "invoke") return;
        calls.push(d); let result = [];
        if (d.cmd === "list_workspaces") result = [{ id: "fixture", name: "Fixture", primary_path: "/fixture" }];
        if (d.cmd === "chat_index_list") result = chats;
        if (d.cmd === "chat_list" && scenario.startsWith("clear-")) result = ["chat:c0"];
        if (d.cmd === "chat_queue_state") result = { live: false, queuedTurnIds: [] };
        if (d.cmd === "git_status") result = { branch: "develop", files: [] };
        if (d.cmd === "orchestration_summary") result = { runs: [], tasks: [], attempts: [], gates: [], messages: [], batches: [], nativeDecisions: [], notifications: [], services: [], bridges: [], peerAsks: [] };
        const chatId = d.args.key?.slice(5);
        if (d.cmd === "chat_page") result = pages[chatId];
        if (d.cmd === "chat_since") result = pages[chatId].events.filter(f => f.seq > d.args.after);
        if (d.cmd === "chat_record_head") result = { lastSeq: pages[chatId].events.at(-1)?.seq ?? 0, generation: chatId === "c0" ? generation : "stable" };
        if (d.cmd === "chat_forget") {
          if (scenario === "clear-failure") {
            ws.send(JSON.stringify({ t: "reply", id: d.id, ok: false, error: hostError }));
            return;
          }
          if (scenario === "clear-save-first") {
            finishForget = () => {
              generation = "after-clear";
              pages.c0 = { events: [
                { seq: 1, event: { type: "user", uuid: "racing-user", message: { role: "user", content: "New post-clear question" } } },
                { seq: 2, event: { type: "assistant", message: { id: "racing-answer", content: [{ type: "text", text: "New post-clear answer" }] } } },
              ], context: [], before: null };
              for (const socket of sockets) {
                socket.send(JSON.stringify({ t: "event", event: "chat-forgotten", payload: { key: d.args.key } }));
                // New-record events racing the reply must survive the local reset.
                for (const frame of pages.c0.events) socket.send(JSON.stringify({ t: "event", event: "chat-event", payload: { key: d.args.key, ...frame } }));
              }
              forgetAnswered = true;
              ws.send(JSON.stringify({ t: "reply", id: d.id, ok: true, result: null }));
            };
            return;
          }
          pages[chatId] = { events: [], context: [], before: null }; generation = "after-clear";
          if (scenario === "broadcast" || scenario === "visible") for (const socket of sockets) socket.send(JSON.stringify({ t: "event", event: "chat-forgotten", payload: { key: d.args.key } }));
        }
        if (d.cmd === "chat_send" && scenario === "clear-save-first") assert.ok(forgetAnswered, "agent /clear waits for the saved reply");
        ws.send(JSON.stringify({ t: "reply", id: d.id, ok: true, result }));
      });
    });
    const page = await context.newPage(); page.setDefaultTimeout(30000); page.on("pageerror", e => errors.push(e.message));
    const url = `http://127.0.0.1:${server.httpServer.address().port}/#/p/fixture/c/c0`;
    const idle = async () => { await page.waitForFunction(() => window.__probeIdle?.()); await page.waitForTimeout(150); };
    await page.goto(url);
    await page.locator(".msgs").getByText("Retained answer c0 31", { exact: true }).waitFor(); await idle();
    const before = await page.evaluate(() => window.__probeState().c0);
    assert.equal(before.seq, 1152); assert.equal(before.messages, 64);
    if (scenario.startsWith("clear-")) {
      const composer = page.getByRole("textbox", { name: "Message", exact: true });
      await composer.fill("/clear"); await composer.press("Enter");
      if (scenario === "clear-failure") {
        await page.locator(".attach-error").getByText(hostError, { exact: true }).waitFor();
        assert.equal(await composer.inputValue(), "/clear");
        assert.deepEqual(await page.evaluate(() => window.__probeState().c0), before);
        assert.equal(calls.filter(c => c.cmd === "chat_send").length, 0);
      } else {
        await page.waitForTimeout(150); await composer.press("Enter"); await page.waitForTimeout(150);
        assert.equal(calls.filter(c => c.cmd === "chat_forget").length, 1);
        assert.equal(calls.filter(c => c.cmd === "chat_send").length, 0);
        assert.deepEqual(await page.evaluate(() => window.__probeState().c0), before);
        assert.equal(await composer.inputValue(), "/clear");
        assert.ok(finishForget); finishForget();
        await page.locator(".msgs").getByText("New post-clear answer", { exact: true }).waitFor();
        await page.waitForFunction(() => document.querySelector('textarea[aria-label="Message"]')?.value === "");
        await idle();
        assert.equal(calls.filter(c => c.cmd === "chat_send" && c.args.text === "/clear").length, 1);
        assert.equal((await page.evaluate(() => window.__probeState().c0)).messages, 2);
      }
      assert.deepEqual(errors, []);
      const after = await page.evaluate(() => ({ state: window.__probeState().c0, text: document.body.textContent }));
      review.push({ scenario, before, after, calls: calls.filter(c => /chat_forget|chat_send/.test(c.cmd)), errors });
      await page.screenshot({ path: join(output, `${scenario}.png`) });
      await context.close(); continue;
    }
    if (scenario !== "visible") await page.evaluate(() => window.__extras.cover("settings"));
    if (scenario === "checkpoint") {
      await page.evaluate(async () => {
        const { readChatCheckpoint, saveChatCheckpoint } = await import("/src/lib/chatCache.ts");
        // Save a representative old complete checkpoint on an offline device.
        window.__oldCheckpoint = { id: "c0", state: await (async () => {
          const { emptyChat, reduceChat } = await import("/src/lib/chat.ts");
          return reduceChat(emptyChat(), { type: "assistant", message: { id: "old-checkpoint", content: [{ type: "text", text: "Retained answer c0 31" }] } });
        })(), seq: 1152, generation: "before-clear", updatedAt: Date.now() };
        await saveChatCheckpoint(window.__oldCheckpoint);
        if (!(await readChatCheckpoint("c0"))) throw new Error("checkpoint missing");
      });
      for (let i = 1; i < 8; i++) {
        await page.evaluate(id => window.__probeOpen(id), `c${i}`);
        await page.locator(".msgs").getByText(`Retained answer c${i} 31`, { exact: true }).waitFor(); await idle();
      }
      assert.equal((await page.evaluate(() => window.__probeState().c0)).held, false);
    }
    const other = await context.newPage(); other.on("pageerror", e => errors.push(e.message));
    await other.goto(url); await other.locator(".msgs").getByText("Retained answer c0 31", { exact: true }).waitFor();
    await other.waitForFunction(() => window.__probeIdle?.());
    await other.evaluate(() => window.__extras.clear());
    await other.waitForFunction(() => window.__probeState().c0.messages === 0);
    assert.equal(pages.c0.events.length, 0);
    if (scenario === "broadcast" || scenario === "visible") {
      await page.waitForFunction(() => window.__probeState().c0.messages === 0 && window.__probeState().c0.seq === 0);
      if (scenario === "visible") {
        await idle(); assert.ok(calls.filter(c => c.cmd === "chat_page" && c.args.key === "chat:c0").length >= 3, "visible reset rereads chat_page");
      }
    }
    if (scenario === "checkpoint") await page.evaluate(async () => {
      const { saveChatCheckpoint } = await import("/src/lib/chatCache.ts"); await saveChatCheckpoint(window.__oldCheckpoint);
    });
    const start = scenario === "generation" ? 1153 : 1;
    pages.c0 = { events: [
      { seq: start, event: { type: "user", uuid: "new-user", message: { role: "user", content: "New post-clear question" } } },
      { seq: start + 1, event: { type: "assistant", message: { id: "new-answer", content: [{ type: "text", text: "New post-clear answer" }] } } },
    ], context: [], before: null };
    if (scenario === "visible") {
      // Real host delivers these new events through the current subscription.
      for (const frame of pages.c0.events) for (const socket of sockets) socket.send(JSON.stringify({ t: "event", event: "chat-event", payload: { key: "chat:c0", ...frame } }));
    } else await page.evaluate(() => window.__probeOpen("c0"));
    await page.locator(".msgs").getByText("New post-clear answer", { exact: true }).waitFor(); await idle();
    const after = await page.evaluate(() => ({ state: window.__probeState().c0, text: document.querySelector(".msgs")?.textContent }));
    assert.equal(after.text.includes("Retained answer"), false);
    assert.equal(after.state.messages, 2); assert.equal(after.state.seq, start + 1);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: join(output, `${scenario}.png`) });
    review.push({ scenario, before, after, requests: calls.filter(c => /chat_page|chat_since|chat_record_head/.test(c.cmd)), errors });
    await writeFile(join(output, "review.json"), JSON.stringify(review, null, 2)); await context.close();
  }
  console.log(JSON.stringify({ output, scenarios: review.map(r => ({ scenario: r.scenario, before: r.before, after: r.after.state, errors: r.errors })) }, null, 2));
} finally {
  await writeFile(join(output, "review.json"), JSON.stringify(review, null, 2));
  console.log("review-output", output); await browser?.close(); await server.close();
}
