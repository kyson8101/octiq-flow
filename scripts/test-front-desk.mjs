// App-shell regression for the front desk on the new-chat screen, its
// confirm card, the chat it opens, and its row in Settings. The socket is
// mocked: no message reaches a live agent, and the host's answers (the
// front desk's brief, the route card, the confirm) are stand-ins. Every
// interaction still goes through App.tsx, the hero, the Composer, the card
// and Settings.
//
// At 375, 430 and 1440 wide it checks that a new chat opens on the front
// desk, that the full picker is one tap away ("Talk to someone else"), that
// Manage agents and Resume share one line, that the front-desk chat is never
// saved to the index or listed, that confirming the card goes into the chat
// it opened, and that Settings shows what the front desk runs on.
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const engine = playwright[process.env.PLAYWRIGHT_BROWSER || "chromium"];
const artifacts = process.env.OCTIQ_EVIDENCE_DIR || await mkdtemp(join(tmpdir(), "octiq-front-desk-"));
await mkdir(artifacts, { recursive: true });

const now = Date.now();
const agent = (id, name, extra) => ({
  id, name, role: `${name}'s role`, agent: "claude", model: "sonnet", effort: "medium", access: "auto",
  createdAt: now - 100_000, updatedAt: now - 100_000, projectId: "starfall", ...extra,
});
const desk = agent("desk", "Front desk", {
  projectId: undefined, model: "haiku", effort: "low", access: "read",
  role: "Listens to what the person wants, works out which registered agent should handle it and in which project, and opens a new chat with that agent carrying a short brief of the request. Only routes: it does no work itself.",
});
const roster = [
  agent("potato", "Potato Juice", { agent: "codex", model: "gpt-5.6-sol", projectId: undefined, role: "CTO across every project" }),
  desk,
  agent("canon", "STAR CANON 昭宁"),
  agent("aria", "STAR MUSIC Aria"),
  agent("relay", "STAR SOCIAL Relay"),
  agent("vesper", "STAR STORY Vesper", { role: "Starfall prose writer" }),
  agent("encore", "STAR VIDEO Encore"),
  agent("ampest", "STAR YT Ampest"),
];
const workspaces = [
  { id: "general", name: "General", primary_path: "/mock/General" },
  { id: "starfall", name: "starfall-novel", primary_path: "/mock/Starfall" },
];
const history = Array.from({ length: 24 }, (_, index) => ({
  agent: "claude", sessionId: `s${index}`, title: `Session ${index}`, cwd: "/mock/Starfall",
  startedAt: now - index * 60_000, updatedAt: now - index * 60_000,
}));
const BRIEF = "Draft chapter 3 of Starfall, \"The Crossing\". Keep Lyra's voice from chapter 2, about 3,000 words, and end on the bridge scene the person described.";
const routed = { id: "routed-1", projectId: "starfall", title: "Draft chapter 3 of Starfall", modelId: "claude:sonnet", access: "auto", createdAt: now, updatedAt: now };
const routeRecord = (sourceChatKey, extra = {}) => ({
  kind: "route",
  id: "handover_route1",
  sourceChatKey,
  sourceTitle: "",
  sourceProject: "",
  from: { agentId: "desk", name: "Front desk" },
  to: { agentId: "vesper", name: "STAR STORY Vesper" },
  settings: { agent: "claude", model: "sonnet", effort: "medium", access: "auto" },
  destination: { projectId: "starfall", projectName: "starfall-novel", repository: "/mock/Starfall" },
  workspace: { mode: "worktree", path: "/mock/Starfall", branch: "main", chosen: "new" },
  brief: { objective: BRIEF },
  route: {
    message: `${BRIEF}\n\nAttachments:\n- /home/.octiqflow/attachments/route-handover_route1/bridge-sketch.png (image)\n\n(Opened by Front desk, the person's front desk, once the person confirmed it.)`,
    attachments: [{ name: "bridge-sketch.png", path: "/home/.octiqflow/attachments/route-handover_route1/bridge-sketch.png", image: true }],
  },
  status: "pending",
  createdAt: now,
  notice: "pending",
  ...extra,
});

// The routed chat as the host started it: the brief as its first message
// (the lead brief after the mark is host context the page does not draw),
// and the agent's first answer.
const frames = (key) => key === `chat:${routed.id}` ? [
  { seq: 1, event: { type: "user", uuid: "octiq-handover-route1-start", octiq_user_turn: true, message: { content: [{ type: "text", text: `${routeRecord("").route.message}\n\n=== OctiqFlow agents mode ===\nLead: STAR STORY Vesper` }] } } },
  { seq: 2, event: { type: "assistant", message: { id: "m-routed", role: "assistant", content: [{ type: "text", text: "On it: drafting chapter 3 from the bridge scene." }] } } },
  { seq: 3, event: { type: "result", subtype: "success", result: "On it: drafting chapter 3 from the bridge scene." } },
] : [];

const calls = [];
const errors = [];
const sockets = new Set();
let confirmed = false;
const server = await createServer({
  root: new URL("../web", import.meta.url).pathname,
  configFile: new URL("../web/vite.config.ts", import.meta.url).pathname,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

function resultFor(request) {
  const args = request.args ?? {};
  switch (request.cmd) {
    case "list_workspaces": return workspaces;
    // The host never lists a front-desk chat; after the confirm the routed
    // chat is an ordinary one.
    case "chat_index_list": return confirmed ? [routed] : [];
    case "chat_index_deleted": return [];
    case "chat_page": return { events: frames(args.key), context: [], before: null };
    case "chat_since": return frames(args.key).filter((frame) => frame.seq > (args.after ?? 0));
    case "chat_list": return [];
    case "chat_queue_state": return { live: false, queuedTurnIds: [] };
    case "orchestration_snapshot": return { runs: [], tasks: [], attempts: [], gates: [], messages: [] };
    case "sandbox_snapshot": return { defaultEnabled: false, environments: {} };
    case "permission_pending": return [];
    case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
    case "usage_summary": return {};
    case "git_status": return { branch: "main", files: [] };
    case "git_local_branches": return { is_repo: true, current: "main", branches: ["main"], is_worktree: false };
    case "agent_installs": return [
      { id: "codex", installed: true, path: "/mock/codex" },
      { id: "claude", installed: true, path: "/mock/claude" },
    ];
    case "agent_history_list": return history;
    case "team_list": return args.all ? roster : roster.filter((a) => !a.projectId || a.projectId === args.projectId);
    case "team_head": return roster[0];
    case "team_front_desk": return desk;
    case "team_leads": return confirmed ? [{ chatKey: `chat:${routed.id}`, leadId: "vesper", leadName: "STAR STORY Vesper", projectId: "starfall", createdAt: now }] : [];
    case "team_home": return "general";
    case "agent_team_list": return [];
    case "team_brief": return `${args.task}\n\n=== OctiqFlow agents mode ===\nFront desk: Front desk`;
    case "handover_list": return [];
    case "handover_confirm":
      confirmed = true;
      return routeRecord(args.sourceChatKey ?? "", { status: "confirmed", targetChatKey: `chat:${routed.id}`, decidedAt: Date.now() });
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

async function layout(page) {
  return page.evaluate(() => {
    const rect = (el) => el && (({ top, bottom, left, right, width, height }) => ({ top, bottom, left, right, width, height }))(el.getBoundingClientRect());
    return {
      overflowX: document.documentElement.scrollWidth > innerWidth,
      toggle: rect(document.querySelector(".hero-roster-toggle")),
      list: rect(document.querySelector(".lead-picker-list")),
      manage: rect(document.querySelector(".hero-links > .hero-link")),
      resume: rect(document.querySelector(".hero-links > .resume-open")),
      composer: rect(document.querySelector("textarea")),
      chips: [...document.querySelectorAll(".lead-chip")].map((chip) => chip.querySelector(".lead-chip-name").textContent),
    };
  });
}

let browser;
try {
  await server.listen();
  browser = await engine.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
  const open = async (width, height, touch) => {
    confirmed = false;
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
        socket.send(JSON.stringify({ t: "reply", id: request.id, ok: true, result: resultFor(request) }));
      });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on("pageerror", (error) => errors.push(error.stack ?? String(error)));
    await page.goto(`${base}#/p/starfall`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Talk to Front desk", exact: true }).waitFor();
    return { page, context };
  };

  for (const [width, height, touch] of [[375, 667, true], [430, 932, true], [1440, 960, false]]) {
    sockets.clear();
    const { page, context } = await open(width, height, touch);
    await page.locator(".hero .resume-count").waitFor();
    await page.waitForTimeout(300);
    // 1. The new chat opens on the front desk; the full picker is not the page.
    let shot = await layout(page);
    await page.screenshot({ path: join(artifacts, `new-chat-${width}.png`) });
    assert.equal(shot.overflowX, false, `no sideways scroll at ${width}`);
    assert.equal(shot.list, null, `no picker list until asked for at ${width}`);
    assert(shot.toggle, `"Talk to someone else" at ${width}`);
    assert(Math.abs(shot.manage.top - shot.resume.top) < 2, `Manage agents and Resume on one line at ${width}`);
    assert(shot.resume.bottom <= shot.composer.top, `links above the composer at ${width}`);
    assert(shot.composer.bottom <= height, `composer on screen at ${width}`);
    // The line under the title is said to the person; the role, written
    // about the person, waits under Details.
    const welcome = page.locator(".agent-welcome-summary");
    assert.equal(await welcome.innerText(), "Tell me what you need and I'll open the right agent's chat.");
    assert.equal(await page.locator(".agent-welcome-role").isVisible(), false, `role hidden until Details at ${width}`);
    // A touch screen has no keyboard rule to state, and no face is left
    // alone on that line; a keyboard keeps both.
    const hint = await page.evaluate(() => {
      const said = document.querySelector(".composer-hint-said");
      const words = said.cloneNode(true);
      words.querySelectorAll(".composer-hint-avatar").forEach((face) => face.remove());
      return { avatars: said.querySelectorAll(".composer-hint-avatar").length, text: words.textContent.trim(), coarse: matchMedia("(pointer: coarse)").matches };
    });
    assert.equal(hint.coarse, touch, `pointer emulation at ${width}`);
    assert.deepEqual(
      { avatars: hint.avatars, text: hint.text },
      touch ? { avatars: 0, text: "" } : { avatars: 1, text: "Enter to send · Shift+Enter for a new line" },
      `idle hint line at ${width}`,
    );
    await page.screenshot({ path: join(artifacts, `new-chat-${width}.png`) });
    await page.getByRole("button", { name: "Details about Front desk" }).click();
    await page.locator(".agent-welcome-role").waitFor();
    assert.match(await page.locator(".agent-welcome-role").innerText(), /^Listens to what the person wants/);
    await page.screenshot({ path: join(artifacts, `new-chat-details-${width}.png`) });
    await page.getByRole("button", { name: "Details about Front desk" }).click();
    await page.locator(".agent-welcome-role").waitFor({ state: "hidden" });

    // 2. "Talk to someone else" opens the tidy list, without the front desk.
    await page.getByRole("button", { name: "Talk to someone else" }).click();
    await page.getByRole("radiogroup", { name: "Talk to someone else" }).waitFor();
    await page.waitForTimeout(300);
    shot = await layout(page);
    // The first row is whole and in view: a squeezed list scrolls from its
    // top, never spilling rows off where scrolling cannot reach.
    const firstRow = await page.evaluate(() => {
      const list = document.querySelector(".lead-picker-list").getBoundingClientRect();
      const row = document.querySelector(".lead-chip").getBoundingClientRect();
      return { list: list.top, row: row.top };
    });
    assert(firstRow.row >= firstRow.list - 0.5, `first row reachable at ${width}: ${JSON.stringify(firstRow)}`);
    assert.equal(shot.chips.length, roster.length - 1);
    assert(!shot.chips.includes("Front desk"), "the front desk is not in the list");
    assert(shot.list.bottom <= shot.composer.top, `list above the composer at ${width}`);
    assert(shot.composer.bottom <= height, `composer still on screen at ${width}`);
    assert.equal(shot.overflowX, false);
    await page.screenshot({ path: join(artifacts, `talk-to-someone-else-${width}.png`) });
    // Picking someone talks to them; "Back to Front desk" returns.
    await page.getByRole("radio", { name: /STAR STORY Vesper/ }).click();
    await page.getByRole("heading", { name: "Talk to STAR STORY Vesper", exact: true }).waitFor();
    await page.getByRole("button", { name: "Back to Front desk" }).click();
    await page.getByRole("heading", { name: "Talk to Front desk", exact: true }).waitFor();

    // 3. Talking to the front desk: the chat is never saved to the index.
    const mark = calls.length;
    await page.locator("textarea").fill("I need chapter 3 of Starfall drafted from the bridge scene");
    await page.locator("button.send").click();
    const [start] = await waitFor(page, () => since(mark, "chat_start").length && since(mark, "chat_start"), "chat_start");
    const deskKey = start.key;
    assert.deepEqual(since(mark, "team_brief").map(({ leadId }) => leadId), ["desk"]);
    assert.equal(start.model, "haiku", "the front desk's registered model");
    assert.equal(start.effort, "low");
    await page.waitForTimeout(1_200);
    const saved = since(mark, "chat_index_save").filter((a) => `chat:${a.meta?.id}` === deskKey);
    assert.deepEqual(saved, [], "a front-desk chat is never saved to the index");
    assert.equal(await page.locator(".chat-btn").count(), 0, "and never listed");

    // As Claude would: the message echoed back (so it reads as sent), the
    // front desk's one line, its full stop, and then the card it proposed.
    const said = [
      { type: "system", subtype: "init", session_id: "desk-session" },
      { type: "user", isReplay: true, uuid: "echo-desk-1", octiq_user_turn_id: start.turnId, message: { role: "user", content: [{ type: "text", text: start.prompt }] } },
      { type: "assistant", message: { id: "m-desk", role: "assistant", content: [{ type: "text", text: "That's STAR STORY Vesper's work in starfall-novel. I've put a card up to open a chat with them." }] } },
      { type: "result", subtype: "success", result: "That's STAR STORY Vesper's work in starfall-novel. I've put a card up to open a chat with them." },
    ];
    said.forEach((event, index) => emit("chat-event", { key: deskKey, seq: index + 1, event }));
    // 4. The front desk proposes a route: the card shows agent, project, brief.
    emit("handover-changed", routeRecord(deskKey));
    const card = page.locator('[data-kind="route"]');
    await card.waitFor();
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    assert.match(await card.innerText(), /Open a chat with STAR STORY Vesper\?/);
    assert.match(await card.innerText(), /starfall-novel · new worktree/);
    assert.match(await card.innerText(), /Keep Lyra's voice from chapter 2/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: join(artifacts, `confirm-card-${width}.png`) });

    // 5. Confirming opens the routed chat and lands the person in it.
    const before = calls.length;
    await card.getByRole("button", { name: "Open chat with STAR STORY Vesper" }).click();
    await waitFor(page, () => since(before, "handover_confirm").length, "handover_confirm");
    emit("chat-index-changed", { id: routed.id, gone: false });
    await waitFor(page, async () => (await page.evaluate(() => location.hash)).includes(routed.id), "navigation into the routed chat");
    // Its first message is the brief the card showed; its composer names
    // the routed agent, not the front desk's model.
    await page.locator(".msg").filter({ hasText: "Keep Lyra's voice from chapter 2" }).first().waitFor();
    await page.locator(".composer-identity-name", { hasText: "STAR STORY Vesper" }).waitFor();
    await page.waitForTimeout(300);
    const listed = await page.evaluate(() => [...document.querySelectorAll(".chat-btn")].map((b) => b.textContent));
    assert(!listed.some((text) => /bridge scene/.test(text ?? "") && !/Draft chapter 3/.test(text ?? "")), "the front-desk chat is not listed");
    await page.screenshot({ path: join(artifacts, `opened-chat-${width}.png`) });

    await context.close();

    // 6. Settings: the front desk and what it runs on. A fresh page, since
    //    this one now reopens the chat it was last in.
    const settings = await open(width, height, touch);
    await settings.page.getByRole("button", { name: "Manage agents", exact: true }).click();
    const block = settings.page.locator(".front-desk-block");
    await block.waitFor();
    await block.scrollIntoViewIfNeeded();
    await settings.page.waitForTimeout(300);
    assert.match(await block.innerText(), /Now Claude Haiku latest · low\. Used from the next new chat\./);
    assert.equal(await settings.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await settings.page.screenshot({ path: join(artifacts, `settings-front-desk-${width}.png`) });
    await settings.context.close();
  }

  for (const cmd of ["team_head_set", "team_save", "team_delete", "team_front_desk_set", "team_front_desk_create"]) {
    assert.equal(calls.filter((call) => call.cmd === cmd).length, 0, `${cmd} must not be called`);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, mockedBackend: true, artifacts }));
} catch (error) {
  console.error(JSON.stringify({ error: String(error), errors }));
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
