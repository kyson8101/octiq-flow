// App-shell regression for a discussion the front desk routes, and for a
// start a writer refuses: nothing on the page opens, re-sends or switches a
// chat to read-only. A discussion is how a route's card is worded and nothing
// else. The page sends the level it holds for a chat and works none out: it
// has no rule, effect or event for the level a process runs at. Nothing
// raises a chat's level at a start either: the chats an earlier build opened
// as read-only discussions are lifted once, on the host, at startup, before
// any page is served.
//
// At 375 and 1440 wide it checks that:
//   A. a route proposed as a discussion is called "Discuss with STAR LEAD?",
//      says "Discussion · starfall" and "read-only" nowhere, folded or
//      opened; its settings are the agent's registered level; confirming it
//      sends `handover_confirm`, and the chat it opened is started at that
//      level;
//   B. a route whose start a writer refused offers Try again and Give up and
//      no third answer, before and after a second refusal;
//   C. a message a writer refused is an ordinary message that was not sent:
//      no read-only retry on its bubble, and sent again it starts at the
//      agent's level;
//   D. a chat saved at read whose agent is STAR LEAD, opened by link and sent
//      to: the page's `chat_start` carries the saved level (read), the page
//      sends no `chat_set_access`, and it saves the chat at no other level,
//      then or on the next message (which goes by `chat_send`);
//   E. the same chat only opened, with the roster read: nothing above read
//      is saved for it (the page works no level out);
//   G. an ordinary chat running at Auto, where the person picks Plan on the
//      access picker: the page sends that one `chat_set_access`. A stray
//      `chat-access-changed` naming Auto (during the request and after it)
//      and a chat-list answer naming Auto change nothing: the picker still
//      says Plan, and once the process has ended the next message's
//      `chat_start` carries read. No host sends that event: there is no
//      level event, and the frame is sent here on purpose. This section
//      guards against one being listened to again, and fails if a listener
//      is put back (review 25fa12, R1).
// Over the whole run: `handover_discuss` is never sent, the only
// `chat_set_access` is the person's own pick in G, and the only chats the page
// starts at read are the front desk's own (registered at read), the one saved
// at read (D) and the one the person put on Plan (G).
//
// The socket is mocked: no message reaches a live agent, and the host's
// answers are stand-ins that raise nothing. This is the page alone. Every
// interaction goes through App.tsx, the Composer and the card. It serves this
// checkout's `web/` with Vite's own dev server on a free loopback port: no
// build, no `web/dist`, no service.
//
// Run:
//   PLAYWRIGHT_MODULE=<playwright/index.mjs> [PLAYWRIGHT_CHANNEL=chrome] \
//     [OCTIQ_EVIDENCE_DIR=<dir>] node scripts/test-front-desk-discussion.mjs
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const engine = playwright[process.env.PLAYWRIGHT_BROWSER || "chromium"];
const artifacts = process.env.OCTIQ_EVIDENCE_DIR || await mkdtemp(join(tmpdir(), "octiq-front-desk-discussion-"));
await mkdir(artifacts, { recursive: true });

const now = Date.now();
const agent = (id, name, extra) => ({
  id, name, role: `${name}'s role`, agent: "claude", model: "opus", effort: "high", access: "auto",
  createdAt: now - 100_000, updatedAt: now - 100_000, projectId: "starfall", ...extra,
});
// The front desk only routes, and is registered at read: its own chat is the
// one chat this script expects to see started at that level.
const desk = agent("desk", "Front desk", { projectId: undefined, model: "haiku", effort: "low", access: "read" });
const lead = agent("lead", "STAR LEAD");
const roster = [agent("potato", "Potato Juice", { projectId: undefined }), desk, lead];
const workspaces = [
  { id: "general", name: "General", primary_path: "/mock/General" },
  { id: "starfall", name: "starfall", primary_path: "/mock/Starfall" },
];
const WRITER = "This checkout has an active writer for task Starfall 30s 战斗短片:storyboard → 作者确认 → 生成. Wait or use a separate worktree.";
const BRIEF = "The person wants to discuss the Starfall 小剧场 series: brainstorm new ideas, not start work.";
// The host's own words for a discussion (`handover.rs`).
const NOTE = "This chat is a discussion, not a task: the person wants to talk it through first. Read whatever helps the conversation, and change nothing unless they ask you to.";
const OPENED_BY = "(Opened by Front desk, the person's front desk, once the person confirmed it.)";
const SETTINGS = { agent: lead.agent, model: lead.model, effort: lead.effort, access: lead.access };
assert.equal(SETTINGS.access, "auto", "the fixture's route runs at the agent's registered level");
// The chat a confirmed route opens: saved by the host at the route's level.
const routed = { id: "routed-1", projectId: "starfall", title: "Discuss the Starfall 小剧场 series", modelId: "claude:opus", access: SETTINGS.access, createdAt: now, updatedAt: now };
// A chat with the same agent that an earlier discussion left saved at read.
const left = { id: "left-1", projectId: "starfall", title: "Talked through the 小剧场 pilot", modelId: "claude:opus", access: "read", createdAt: now - 50_000, updatedAt: now - 50_000 };
// An ordinary chat: no agent is registered for it, so its composer has the
// access picker, and its level is the person's own pick.
const plain = { id: "plain-1", projectId: "starfall", title: "Tidy the build script", modelId: "claude:opus", access: "auto", createdAt: now - 40_000, updatedAt: now - 40_000 };
const leadOf = (chat) => ({ chatKey: `chat:${chat.id}`, leadId: lead.id, leadName: lead.name, projectId: "starfall", createdAt: chat.createdAt });
const routeRecord = (sourceChatKey, extra = {}, route = {}) => ({
  kind: "route",
  id: "handover_route1",
  sourceChatKey,
  sourceTitle: "",
  sourceProject: "",
  from: { agentId: "desk", name: "Front desk" },
  to: { agentId: "lead", name: "STAR LEAD" },
  settings: SETTINGS,
  destination: { projectId: "starfall", projectName: "starfall", repository: "/mock/Starfall" },
  workspace: { mode: "folder", path: "/mock/Starfall", chosen: "new" },
  brief: { objective: BRIEF },
  route: { message: `${BRIEF}\n\n${OPENED_BY}`, ...route },
  status: "pending",
  createdAt: now,
  notice: "pending",
  ...extra,
});
const DISCUSSION = { discuss: true, message: `${BRIEF}\n${NOTE}\n\n${OPENED_BY}` };
const said = (id, prompt, reply) => [
  { seq: 1, event: { type: "user", uuid: `octiq-${id}-start`, octiq_user_turn: true, message: { content: [{ type: "text", text: prompt }] } } },
  { seq: 2, event: { type: "assistant", message: { id: `m-${id}`, role: "assistant", content: [{ type: "text", text: reply }] } } },
  { seq: 3, event: { type: "result", subtype: "success", result: reply } },
];
const frames = (key) => key === `chat:${routed.id}`
  ? said(routed.id, `${BRIEF}\n${NOTE}\n\n=== OctiqFlow agents mode ===\nLead: STAR LEAD`, "Happy to brainstorm. Which episode should we start from?")
  : key === `chat:${left.id}`
    ? said(left.id, "Let's talk the 小剧场 pilot through before anyone writes it.", "The pilot needs a colder open. Shall I draft one?")
    : key === `chat:${plain.id}`
      ? said(plain.id, "Tidy the build script.", "Tidied: the two dead targets are gone.")
      : [];

const calls = [];
const errors = [];
const sockets = new Set();
const deskKeys = new Set();
// What the mocked host holds for the page that is open, set by `open`.
let host = {};
const server = await createServer({
  root: new URL("../web", import.meta.url).pathname,
  configFile: new URL("../web/vite.config.ts", import.meta.url).pathname,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

function resultFor(request) {
  const args = request.args ?? {};
  switch (request.cmd) {
    case "list_workspaces": return workspaces;
    case "chat_index_list": return host.index;
    case "chat_index_deleted": return [];
    case "chat_page": return { events: frames(args.key), context: [], before: null };
    case "chat_since": return frames(args.key).filter((frame) => frame.seq > (args.after ?? 0));
    case "chat_list": return [];
    case "chat_queue_state": return { live: false, queuedTurnIds: [] };
    case "orchestration_snapshot": return { runs: [], tasks: [], attempts: [], gates: [], messages: [] };
    case "permission_pending": return [];
    case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
    case "usage_summary": return {};
    case "git_status": return { branch: "", files: [] };
    case "git_local_branches": return { is_repo: false, current: "", branches: [], is_worktree: false };
    case "agent_installs": return [{ id: "claude", installed: true, path: "/mock/claude" }];
    case "agent_history_list": return [];
    // Asked when a picker opens (G): the page's own list, nothing discovered.
    case "agent_models": return { source: "bundled", models: [] };
    case "team_list": return args.all ? roster : roster.filter((a) => !a.projectId || a.projectId === args.projectId);
    case "team_head": return roster[0];
    case "team_front_desk": return desk;
    case "team_leads": return host.index.filter((chat) => chat.id !== plain.id).map(leadOf);
    case "team_home": return "general";
    case "agent_team_list": return [];
    case "team_brief": return `${args.task}\n\n=== OctiqFlow agents mode ===\nFront desk: Front desk`;
    case "handover_list": return [];
    case "handover_confirm":
      // The host's guard: a writer in the checkout keeps the chat from
      // starting, and trying again as it is meets the same writer.
      if (host.writer) throw new Error(WRITER);
      host.index = [routed];
      return routeRecord(host.deskKey, { status: "confirmed", targetChatKey: `chat:${routed.id}`, decidedAt: Date.now() }, DISCUSSION);
    case "handover_abandon":
      return routeRecord(host.deskKey, { status: "abandoned", decidedAt: Date.now() });
    // A plain folder, as Starfall is: nothing to branch, the folder itself.
    case "git_prepare_chat_workspace":
      return { cwd: args.path, branch: "", is_repo: false, is_worktree: false };
    // The front desk is not in the checkout; any other chat meets the writer.
    case "chat_start":
      if (host.writer && !deskKeys.has(args.key)) throw new Error(WRITER);
      return null;
    // The person's pick is made, and (G) an older frame naming another level
    // goes out ahead of the answer: the page gets it while its own request is
    // still in the air.
    case "chat_set_access":
      if (host.stray) emit("chat-access-changed", { chatKey: args.key, access: host.stray });
      return null;
    case "chat_task": return { chatId: args.chatId, projectId: "starfall" };
    case "codex_skills": return [];
    case "agent_avatar_status": return { available: false, jobs: [] };
    default: return null;
  }
}

const since = (mark, cmd) => calls.slice(mark).filter((call) => call.cmd === cmd).map((call) => call.args);
async function waitFor(page, check, what) {
  for (let index = 0; index < 160; index += 1) {
    const value = await check();
    if (value) return value;
    await page.waitForTimeout(50);
  }
  throw new Error(`Timed out waiting for ${what}`);
}
const emit = (event, payload) => {
  for (const socket of sockets) socket.send(JSON.stringify({ t: "event", event, payload }));
};
const noSidewaysScroll = async (page, width) => assert.equal(
  await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `no sideways scroll at ${width}`,
);
/** The levels the index was asked to save a chat at, since `mark`. */
const savedLevels = (mark, id) => calls.slice(mark)
  .filter((call) => call.cmd.startsWith("chat_index_save"))
  .flatMap((call) => call.args?.entries ?? call.args?.metas ?? (call.args?.meta ? [call.args.meta] : []))
  .filter((meta) => (id ? meta.id === id : true) && meta.access)
  .map((meta) => meta.access);

let browser;
// The page a failure is told from.
let shown;
try {
  await server.listen();
  browser = await engine.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
  const open = async (width, height, touch, { hash = "#/p/starfall", index = [], writer = false, stray = "" } = {}) => {
    sockets.clear();
    host = { index, writer, stray, deskKey: "" };
    const context = await browser.newContext({
      viewport: { width, height }, reducedMotion: "reduce", colorScheme: "dark",
      ...(touch ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}),
    });
    await context.addInitScript(() => {
      if (location.protocol === "about:") return;
      localStorage.setItem("octiq.agentsMode", "on");
      localStorage.setItem("octiq.v2.gitColumn", "0");
    });
    await context.route("**/token", (route) => route.fulfill({ body: "mock-token" }));
    await context.route("**/auth", (route) => route.fulfill({ body: "ok" }));
    await context.routeWebSocket(/.*/, (socket) => {
      sockets.add(socket);
      socket.onMessage((raw) => {
        const request = JSON.parse(String(raw));
        if (request.t !== "invoke") return;
        calls.push(request);
        try {
          socket.send(JSON.stringify({ t: "reply", id: request.id, ok: true, result: resultFor(request) }));
        } catch (error) {
          socket.send(JSON.stringify({ t: "reply", id: request.id, ok: false, error: error.message }));
        }
      });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on("pageerror", (error) => errors.push(error.stack ?? String(error)));
    shown = page;
    // Vite transforms the app as it is first asked for, which takes a while
    // on a cold cache or a busy machine: the page is given time to draw.
    await page.goto(`${base}${hash}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
    await page.locator("textarea").first().waitFor({ timeout: 180_000 });
    return { page, context };
  };
  /** Ask the front desk, and have it answer that it put a card up. */
  const askDesk = async (page, text) => {
    await page.getByRole("heading", { name: "Talk to Front desk", exact: true }).waitFor();
    const mark = calls.length;
    await page.locator("textarea").fill(text);
    await page.locator("button.send").click();
    const [start] = await waitFor(page, () => since(mark, "chat_start").length && since(mark, "chat_start"), "the front desk's chat_start");
    assert.equal(start.access, desk.access, "the front desk runs at its own registered level");
    host.deskKey = start.key;
    deskKeys.add(start.key);
    const reply = "STAR LEAD fits. I've put up a card for them.";
    [
      { type: "system", subtype: "init", session_id: "desk-session" },
      { type: "user", isReplay: true, uuid: "echo-desk-1", octiq_user_turn_id: start.turnId, message: { role: "user", content: [{ type: "text", text: start.prompt }] } },
      { type: "assistant", message: { id: "m-desk", role: "assistant", content: [{ type: "text", text: reply }] } },
      { type: "result", subtype: "success", result: reply },
    ].forEach((event, index) => emit("chat-event", { key: start.key, seq: index + 1, event }));
    return start.key;
  };
  /** The card's answers, in the order they are drawn. */
  const answers = (card) => card.locator(".handover-actions button").allInnerTexts();
  const sizes = [[375, 667, true], [1440, 960, false]];

  // A. A route the front desk proposed as a discussion.
  for (const [width, height, touch] of sizes) {
    const { page, context } = await open(width, height, touch);
    const deskKey = await askDesk(page, "i want to discuss about Starfall 小剧场 series");
    emit("handover-changed", routeRecord(deskKey, {}, DISCUSSION));
    const card = page.locator('[data-kind="route"]');
    await card.waitFor();
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    // Worded as a discussion, at the agent's own level, and never read-only.
    assert.equal(await card.getAttribute("aria-label"), "Discuss with STAR LEAD?");
    assert.match((await card.locator(".handover-fact").innerText()).replace(/\s+/g, " "), /^Discussion · starfall\b/);
    assert.match(await card.locator(".handover-settings").innerText(), /Auto/);
    assert.doesNotMatch(await card.innerText(), /read-only/i, "folded, the card says read-only nowhere");
    assert.deepEqual(await answers(card), ["Cancel", "Discuss with STAR LEAD"]);
    await noSidewaysScroll(page, width);
    await page.screenshot({ path: join(artifacts, `discussion-card-${width}.png`) });
    // Opened, it holds the host's own note, whole.
    await card.locator(".card-fold-toggle").click();
    await card.getByText(NOTE, { exact: false }).waitFor();
    assert.doesNotMatch(await card.innerText(), /read-only/i, "opened, the card says read-only nowhere");
    // A press that repeats the one on the disclosure is dropped (`pressGuard`).
    await page.waitForTimeout(800);

    // Confirming it is the ordinary confirm, and goes into the chat it opened.
    let mark = calls.length;
    await card.getByRole("button", { name: "Discuss with STAR LEAD", exact: true }).click();
    const [confirmed] = await waitFor(page, () => since(mark, "handover_confirm").length && since(mark, "handover_confirm"), "handover_confirm");
    assert.deepEqual(confirmed, { id: "handover_route1" });
    emit("chat-index-changed", { id: routed.id, gone: false });
    await waitFor(page, async () => (await page.evaluate(() => location.hash)).includes(routed.id), "navigation into the routed chat");
    await page.locator(".msg").filter({ hasText: "brainstorm new ideas" }).first().waitFor();
    await page.locator(".composer-identity-name", { hasText: "STAR LEAD" }).waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(artifacts, `discussion-opened-${width}.png`) });

    // The chat it opened is started at the agent's registered level.
    mark = calls.length;
    await page.locator("textarea").fill("Start from episode 3");
    await page.locator("button.send").click();
    const [start] = await waitFor(page, () => since(mark, "chat_start").length && since(mark, "chat_start"), "the routed chat's chat_start");
    assert.equal(start.key, `chat:${routed.id}`);
    assert.equal(start.access, lead.access, "the discussion's chat is started at the agent's registered level");
    await context.close();
  }

  // B. A route whose start a writer refused: Try again, or Give up.
  for (const [width, height, touch] of sizes) {
    const { page, context } = await open(width, height, touch, { writer: true });
    const deskKey = await askDesk(page, "have STAR LEAD storyboard the next 小剧场 episode");
    emit("handover-changed", routeRecord(deskKey));
    const card = page.locator('[data-kind="route"]');
    await card.waitFor();
    emit("handover-changed", routeRecord(deskKey, {
      status: "starting", targetChatKey: `chat:${routed.id}`, error: WRITER, abandonable: true, decidedAt: Date.now(),
    }));
    await card.locator(".handover-error").waitFor();
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const refused = async (when) => {
      assert.equal(await card.getAttribute("aria-label"), "STAR LEAD's chat did not start", when);
      const text = await card.innerText();
      assert.match(text, /active writer for task Starfall 30s/, when);
      assert.match(text, /No chat was opened\. Try again, or give up\./, when);
      assert.doesNotMatch(text, /read-only/i, when);
      assert.deepEqual(await answers(card), ["Give up", "Try again"], when);
      assert.equal(await page.getByRole("button", { name: "Discuss only (read-only)" }).count(), 0, when);
      assert.equal(await page.getByRole("button", { name: /discuss/i }).count(), 0, when);
    };
    await refused("a start the writer refused");
    await noSidewaysScroll(page, width);
    await page.screenshot({ path: join(artifacts, `writer-blocked-card-${width}.png`) });

    // Try again as it is: the same refusal, and still no third answer.
    let mark = calls.length;
    await card.getByRole("button", { name: "Try again", exact: true }).click();
    await waitFor(page, () => since(mark, "handover_confirm").length, "handover_confirm");
    await card.getByRole("button", { name: "Try again", exact: true }).and(card.locator(":enabled")).waitFor();
    await refused("after trying again");

    // Give up is the other way out.
    mark = calls.length;
    await card.getByRole("button", { name: "Give up", exact: true }).click();
    const [abandoned] = await waitFor(page, () => since(mark, "handover_abandon").length && since(mark, "handover_abandon"), "handover_abandon");
    assert.deepEqual(abandoned, { id: "handover_route1" });
    await context.close();
  }

  // C. Straight to the agent, with no front desk in between: the writer
  //    refuses its registered Auto, and the message is simply not sent.
  for (const [width, height, touch] of sizes) {
    const { page, context } = await open(width, height, touch, { writer: true });
    await page.getByRole("heading", { name: "Talk to Front desk", exact: true }).waitFor();
    await page.getByRole("button", { name: "Talk to someone else" }).click();
    await page.getByRole("radio", { name: /STAR LEAD/ }).click();
    await page.getByRole("heading", { name: "Talk to STAR LEAD", exact: true }).waitFor();
    const section = calls.length;
    let mark = calls.length;
    await page.locator("textarea").fill("Let's brainstorm the next 小剧场 episode");
    await page.locator("button.send").click();
    const [first] = await waitFor(page, () => since(mark, "chat_start").length && since(mark, "chat_start"), "chat_start");
    assert.equal(first.access, lead.access, "started at the agent's registered level");
    const bubble = page.locator(".message-bubble").filter({ hasText: "brainstorm the next" });
    await bubble.locator(".message-delivery-error").getByText(WRITER).waitFor();
    assert.equal(await page.getByRole("button", { name: "Discuss read-only" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: /discuss|read-only/i }).count(), 0);
    // What the bubble offers is what any message that was not sent offers.
    const offered = await bubble.locator(".message-delivery-actions button").allInnerTexts();
    assert(offered.includes("Restore to composer"), `the bubble's own way back: ${offered}`);
    assert.deepEqual(offered.filter((name) => /discuss|read/i.test(name)), []);
    assert.doesNotMatch(await bubble.innerText(), /read-only/i);
    await noSidewaysScroll(page, width);
    await page.screenshot({ path: join(artifacts, `direct-writer-blocked-${width}.png`) });

    // Sent again by the person, it is the same send: the agent's level.
    await bubble.getByRole("button", { name: "Restore to composer" }).click();
    await waitFor(page, async () => (await page.locator("textarea").inputValue()).includes("brainstorm the next"), "the message back in the composer");
    mark = calls.length;
    await page.locator("button.send").click();
    const [again] = await waitFor(page, () => since(mark, "chat_start").length && since(mark, "chat_start"), "the second chat_start");
    assert.equal(again.access, lead.access, "sent again at the agent's registered level");
    // Refused again. The first bubble stays (its delivery was never
    // confirmed either way), so there are two, and neither offers more.
    await waitFor(page, async () => (await page.locator(".message-delivery-error").count()) === 2, "the second refusal");
    assert.equal(await page.getByRole("button", { name: /discuss|read-only/i }).count(), 0);
    assert.deepEqual(since(section, "chat_start").map((args) => args.access), [lead.access, lead.access], "no start but the two the person sent");
    const saved = savedLevels(section);
    assert(saved.length > 0 && saved.every((access) => access === lead.access), `the chat is saved at the agent's level: ${saved}`);
    await context.close();
  }

  /** The chat an earlier discussion left at read, opened by its link, with
   *  its words replayed and the roster read (the composer names the agent). */
  const openLeft = async (width, height, touch, options = {}) => {
    const opened = await open(width, height, touch, { hash: `#/p/starfall/c/${left.id}`, index: [left], ...options });
    await opened.page.locator(".msg").filter({ hasText: "colder open" }).first().waitFor();
    await opened.page.locator(".composer-identity-name", { hasText: "STAR LEAD" }).waitFor();
    return opened;
  };
  /** The agent's answer to a turn the page started or sent, as the host
   *  streams it: the chat's record goes on from where the replay ended. */
  let seq = 3;
  const answer = (key, turn, reply) => [
    { type: "user", isReplay: true, uuid: `echo-${turn.turnId}`, octiq_user_turn_id: turn.turnId, message: { role: "user", content: [{ type: "text", text: turn.prompt ?? turn.text }] } },
    { type: "assistant", message: { id: `m-${turn.turnId}`, role: "assistant", content: [{ type: "text", text: reply }] } },
    { type: "result", subtype: "success", result: reply },
  ].forEach((event) => emit("chat-event", { key, seq: (seq += 1), event }));

  // D. A chat saved at read whose agent is STAR LEAD. The page sends the
  //    level saved for the chat, switches nothing and works nothing out, and
  //    nothing raises it at a start. (The one-time lift of chats an earlier
  //    build opened as read-only discussions happens on the host at startup,
  //    before any page.) The mocked host raises nothing and says nothing, so
  //    every level seen here is the page's own doing.
  for (const [width, height, touch] of sizes) {
    seq = 3;
    const section = calls.length;
    const { page, context } = await openLeft(width, height, touch);
    let mark = calls.length;
    await page.locator("textarea").fill("Yes, draft the colder open");
    await page.locator("button.send").click();
    const [start] = await waitFor(page, () => since(mark, "chat_start").length && since(mark, "chat_start"), "chat_start");
    assert.equal(start.key, `chat:${left.id}`);
    assert.equal(start.access, "read", "the page sends the level it has saved, and raises nothing itself");
    answer(start.key, start, "Here is a colder open: the hangar, lights off.");
    await page.locator(".msg").filter({ hasText: "the hangar, lights off" }).first().waitFor();
    await page.screenshot({ path: join(artifacts, `left-at-read-${width}.png`) });

    // A second message is the next turn of the same process: `chat_send`.
    mark = calls.length;
    await page.locator("textarea").fill("Shorter, please");
    await page.locator("button.send").click();
    const [next] = await waitFor(page, () => since(mark, "chat_send").length && since(mark, "chat_send"), "chat_send");
    assert.equal(next.key, `chat:${left.id}`);
    assert.deepEqual(since(mark, "chat_start"), [], "no second start");
    answer(next.key, next, "The hangar. Dark.");
    await page.locator(".msg").filter({ hasText: "The hangar. Dark." }).first().waitFor();
    await page.waitForTimeout(1200);
    const saved = savedLevels(section, left.id);
    assert(saved.length > 0 && saved.every((access) => access === "read"), `the page saves the chat at the level it holds, and no other: ${saved}`);
    assert.deepEqual(since(section, "chat_start").length, 1, "one start in all");
    assert.deepEqual(since(section, "chat_set_access"), [], "the page switches no level");
    await context.close();
  }

  // E. The same chat only opened. The roster is read (and read again), the
  //    words are replayed, and nothing is sent: the page saves no level for
  //    it above the one it was saved at (review 9c843, H1).
  for (const [width, height, touch] of sizes) {
    const section = calls.length;
    const { page, context } = await openLeft(width, height, touch);
    await page.waitForTimeout(1500);
    emit("team-changed", null);
    await waitFor(page, () => since(section, "team_list").length > 1, "the roster read again");
    await page.waitForTimeout(1500);
    const saved = savedLevels(section, left.id);
    assert.deepEqual(saved.filter((access) => access !== "read"), [], `an opened chat is saved at no level but its own: ${saved}`);
    assert.deepEqual(since(section, "chat_start"), [], "opening starts nothing");
    console.error(JSON.stringify({ section: "E", width, savesOfTheChat: saved.length }));
    await context.close();
  }

  /** The access picker of an ordinary chat: in the composer's bar where it
   *  fits, behind the settings sheet where it does not. */
  const inBar = (page) => page.locator('.picker-btn[class*="perm-"]').isVisible();
  const openAccessSheet = async (page) => {
    await page.locator(".settings-toggle").click();
    await page.locator(".sheet-link", { hasText: "Access" }).waitFor();
  };
  const shutSheet = async (page) => {
    await page.locator(".sheet-scrim").click({ position: { x: 8, y: 8 } });
    await page.locator(".sheet-scrim").waitFor({ state: "detached" });
  };
  const levelShown = async (page) => {
    if (await inBar(page)) return (await page.locator('.picker-btn[class*="perm-"]').innerText()).replace(/[▾\s]+$/, "").trim();
    await openAccessSheet(page);
    const shown = (await page.locator(".sheet-link", { hasText: "Access" }).locator(".sheet-link-value").innerText()).trim();
    await shutSheet(page);
    return shown;
  };
  const pickLevel = async (page, label) => {
    const bar = await inBar(page);
    if (bar) await page.locator('.picker-btn[class*="perm-"]').click();
    else {
      await openAccessSheet(page);
      await page.locator(".sheet-link", { hasText: "Access" }).click();
    }
    await page.getByRole("menuitem", { name: new RegExp(`^${label}\\b`) }).click();
    if (!bar) await shutSheet(page);
  };

  // G. Guards against a level event being listened to again: the person's
  //    pick is not overwritten by an older level (review 25fa12, R1). No host
  //    sends `chat-access-changed`; the frames below are strays sent on
  //    purpose. An ordinary chat runs at Auto; the person picks Plan; an
  //    older `chat-access-changed` naming Auto arrives while that request is
  //    in the air and again after it, and so does a chat-list answer naming
  //    Auto; the process ends; the person sends. The page listens for no such
  //    event, so the picker stays on Plan and the next process is asked read.
  for (const [width, height, touch] of sizes) {
    seq = 3;
    const section = calls.length;
    const key = `chat:${plain.id}`;
    const { page, context } = await open(width, height, touch, { hash: `#/p/starfall/c/${plain.id}`, index: [plain], stray: "auto" });
    await page.locator(".msg").filter({ hasText: "two dead targets" }).first().waitFor();
    assert.equal(await page.locator(".composer-identity-name").count(), 0, "an ordinary chat: no agent's name on the composer");
    assert.equal(await levelShown(page), "Auto", "the chat opens at the level it was saved at");

    // Running at Auto.
    let mark = calls.length;
    await page.locator("textarea").fill("Run the build");
    await page.locator("button.send").click();
    const [first] = await waitFor(page, () => since(mark, "chat_start").length && since(mark, "chat_start"), "chat_start");
    assert.equal(first.key, key);
    assert.equal(first.access, "auto");
    answer(key, first, "The build passes.");
    await page.locator(".msg").filter({ hasText: "The build passes." }).first().waitFor();

    // The person picks Plan. The mocked host sends the older frame ahead of
    // its answer (`resultFor`), then again, then a chat list still at Auto.
    mark = calls.length;
    await pickLevel(page, "Plan");
    const [picked] = await waitFor(page, () => since(mark, "chat_set_access").length && since(mark, "chat_set_access"), "the person's chat_set_access");
    assert.deepEqual(picked, { key, access: "read" });
    emit("chat-access-changed", { chatKey: key, access: "auto" });
    emit("chat-index-changed", { id: plain.id, gone: false });
    await waitFor(page, () => since(mark, "chat_index_list").length, "the chat list read again");
    await page.waitForTimeout(1200);
    assert.equal(await levelShown(page), "Plan", "the picker keeps the level the person picked");
    await noSidewaysScroll(page, width);
    await page.screenshot({ path: join(artifacts, `picked-plan-${width}.png`) });

    // The process ends, and the person sends: the next one is asked read.
    emit("chat-status", { key, kind: "exit", text: "", code: 0 });
    await page.waitForTimeout(500);
    mark = calls.length;
    await page.locator("textarea").fill("Now plan the release");
    await page.locator("button.send").click();
    const [next] = await waitFor(page, () => since(mark, "chat_start").length && since(mark, "chat_start"), "the next chat_start");
    assert.equal(next.key, key);
    assert.equal(next.access, "read", "the next process is asked the level the person picked");
    assert.equal(await levelShown(page), "Plan", "and the picker still says Plan");
    assert.deepEqual(since(section, "chat_set_access"), [{ key, access: "read" }], "one switch: the person's");
    await context.close();
  }

  // Over the whole run.
  assert.deepEqual(calls.filter((call) => call.cmd === "handover_discuss"), [], "handover_discuss is never sent");
  assert.deepEqual(
    calls.filter((call) => call.cmd === "chat_set_access").map((call) => call.args),
    sizes.map(() => ({ key: `chat:${plain.id}`, access: "read" })),
    "the only level switched is the one the person picked (G)",
  );
  const readStarts = calls.filter((call) => call.cmd === "chat_start" && call.args.access === "read");
  const own = [`chat:${left.id}`, `chat:${plain.id}`];
  for (const key of own) {
    assert.equal(readStarts.filter((call) => call.args.key === key).length, sizes.length, `${key} is started at read once per width`);
  }
  assert(readStarts.some((call) => deskKeys.has(call.args.key))
    && readStarts.every((call) => deskKeys.has(call.args.key) || own.includes(call.args.key)),
    `only the front desk's own chat, the chat saved at read (D) and the chat the person put on Plan (G) start at read: ${readStarts.map((call) => call.args.key)}`);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, mockedBackend: true, widths: sizes.map(([width]) => width), artifacts }));
} catch (error) {
  const page = await shown?.locator("body").innerText().catch(() => "");
  await shown?.screenshot({ path: join(artifacts, "failure.png") }).catch(() => {});
  console.error(JSON.stringify({ error: String(error), errors, page: page?.slice(0, 1500), artifacts }));
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
