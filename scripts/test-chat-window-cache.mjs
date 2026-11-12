// Real App + reducer + IndexedDB; isolated socket fixture, no agents or user data.
// Run serially with other probes sharing OCTIQ_WEB_ROOT.
// CHAT_CACHE_BASELINE=1 reinstates the old policy only in this Vite fixture.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserPaths } from "./browser-paths.mjs";
const { webRoot, require, moduleUrl } = browserPaths(import.meta.url);
const { createServer } = await import(moduleUrl(require.resolve("vite")));
const { chromium } = await import(moduleUrl(process.env.PLAYWRIGHT_MODULE || "playwright"));
const output = await mkdtemp(join(tmpdir(), "octiq-chat-windows-"));
const baseline = process.env.CHAT_CACHE_BASELINE === "1";
const results = [];
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
  name: "chat-window-measurement", enforce: "pre",
  transform(code, id) {
    if (baseline && id.endsWith("/src/lib/chatWindowCache.ts")) {
      code = code.replace("RECENT_CHAT_BYTES = 256", "RECENT_CHAT_BYTES = 8")
        .replace("if (!state || !holds(id)) {", "if (!state || !holds(id) || keep.size >= 2) {")
        .replace("for (const id of shown)", "if (!shown.size) { this.recent.clear(); return new Set(); } for (const id of shown)");
    }
    if (id.endsWith("/src/App.tsx")) {
      code = code.replace("export default function App() {", "export default function App() { window.__appRenders = (window.__appRenders || 0) + 1;");
      code = code.replace("const after = fn(before);", "const __start = performance.now(); const after = fn(before); window.__folds?.push({id, ms: performance.now() - __start});");
      code = code.replace("publish: (state) => patch(id, () => state),", "publish: (state) => { window.__publishes.push({id, at: performance.now()}); patch(id, () => state); },");
      code = code.replace("  // Load the task beside the main chat", `
  window.__probeOpen = id => openConversation(conversationsRef.current.find(c => c.id === id));
  window.__probeCover = () => setAppSettings(true);
  window.__probeCheckpoint = async id => {
    const {saveChatCheckpoint} = await import("/src/lib/chatCache.ts");
    const {valueBytes} = await import("/src/lib/valueBytes.ts");
    const state = chatsRef.current.c1;
    const seeded = {...state, messages: [...state.messages, {id: "checkpoint-marker", role: "assistant", streaming: false, blocks: [{kind: "text", text: "Large checkpoint restored"}]}]};
    await saveChatCheckpoint({id, seq: catchUp.current.mark("chat:c1"), state: seeded, updatedAt: Date.now()});
    return valueBytes(seeded);
  };
  window.__probeState = () => Object.fromEntries(Object.entries(chatsRef.current).map(([id, state]) => [id, {held: catchUp.current.holds(keyFor(id)), messages: state.messages.length, seq: catchUp.current.mark(keyFor(id))}]));
  window.__probeBytes = () => Object.entries(chatsRef.current).reduce((bytes, [id, state]) => bytes + (catchUp.current.holds(keyFor(id)) ? valueBytes(state) : 0), 0);
  window.__probeIdle = () => chatReads.current.size === 0;
  // Load the task beside the main chat`);
    }
    if (id.endsWith("/src/lib/replayChat.ts")) {
      code = code.replace("let deadline =", "const __start = performance.now(); let deadline =");
      code = code.replace("return state;", "window.__replays?.push({ms: performance.now() - __start, count: frames.length}); return state;");
    }
    if (id.endsWith("/src/lib/bridge.ts")) {
      code = code.replace("frame = JSON.parse(ev.data as string);", `frame = JSON.parse(ev.data as string);
        if (frame.t === "reply") { const r = window.__requests.find(r => r.id === frame.id); if (r) r.reply = performance.now(); }`);
      code = code.replace('this.send({ t: "invoke", id, cmd, args });', 'if (cmd === "chat_page" || cmd === "chat_since") window.__requests.push({id, cmd, at: performance.now()}); this.send({ t: "invoke", id, cmd, args });');
    }
    if (id.endsWith("/src/lib/loadChat.ts")) {
      code = code.replace("const cached = await readChatCheckpoint(id);", "const __start = performance.now(); const cached = await readChatCheckpoint(id); window.__checkpointReads.push({id, ms: performance.now() - __start, found: !!cached});");
    }
    return code;
  },
};
const server = await createServer({ root: webRoot, cacheDir: join(output, "vite-cache"), server: { host: "127.0.0.1", port: 0, strictPort: false }, plugins: [instrumentation] });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, channel: process.env.OCTIQ_TEST_BROWSER || "chrome" });
  for (const width of process.env.CHAT_CACHE_DESKTOP_ONLY ? [1280] : [1280, 390]) {
    // The previous width's injected host tail must not be in this width's record.
    pages.c0.events = pages.c0.events.filter(event => event.seq !== 1153);
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    const sockets = [], calls = [], heldReplies = [];
    let hold = false;
    await context.addInitScript(() => {
      localStorage.setItem("octiq.web.token", "isolated-fixture");
      localStorage.setItem("octiq.agentsMode", "off");
      localStorage.setItem("octiq.v2.gitColumn", "0");
      window.__folds = []; window.__replays = []; window.__parses = []; window.__requests = []; window.__publishes = []; window.__switches = []; window.__returns = []; window.__checkpointReads = [];
      const parse = JSON.parse;
      JSON.parse = function(value, ...args) {
        const start = performance.now(), result = parse.call(this, value, ...args);
        if (typeof value === "string" && value.length > 100_000) window.__parses.push({ms: performance.now() - start, bytes: value.length});
        return result;
      };
    });
    await context.route("**/auth", r => r.fulfill({ body: "ok" }));
    await context.routeWebSocket(/.*/, ws => {
      sockets.push(ws);
      ws.onMessage(async raw => {
        const d = JSON.parse(String(raw)); if (d.t !== "invoke") return;
        calls.push(d);
        let result = [];
        if (d.cmd === "list_workspaces") result = [{ id: "fixture", name: "Fixture", primary_path: "/fixture" }];
        if (d.cmd === "chat_index_list") result = chats;
        if (d.cmd === "chat_queue_state") result = { live: false, queuedTurnIds: [] };
        if (d.cmd === "git_status") result = { branch: "develop", files: [] };
        if (d.cmd === "orchestration_summary") result = { runs: [], tasks: [], attempts: [], gates: [], messages: [], batches: [], nativeDecisions: [], notifications: [], services: [], bridges: [], peerAsks: [] };
        const chatId = d.args.key?.slice(5);
        if (d.cmd === "chat_page") result = d.args.before == null ? pages[chatId]
          : transcripts[chatId].findLast(page => page.events.at(-1).seq < d.args.before);
        if (d.cmd === "chat_since") result = pages[chatId].events.filter(frame => frame.seq > d.args.after);
        if (d.cmd === "chat_record_head") result = { lastSeq: pages[chatId].events.at(-1)?.seq ?? 0, generation: "fixture-record" };
        const reply = () => ws.send(JSON.stringify({ t: "reply", id: d.id, ok: true, result }));
        if (d.cmd === "chat_page" || d.cmd === "chat_since" || d.cmd === "chat_record_head") {
          if (hold) { heldReplies.push(reply); return; }
          await new Promise(resolve => setTimeout(resolve, 120));
        }
        reply();
      });
    });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", e => { errors.push(e.stack); console.error(e.stack); });
    page.setDefaultTimeout(30_000); page.setDefaultNavigationTimeout(180_000);
    try {
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/#/p/fixture/c/c0`);
      await page.locator(".msgs").getByText("Retained answer c0 31", { exact: true }).waitFor({ timeout: 180_000 });
      const open = async (id, marker = `Retained answer ${id} 31`) => {
        await page.evaluate(id => {
          const record = {id, start: performance.now()}; window.__switches.push(record);
          const observer = new MutationObserver(() => {
            if (document.querySelector('.msgs')?.textContent.includes(`Retained answer ${id} 31`)) {
              record.render = performance.now(); observer.disconnect();
            }
          });
          observer.observe(document.getElementById('root'), {childList: true, subtree: true});
          window.__probeOpen(id);
        }, id);
        try { await page.locator(".msgs").getByText(marker, { exact: true }).waitFor(); }
        catch (error) {
          await page.screenshot({ path: join(output, `open-failed-${width}-${id}.png`) });
          console.error("open failed", id, JSON.stringify(await page.evaluate(() => ({ state: window.__probeState(), hash: location.hash,
            text: document.querySelector('.msgs')?.textContent.slice(-300), waiting: !!document.querySelector('.hero.is-waiting') }))));
          throw error;
        }
      };
      for (let i = 1; i < 6; i++) await open(`c${i}`);
      const cold = await page.evaluate(() => ({ requests: window.__requests, parses: window.__parses,
        replays: window.__replays, publishes: window.__publishes, switches: window.__switches, state: window.__probeState() }));
      await page.screenshot({ path: join(output, `six-${width}.png`) });
      hold = true;
      const before = calls.length;
      let scrollBefore, checkpoint;
      if (baseline) {
        await page.evaluate(() => window.__probeOpen("c0"));
        await page.waitForTimeout(200);
      } else {
        for (let i = 0; i < 6; i++) {
          const id = `c${i}`;
          let profiler;
          if (i === 0 && process.env.CHAT_CACHE_PROFILE) {
            profiler = await context.newCDPSession(page); await profiler.send("Profiler.enable"); await profiler.send("Profiler.start");
          }
          await page.evaluate(id => {
            window.__emptyFrames = [];
            const record = {id, start: performance.now()}; window.__returns.push(record);
            const observe = () => {
              window.__emptyFrames.push(!!document.querySelector('.hero.is-waiting'));
              if (!record.render && document.querySelector('.msgs')?.textContent.includes(`Retained answer ${id} 31`)) record.render = performance.now();
            };
            window.__loadingObserver?.disconnect();
            window.__loadingObserver = new MutationObserver(observe);
            window.__loadingObserver.observe(document.getElementById('root'), {childList: true, subtree: true});
            window.__probeOpen(id);
          }, id);
          // A held network guarantees this is the retained-window path.
          await page.locator(".msgs").getByText(`Retained answer ${id} 31`, { exact: true }).waitFor({ timeout: 2000 });
          assert.equal(await page.locator('.hero.is-waiting').count(), 0);
          assert.equal(await page.evaluate(() => window.__emptyFrames.some(Boolean)), false);
          if (profiler) {
            const {profile} = await profiler.send("Profiler.stop");
            await writeFile(join(output, `switch-profile-${width}.json`), JSON.stringify(profile));
            await profiler.detach();
          }
          await page.screenshot({ path: join(output, `return-${width}-${id}.png`) });
        }
        await page.evaluate(() => window.__probeCover());
        await page.waitForTimeout(150);
        assert.ok(Object.values(await page.evaluate(() => window.__probeState())).filter(s => s.held).length >= 6, "covered page retains recent windows");
        await open("c0");
        await page.screenshot({ path: join(output, `settings-return-${width}.png`) });
        // Leave a genuine reader position, with the network still held.
        await page.locator('.msgs').dispatchEvent('wheel', {deltaY: -700});
        await page.locator('.msgs').evaluate(el => { el.scrollTop = el.scrollHeight / 2; el.dispatchEvent(new Event('scroll')); });
        await page.waitForTimeout(250);
        const anchor = el => {
          const top = el.getBoundingClientRect().top;
          const turns = [...el.querySelectorAll('[data-map-turn]')];
          const turn = turns.findLast(node => node.getBoundingClientRect().top <= top) ?? turns[0];
          return {id: turn.dataset.mapTurn, offset: turn.getBoundingClientRect().top - top};
        };
        scrollBefore = await page.locator('.msgs').evaluate(anchor);
        await open("c1"); await open("c0");
        const restored = await page.locator('.msgs').evaluate(anchor);
        assert.equal(restored.id, scrollBefore.id, "same user turn at viewport top");
        assert.ok(Math.abs(scrollBefore.offset - restored.offset) < 2, `scroll anchor: ${JSON.stringify(scrollBefore)} -> ${JSON.stringify(restored)}`);
      }
      const returned = await page.evaluate(() => ({ state: window.__probeState(), loading: !!document.querySelector('.hero.is-waiting'), switches: window.__returns }));
      if (baseline) assert.equal(returned.loading, true, "the original policy reproduces the wait after six chats");
      hold = false; while (heldReplies.length) heldReplies.shift()();
      await page.locator(".msgs").getByText("Retained answer c0 31", { exact: true }).waitFor();
      await page.waitForTimeout(400);
      if (!baseline) {
        // An unseen host tail is caught up on return, without subscribing every
        // retained window (or folding those deltas in all four tabs).
        await open("c1");
        const frame = {seq: 1153, event: {type: "assistant", message: {id: "caught-up", content: [{type: "text", text: "Caught up from retained tail"}]}}};
        pages.c0.events.push(frame);
        sockets[0].send(JSON.stringify({t: "event", event: "chat-event", payload: {key: "chat:c0", ...frame}}));
        await open("c0");
        await page.locator('.msgs').getByText("Caught up from retained tail", {exact: true}).waitFor();
        assert.equal(await page.locator('.msgs').getByText("Caught up from retained tail", {exact: true}).count(), 1);
        hold = true;
        const bytes = await page.evaluate(() => window.__probeCheckpoint("c7"));
        await page.evaluate(() => {
          const start = performance.now();
          const observer = new MutationObserver(() => {
            if (document.querySelector('.msgs')?.textContent.includes('Large checkpoint restored')) {
              window.__checkpointDisplayMs = performance.now() - start; observer.disconnect();
            }
          });
          observer.observe(document.getElementById('root'), {childList: true, subtree: true});
          window.__probeOpen("c7");
        });
        await page.locator('.msgs').getByText("Large checkpoint restored", {exact: true}).waitFor({timeout: 2000});
        checkpoint = {bytes, ...await page.evaluate(() => ({displayMs: window.__checkpointDisplayMs, read: window.__checkpointReads.findLast(r => r.id === 'c7')})), networkHeld: true};
        await page.screenshot({path: join(output, `checkpoint-${width}.png`)});
        hold = false; while (heldReplies.length) heldReplies.shift()();
        await page.waitForTimeout(400);
        // The caught-up tail is c0's newest reply now; the turn's earlier text folds into its work line.
        await open("c0", "Caught up from retained tail");
      }
      const tabs = [page];
      if (!baseline && width === 1280) {
        for (let tab = 0; tab < 3; tab++) {
          const extra = await context.newPage(); extra.on("pageerror", error => errors.push(error.stack));
          await extra.goto(`http://127.0.0.1:${server.httpServer.address().port}/#/p/fixture/c/c0`);
          // The host's page for c0 already ends with the caught-up reply (it folds the turn's earlier text).
          await extra.locator('.msgs').getByText("Caught up from retained tail", {exact: true}).waitFor();
          for (let i = 1; i < 6; i++) {
            await extra.evaluate(id => window.__probeOpen(id), `c${i}`);
            await extra.locator('.msgs').getByText(`Retained answer c${i} 31`, {exact: true}).waitFor();
          }
          await extra.evaluate(() => window.__probeOpen("c0"));
          await extra.locator('.msgs').getByText("Caught up from retained tail", {exact: true}).waitFor();
          tabs.push(extra);
        }
      }
      await page.waitForTimeout(400);
      // Even deliberately over-delivering offscreen frames cannot wake the
      // retained reducer windows. The normal host does not send these at all.
      const deltaStart = [];
      for (const tab of tabs) {
        await tab.waitForFunction(() => window.__probeIdle());
        deltaStart.push(await tab.evaluate(() => ({folds: window.__folds.filter(f => f.id === 'c1').length, renders: window.__appRenders})));
      }
      for (let n = 0; n < 1000; n++) for (const socket of sockets) socket.send(JSON.stringify({ t: "event", event: "chat-event", payload: {
        key: "chat:c1", seq: 2000 + n, event: { type: "stream_event", event: {type: "content_block_delta", delta: { type: "text_delta", text: "delta" }, index: 0} },
      } }));
      await page.waitForTimeout(400);
      const delta = [], memory = [];
      for (let i = 0; i < tabs.length; i++) {
        delta.push(await tabs[i].evaluate(start => ({folds: window.__folds.filter(f => f.id === 'c1').length - start.folds, renders: window.__appRenders - start.renders}), deltaStart[i]));
        assert.equal(delta[i].folds, 0, "offscreen scoped transcript does not run reducer");
        const cdp = await context.newCDPSession(tabs[i]);
        await cdp.send("HeapProfiler.collectGarbage"); await cdp.send("Performance.enable");
        const metrics = await cdp.send("Performance.getMetrics");
        memory.push({estimatedWindows: await tabs[i].evaluate(() => window.__probeBytes()), heapBytes: metrics.metrics.find(m => m.name === "JSHeapUsedSize").value});
        await cdp.detach();
      }
      let activeDisplayMs;
      {
        await page.evaluate(() => {
          window.__activeStart = performance.now();
          const observer = new MutationObserver(() => {
            if (document.querySelector('.msgs')?.textContent.includes('Visible chat stays responsive')) {
              window.__activeDisplayMs = performance.now() - window.__activeStart; observer.disconnect();
            }
          });
          observer.observe(document.getElementById('root'), {childList: true, subtree: true});
        });
        for (const socket of sockets) socket.send(JSON.stringify({t: "event", event: "chat-event", payload: {key: "chat:c0", seq: 1154,
          event: {type: "assistant", message: {id: "visible-update", content: [{type: "text", text: "Visible chat stays responsive"}]}}}}));
        await page.locator('.msgs').getByText("Visible chat stays responsive", {exact: true}).waitFor();
        activeDisplayMs = await page.evaluate(() => window.__activeDisplayMs);
      }
      results.push({ width, pageWireBytes: JSON.stringify(pages.c0).length, transcriptBytes: JSON.stringify(transcripts.c0).length,
        cold, returned, delta, tabs: tabs.length, memory, activeDisplayMs, checkpoint, scrollBefore, catchupRequests: calls.slice(before).filter(c => /chat_page|chat_since/.test(c.cmd)).length });
      assert.deepEqual(errors, []);
    } catch (error) {
      await page.screenshot({ path: join(output, `failure-${width}.png`) });
      await writeFile(join(output, `failure-${width}.html`), await page.content());
      console.error({ output, errors }); throw error;
    } finally { await context.close(); if (!baseline) pages.c0.events.splice(96); }
  }
  await writeFile(join(output, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ output, baseline, results }, null, 2));
} finally { await browser?.close(); await server.close(); }
