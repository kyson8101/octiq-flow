// App-shell regression for where a handover is drawn in a long chat. The
// socket is mocked, but every frame goes through App.tsx, the handover store
// and MessageList.
//
// Only a handover that still waits on the person (pending, or starting with a
// failed start) holds the end of the transcript as a full card. A settled one
// is one line that stays where it happened and scrolls away:
//   * confirmed: under the turn that called the handover tool;
//   * incoming: at the head of the new chat's transcript;
// and both still open their brief and link to the other chat. Checked at 1440
// and 375 wide, with screenshots, and with nothing scrolling sideways.
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const artifacts = process.env.OCTIQ_EVIDENCE_DIR
  || await mkdtemp(join(tmpdir(), "octiq-handover-placement-"));
await mkdir(artifacts, { recursive: true });

const now = Date.now();
const text = (id, role, words) => ({ id, role, streaming: false, blocks: [{ kind: "text", text: words }] });
const filler = (prefix, count) => {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push(text(`${prefix}-u${i}`, "user", `Question ${i + 1} about the login fix in ${prefix}?`));
    out.push(text(`${prefix}-a${i}`, "assistant",
      `Answer ${i + 1}. The session cookie is set before the redirect, and the test covers the expired case. `
      + "This paragraph is long enough to wrap over a couple of lines on a phone."));
  }
  return out;
};
/** The turn where the agent called the handover tool, answered as `result`. */
const called = (id, result) => ({
  id, role: "assistant", streaming: false,
  blocks: [
    { kind: "text", text: "Handing the rest of this to Mango, as you asked." },
    { kind: "tool", id: `tool-${id}`, name: "mcp__octiq__handover", argsJson: "{}", args: { recipient: "Mango" },
      result, state: result ? "done" : "running" },
  ],
});

const record = (id, extra) => ({
  id, sourceChatKey: "chat:source-done", sourceTitle: "Fix the login bug", sourceProject: "General",
  from: { agentId: "agent_potato", name: "Potato" }, to: { agentId: "agent_mango", name: "Mango" },
  settings: { agent: "claude", model: "sonnet", effort: "high", access: "edits" },
  destination: { projectId: "general", projectName: "General", repository: "/repo/app" },
  workspace: { mode: "continue", path: "/repo/.worktrees/app/fix-login", branch: "fix/login", head: "abc1234", uncommitted: true, chosen: "source" },
  brief: {
    objective: "Finish the login fix and get its tests green.",
    doneSoFar: "Cookie ordering fixed; the redirect test passes.",
    remaining: "The expired-session path and a regression test.",
    authorized: ["commit on the task branch"], notAuthorized: ["push"],
  },
  status: "confirmed", createdAt: now - 50_000, notice: "tool", ...extra,
});
const handovers = [
  record("handover_done", { targetChatKey: "chat:target" }),
  record("handover_old", { sourceChatKey: "chat:source-old", targetChatKey: "chat:target-old" }),
  record("handover_wait", { sourceChatKey: "chat:source-wait", status: "pending", notice: "pending" }),
  record("handover_err", {
    sourceChatKey: "chat:source-err", status: "starting", targetChatKey: "chat:never",
    error: "Claude Code is not installed on this machine.", abandonable: true, notice: "pending",
  }),
];

const chat = (id, title, messages, over = {}) => ({
  meta: {
    id, projectId: "general", title, customTitle: true, modelId: "claude:opus", access: "auto",
    sessionId: `session-${id}`, createdAt: now - 60_000, updatedAt: now - 10_000, ...over,
  },
  messages,
});
const chats = [
  // Asked in the middle; ten more turns came after it.
  chat("source-done", "Fix the login bug", [
    ...filler("before", 6),
    called("asked", "The person confirmed handover handover_done. Mango now continues the task in a new chat."),
    text("closing", "assistant", "Handed over to Mango."),
    ...filler("after", 5),
  ]),
  // Asked so long ago that its turn is behind "Load earlier messages".
  chat("source-old", "An older handover", [
    ...filler("old-before", 2),
    called("asked-old", "The person confirmed handover handover_old. Mango now continues the task in a new chat."),
    ...filler("old-after", 7),
  ]),
  chat("target", "Finish the login fix", [
    text("brief", "user", "You are taking over a task from Potato. Finish the login fix."),
    ...filler("target", 14),
  ]),
  chat("source-wait", "Wants to hand over", [...filler("wait", 12), called("asking", undefined)]),
  chat("source-err", "Start failed", [
    ...filler("err", 12),
    called("asked-err", "The person confirmed handover handover_err, and Mango's new chat is being started."),
  ]),
];
const index = chats.map((item) => item.meta);
const localChats = chats.map((item) => ({ ...item.meta, messages: item.messages }));

const errors = [];
const server = await createServer({
  root: new URL("../web", import.meta.url).pathname,
  configFile: new URL("../web/vite.config.ts", import.meta.url).pathname,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

function resultFor(request) {
  switch (request.cmd) {
    case "list_workspaces": return [{ id: "general", name: "General", primary_path: "/repo/app" }];
    case "chat_index_list": return index;
    case "chat_index_deleted": return [];
    case "chat_page": return { events: [], context: [], before: null };
    case "chat_list": return [];
    case "chat_activity": return [];
    case "chat_queue_state": return { live: false, queuedTurnIds: [] };
    case "handover_list": return handovers;
    case "orchestration_snapshot": return { runs: [], tasks: [], attempts: [], gates: [], messages: [] };
    case "sandbox_snapshot": return { defaultEnabled: false, environments: {} };
    case "permission_pending": return [];
    case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
    case "usage_summary": return {};
    case "agent_installs": return [{ id: "claude", installed: true, path: "/mock/claude" }];
    case "chat_task": return { chatId: request.args?.chatId, projectId: "general" };
    case "codex_skills": return [];
    default: return null;
  }
}

/** Where `selector` sits: inside the scroller's view, and whether anything
 *  of the transcript is drawn after it. */
const where = (page, selector) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const scroller = document.querySelector(".msgs");
  const a = el.getBoundingClientRect();
  const b = scroller.getBoundingClientRect();
  const turns = [...document.querySelectorAll(".msgs-inner [data-map-turn], .msgs-inner .msg")];
  const after = turns.filter((t) => el.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING).length;
  const before = turns.filter((t) => el.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_PRECEDING).length;
  const headline = el.querySelector(".handover-line-text");
  const clipped = !!headline && headline.scrollWidth > headline.clientWidth;
  return { inView: a.bottom > b.top && a.top < b.bottom, height: a.height, after, before, clipped };
}, selector);
const toBottom = (page) => page.evaluate(async () => {
  const el = document.querySelector(".msgs");
  el.scrollTop = el.scrollHeight;
  await new Promise((r) => setTimeout(r, 400));
});
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  const base = `http://127.0.0.1:${server.httpServer.address().port}/`;

  async function open(viewport, chatId) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
    await context.addInitScript((seed) => {
      if (location.protocol === "about:") return;
      localStorage.setItem("octiq.v2.gitColumn", "0");
      localStorage.setItem("octiq.theme", "dark");
      localStorage.setItem("octiq.v2.conversations", JSON.stringify(seed));
    }, localChats);
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
    page.on("pageerror", (error) => errors.push(error.stack ?? String(error)));
    await page.goto(`${base}#/p/general/c/${chatId}`, { waitUntil: "domcontentloaded" });
    await page.locator(".msgs .msg").first().waitFor();
    await page.waitForTimeout(600);
    return { context, page };
  }

  for (const [label, viewport] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 375, height: 740 }]]) {
    // ── Confirmed, in the chat that asked: one line under the asking turn.
    {
      const { context, page } = await open(viewport, "source-done");
      await toBottom(page);
      assert.equal(await page.locator(".handover-card").count(), 0, `${label}: no card holds the end`);
      const line = '.handover-line[data-status="confirmed"]';
      const at = await where(page, line);
      assert.ok(at, `${label}: the confirmed line is drawn`);
      assert.equal(at.inView, false, `${label}: at the bottom, the line has scrolled away`);
      assert.ok(at.after >= 10, `${label}: the later turns come after it (${at.after})`);
      // One row on a desktop; on a phone the links may take a second, short one.
      assert.ok(at.height <= (label === "phone" ? 56 : 30), `${label}: compact (${at.height}px)`);
      assert.equal(at.clipped, false, `${label}: the headline is whole`);
      await page.screenshot({ path: join(artifacts, `${label}-confirmed-bottom.png`) });
      // Read back the way a person does, with a gesture, so the transcript
      // stops following the end.
      const msgs = await page.locator(".msgs").boundingBox();
      await page.mouse.move(msgs.x + msgs.width / 2, msgs.y + msgs.height / 2);
      for (let i = 0; i < 40 && !(await where(page, line)).inView; i += 1) {
        await page.mouse.wheel(0, -300);
        await page.waitForTimeout(60);
      }
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        const scroller = document.querySelector(".msgs");
        scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 160;
      }, line);
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(artifacts, `${label}-confirmed-line.png`) });
      await page.locator(line).getByRole("button", { name: "Brief" }).click();
      await page.locator(`${line} .handover-line-body`).waitFor({ state: "visible" });
      assert.match(await page.locator(`${line} .handover-line-body`).innerText(), /expired-session path/);
      assert.match(await page.locator(`${line} .handover-line-body`).innerText(), /fix-login/);
      await page.waitForTimeout(250);
      assert.equal((await where(page, line)).inView, true, `${label}: opening the brief keeps it where the reader is`);
      await page.screenshot({ path: join(artifacts, `${label}-confirmed-brief.png`) });
      assert.equal(await page.locator(line).getByRole("button", { name: "Open Mango's chat" }).count(), 1);
      assert.equal(await noSideways(page), true, `${label}: nothing scrolls sideways`);
      await context.close();
    }
    // ── An older one: at its own turn, once the earlier turns are loaded.
    {
      const { context, page } = await open(viewport, "source-old");
      const line = '.handover-line[data-status="confirmed"]';
      assert.equal(await page.locator(line).count(), 0, `${label}: not drawn out of place while its turn is not shown`);
      assert.equal(await page.locator(".handover-card").count(), 0);
      await page.evaluate(() => { document.querySelector(".msgs").scrollTop = 0; });
      await page.getByRole("button", { name: "Load earlier messages" }).click();
      await page.locator(line).waitFor();
      const at = await where(page, line);
      assert.ok(at.after >= 12 && at.before >= 2, `${label}: at its own turn (${at.before} before, ${at.after} after)`);
      await context.close();
    }
    // ── Incoming, in the new chat: at the head of the transcript.
    {
      const { context, page } = await open(viewport, "target");
      const line = '.handover-line[data-status="incoming"]';
      const at = await where(page, line);
      assert.ok(at, `${label}: the incoming line is drawn`);
      assert.equal(at.before, 0, `${label}: nothing of the transcript comes before it`);
      // One row on a desktop; on a phone the links may take a second, short one.
      assert.ok(at.height <= (label === "phone" ? 56 : 30), `${label}: compact (${at.height}px)`);
      assert.equal(at.clipped, false, `${label}: the headline is whole`);
      await toBottom(page);
      assert.equal((await where(page, line)).inView, false, `${label}: at the bottom, the incoming line has scrolled away`);
      assert.equal(await page.locator(".handover-card").count(), 0);
      await page.screenshot({ path: join(artifacts, `${label}-incoming-bottom.png`) });
      await page.evaluate(() => { document.querySelector(".msgs").scrollTop = 0; });
      await page.waitForTimeout(300);
      assert.equal(await page.locator(line).getByRole("button", { name: "Open the original chat" }).count(), 1);
      await page.screenshot({ path: join(artifacts, `${label}-incoming-top.png`) });
      assert.equal(await noSideways(page), true, `${label}: nothing scrolls sideways`);
      await context.close();
    }
    // ── Pending: the full card at the end, as before.
    {
      const { context, page } = await open(viewport, "source-wait");
      await toBottom(page);
      const card = '.handover-card[data-status="pending"]';
      const at = await where(page, card);
      assert.ok(at, `${label}: the pending card is drawn`);
      assert.equal(at.after, 0, `${label}: it is the end of the chat`);
      assert.equal(at.inView, true, `${label}: and in view at the bottom`);
      assert.equal(await page.locator(card).getAttribute("data-pending-keys"), "handover:handover_wait");
      assert.equal(await page.locator(`${card} .handover-go`).innerText(), "Hand over to Mango");
      assert.equal(await page.locator(".handover-line").count(), 0);
      await page.locator(card).scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(artifacts, `${label}-pending.png`) });
      await context.close();
    }
    // ── Starting with a failed start: the full card at the end, Try again and Give up.
    {
      const { context, page } = await open(viewport, "source-err");
      await toBottom(page);
      const card = '.handover-card[data-status="starting"]';
      const at = await where(page, card);
      assert.ok(at, `${label}: the starting card is drawn`);
      assert.equal(at.after, 0, `${label}: it is the end of the chat`);
      assert.match(await page.locator(card).innerText(), /not installed on this machine/);
      assert.equal(await page.locator(card).getByRole("button", { name: "Try again" }).count(), 1);
      assert.equal(await page.locator(card).getByRole("button", { name: "Give up" }).count(), 1);
      assert.equal(await page.locator(".handover-line").count(), 0);
      await page.locator(card).scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(artifacts, `${label}-starting-error.png`) });
      await context.close();
    }
  }
  assert.deepEqual(errors, [], "no page errors");
  console.log(`ok — screenshots in ${artifacts}`);
} finally {
  await browser?.close();
  await server.close();
}
