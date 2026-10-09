// App-shell regression for a front-desk route that a writer kept from
// opening: the card offers "Discuss only (read-only)" beside Try again and
// Give up, and choosing it sends `handover_discuss` and lands the person in
// the chat it opened, read-only. Also: a route the front desk proposed as a
// discussion asks "Discuss with …?". The socket is mocked: no message reaches
// a live agent, and the host's answers are stand-ins. Every interaction goes
// through App.tsx, the Composer and the card.
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
const desk = agent("desk", "Front desk", { projectId: undefined, model: "haiku", effort: "low", access: "read" });
const roster = [agent("potato", "Potato Juice", { projectId: undefined }), desk, agent("lead", "STAR LEAD")];
const workspaces = [
  { id: "general", name: "General", primary_path: "/mock/General" },
  { id: "starfall", name: "starfall", primary_path: "/mock/Starfall" },
];
const WRITER = "This checkout has an active writer for task Starfall 30s 战斗短片:storyboard → 作者确认 → 生成. Wait or use a separate worktree.";
const BRIEF = "The person wants to discuss the Starfall 小剧场 series: brainstorm new ideas, not start work.";
const NOTE = "This chat is a discussion, not a task: it is read-only, so read whatever helps the conversation and change nothing.";
const routed = { id: "routed-1", projectId: "starfall", title: "Discuss the Starfall 小剧场 series", modelId: "claude:opus", access: "read", createdAt: now, updatedAt: now };
const routeRecord = (sourceChatKey, extra = {}, route = {}) => ({
  kind: "route",
  id: "handover_route1",
  sourceChatKey,
  sourceTitle: "",
  sourceProject: "",
  from: { agentId: "desk", name: "Front desk" },
  to: { agentId: "lead", name: "STAR LEAD" },
  settings: { agent: "claude", model: "opus", effort: "high", access: "auto" },
  destination: { projectId: "starfall", projectName: "starfall", repository: "/mock/Starfall" },
  workspace: { mode: "folder", path: "/mock/Starfall", chosen: "new" },
  brief: { objective: BRIEF },
  route: { message: `${BRIEF}\n\n(Opened by Front desk, the person's front desk, once the person confirmed it.)`, ...route },
  status: "pending",
  createdAt: now,
  notice: "pending",
  ...extra,
});
const frames = (key) => key === `chat:${routed.id}` ? [
  { seq: 1, event: { type: "user", uuid: "octiq-handover-route1-start", octiq_user_turn: true, message: { content: [{ type: "text", text: `${BRIEF}\n${NOTE}\n\n=== OctiqFlow agents mode ===\nLead: STAR LEAD` }] } } },
  { seq: 2, event: { type: "assistant", message: { id: "m-routed", role: "assistant", content: [{ type: "text", text: "Happy to brainstorm. Which episode should we start from?" }] } } },
  { seq: 3, event: { type: "result", subtype: "success", result: "Happy to brainstorm. Which episode should we start from?" } },
] : [];

const calls = [];
const errors = [];
const sockets = new Set();
let opened = false;
let deskKey = "";
const server = await createServer({
  root: new URL("../web", import.meta.url).pathname,
  configFile: new URL("../web/vite.config.ts", import.meta.url).pathname,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

function resultFor(request) {
  const args = request.args ?? {};
  switch (request.cmd) {
    case "list_workspaces": return workspaces;
    case "chat_index_list": return opened ? [routed] : [];
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
    case "git_status": return { branch: "", files: [] };
    case "git_local_branches": return { is_repo: false, current: "", branches: [], is_worktree: false };
    case "agent_installs": return [{ id: "claude", installed: true, path: "/mock/claude" }];
    case "agent_history_list": return [];
    case "team_list": return args.all ? roster : roster.filter((a) => !a.projectId || a.projectId === args.projectId);
    case "team_head": return roster[0];
    case "team_front_desk": return desk;
    case "team_leads": return opened ? [{ chatKey: `chat:${routed.id}`, leadId: "lead", leadName: "STAR LEAD", projectId: "starfall", createdAt: now }] : [];
    case "team_home": return "general";
    case "agent_team_list": return [];
    case "team_brief": return `${args.task}\n\n=== OctiqFlow agents mode ===\nFront desk: Front desk`;
    case "handover_list": return [];
    case "handover_confirm":
      // Trying again as it is meets the same writer.
      throw new Error(WRITER);
    case "handover_discuss":
      opened = true;
      return routeRecord(deskKey, {
        status: "confirmed", targetChatKey: `chat:${routed.id}`, decidedAt: Date.now(),
        settings: { agent: "claude", model: "opus", effort: "high", access: "read" },
      }, { discuss: true, message: `${BRIEF}\n${NOTE}\n\n(Opened by Front desk, the person's front desk, once the person confirmed it.)` });
    // A plain folder, as Starfall is: nothing to branch, the folder itself.
    case "git_prepare_chat_workspace":
      return { cwd: args.path, branch: "", is_repo: false, is_worktree: false };
    // The host's guard: only a chat that could write meets the writer.
    case "chat_start":
      if (args.access !== "read") throw new Error(WRITER);
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

let browser;
try {
  await server.listen();
  browser = await engine.launch({ headless: true });
  const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
  const open = async (width, height, touch) => {
    sockets.clear();
    opened = false;
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
    await page.goto(`${base}#/p/starfall`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Talk to Front desk", exact: true }).waitFor();
    return { page, context };
  };
  const sizes = [[375, 667, true], [1440, 960, false]];

  // A. Through the front desk.
  for (const [width, height, touch] of sizes) {
    const { page, context } = await open(width, height, touch);
    const mark = calls.length;
    await page.locator("textarea").fill("i want to discuss about Starfall 小剧场 series");
    await page.locator("button.send").click();
    const [start] = await waitFor(page, () => since(mark, "chat_start").length && since(mark, "chat_start"), "chat_start");
    deskKey = start.key;
    [
      { type: "system", subtype: "init", session_id: "desk-session" },
      { type: "user", isReplay: true, uuid: "echo-desk-1", octiq_user_turn_id: start.turnId, message: { role: "user", content: [{ type: "text", text: start.prompt }] } },
      { type: "assistant", message: { id: "m-desk", role: "assistant", content: [{ type: "text", text: "STAR LEAD fits. I've put up a card for a discussion with them." }] } },
      { type: "result", subtype: "success", result: "STAR LEAD fits. I've put up a card for a discussion with them." },
    ].forEach((event, index) => emit("chat-event", { key: deskKey, seq: index + 1, event }));

    // 1. Proposed as a discussion: the card says so before anything opens.
    emit("handover-changed", routeRecord(deskKey, { settings: { agent: "claude", model: "opus", effort: "high", access: "read" } }, { discuss: true }));
    const card = page.locator('[data-kind="route"]');
    await card.waitFor();
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    assert.match(await card.innerText(), /Discuss with STAR LEAD\?/);
    assert.match(await card.innerText(), /starfall · discussion, read-only/);
    await card.getByRole("button", { name: "Discuss with STAR LEAD" }).waitFor();
    await page.screenshot({ path: join(artifacts, `discussion-card-${width}.png`) });

    // 2. A work route the writer kept from opening (the reported case).
    emit("handover-changed", routeRecord(deskKey, {
      id: "handover_route1", status: "starting", targetChatKey: `chat:${routed.id}`, error: WRITER, abandonable: true, decidedAt: Date.now(),
    }));
    await page.getByText("STAR LEAD's chat did not start").waitFor();
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const text = await card.innerText();
    assert.match(text, /active writer for task Starfall 30s/);
    assert.match(text, /No chat was opened\. Try again, open it read-only to discuss, or give up\./);
    for (const name of ["Try again", "Give up", "Discuss only (read-only)"]) {
      await card.getByRole("button", { name, exact: true }).waitFor();
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `no sideways scroll at ${width}`);
    await page.screenshot({ path: join(artifacts, `writer-blocked-card-${width}.png`) });

    // Try again as it is: the same refusal, the way out still offered.
    let before = calls.length;
    await card.getByRole("button", { name: "Try again", exact: true }).click();
    await waitFor(page, () => since(before, "handover_confirm").length, "handover_confirm");
    await card.getByRole("button", { name: "Discuss only (read-only)" }).waitFor();

    // 3. Discuss only: opens the chat read-only and goes into it.
    before = calls.length;
    await card.getByRole("button", { name: "Discuss only (read-only)" }).click();
    const [discussed] = await waitFor(page, () => since(before, "handover_discuss").length && since(before, "handover_discuss"), "handover_discuss");
    assert.deepEqual(discussed, { id: "handover_route1" });
    emit("chat-index-changed", { id: routed.id, gone: false });
    await waitFor(page, async () => (await page.evaluate(() => location.hash)).includes(routed.id), "navigation into the routed chat");
    await page.locator(".msg").filter({ hasText: "brainstorm new ideas" }).first().waitFor();
    await page.locator(".composer-identity-name", { hasText: "STAR LEAD" }).waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(artifacts, `discussion-opened-${width}.png`) });
    await context.close();
  }

  // B. Straight to the agent, with no front desk in between: the writer
  //    refuses its registered Auto, and the bubble offers read-only.
  for (const [width, height, touch] of sizes) {
    const { page, context } = await open(width, height, touch);
    await page.getByRole("button", { name: "Talk to someone else" }).click();
    await page.getByRole("radio", { name: /STAR LEAD/ }).click();
    await page.getByRole("heading", { name: "Talk to STAR LEAD", exact: true }).waitFor();
    let mark = calls.length;
    await page.locator("textarea").fill("Let's brainstorm the next 小剧场 episode");
    await page.locator("button.send").click();
    const [first] = await waitFor(page, () => since(mark, "chat_start").length && since(mark, "chat_start"), "chat_start");
    assert.equal(first.access, "auto", "the agent's registered level is tried first");
    const bubble = page.locator(".message-bubble").filter({ hasText: "brainstorm the next" });
    await bubble.getByText(WRITER).waitFor();
    const discuss = bubble.getByRole("button", { name: "Discuss read-only" });
    await discuss.waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `no sideways scroll at ${width}`);
    await page.screenshot({ path: join(artifacts, `direct-writer-blocked-${width}.png`) });
    mark = calls.length;
    await discuss.click();
    const [again] = await waitFor(page, () => since(mark, "chat_start").length && since(mark, "chat_start"), "read-only chat_start");
    assert.equal(again.access, "read", "sent again read-only");
    assert.equal(again.key, first.key, "the same conversation");
    assert.match(again.prompt, /brainstorm the next 小剧场 episode/);
    await page.getByText("Opened read-only to discuss").first().waitFor();
    // The refused bubble is gone; one bubble, waiting on the agent.
    assert.equal(await page.locator(".message-bubble").filter({ hasText: "brainstorm the next" }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "Discuss read-only" }).count(), 0);
    const saved = since(mark, "chat_index_save").map((a) => a.meta?.access).filter(Boolean);
    assert(saved.every((access) => access === "read"), `index saved read-only: ${saved}`);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(artifacts, `direct-discussion-${width}.png`) });
    await context.close();
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
