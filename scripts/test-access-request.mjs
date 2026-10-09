// App-shell regression for the access card: an agent asks the person to
// raise its chat's access. The socket is mocked; everything else is the real
// App. The host's cards come in through `access_request_pending` on connect
// and `access-request` events, as the server sends them; the Antigravity one
// is drawn from a refused turn in the chat's own transcript.
//
// What must hold: only the person's click changes a level, through the same
// `chat_set_access` the access picker sends; the host's card is answered only
// after that has worked; a decline changes nothing; a raise the agent cannot
// take yet leaves the card up with the reason.
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const artifacts = process.env.OCTIQ_EVIDENCE_DIR
  || await mkdtemp(join(tmpdir(), "octiq-access-request-"));
await mkdir(artifacts, { recursive: true });

const now = Date.now();
const chat = (id, title, modelId, updated) => ({
  id, projectId: "general", title, customTitle: true, modelId, access: "read",
  sessionId: `session-${id}`, createdAt: now - 90_000, updatedAt: now - updated, readAt: now,
});
const CLAUDE = "claude:model:claude-opus-5-5";
const chats = [
  chat("fix", "Fix chat", CLAUDE, 10_000),
  chat("docs", "Docs chat", CLAUDE, 20_000),
  chat("agy", "Agy chat", "antigravity:gemini-3-8-flash-high", 30_000),
];

// What the host announces (`access_request::Asked`), field for field.
const asked = (id, chatId, over = {}) => ({
  id, chatKey: `chat:${chatId}`, agent: "claude", current: "read", requested: "edits",
  reason: "Write the fix to src/lib/chat.ts.", takes: "now", wait: true, answerWithinSecs: 180, ...over,
});
let pending = [asked("r-fix", "fix")];

const logs = new Map();
const record = (key, event) => {
  const log = logs.get(key) ?? [];
  log.push({ seq: log.length + 1, event });
  logs.set(key, log);
};
for (const id of ["fix", "docs"]) {
  record(`chat:${id}`, { type: "user", uuid: `u-${id}`, octiq_user_turn: true, message: { content: [{ type: "text", text: "Fix the bug." }] } });
  record(`chat:${id}`, { type: "assistant", message: { content: [{ type: "text", text: "I need to change a file for that." }] } });
}
// A turn Antigravity ended on a refused write, as the host records it
// (`mark_refusal_access` stamps the level).
record("chat:agy", { type: "user", uuid: "u-agy", octiq_user_turn: true, message: { content: [{ type: "text", text: "Create notes.txt" }] } });
record("chat:agy", { event: "step_update", step_update: { step_type: "user_input", state: "DONE", step_index: 0 }, octiq_user_turn_id: "u-agy" });
record("chat:agy", { event: "step_update", step_update: { step_type: "tool", state: "DONE", step_index: 1, tool_info: { name: "write_to_file", parameters: { TargetFile: "notes.txt" } } } });
record("chat:agy", { event: "step_update", step_update: { step_type: "agent_response", state: "DONE", step_index: 2, text_delta: "I could not write the file." } });
record("chat:agy", {
  event: "result", result: { status: "SUCCESS", denied_actions: [{ action: "write_file", display_name: "WriteToFile" }] },
  octiq_access: "read",
});

const calls = [];
const errors = [];
let refuseAgyOnce = true;
let appSocket;
const server = await createServer({
  root: new URL("../web", import.meta.url).pathname,
  configFile: new URL("../web/vite.config.ts", import.meta.url).pathname,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
function answer(request) {
  switch (request.cmd) {
    case "list_workspaces": return [{ id: "general", name: "General", primary_path: "/Users/kyson/General" }];
    case "chat_index_list": return chats;
    case "chat_index_deleted": return [];
    case "chat_page": return { events: logs.get(request.args?.key) ?? [], context: [], before: null };
    case "chat_since": return (logs.get(request.args?.key) ?? []).filter((frame) => frame.seq > (request.args?.after ?? 0));
    // All three agents are running, so a raise goes to the agent.
    case "chat_list": return chats.map((c) => `chat:${c.id}`);
    case "chat_activity": return [];
    case "chat_queue_state": return { live: true, queuedTurnIds: [] };
    case "orchestration_snapshot": return { runs: [], tasks: [], attempts: [], gates: [], messages: [] };
    case "permission_pending": return [];
    case "question_pending": return [];
    case "safety_block_pending": return [];
    case "access_request_pending": return pending;
    case "access_request_answer":
      pending = pending.filter((card) => card.id !== request.args?.id);
      return true;
    case "chat_set_access":
      if (request.args?.key === "chat:agy" && refuseAgyOnce) {
        refuseAgyOnce = false;
        throw new Error("Antigravity takes a new access level between turns. Wait for this turn or stop it, then change the access.");
      }
      return null;
    case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
    case "usage_summary": return {};
    case "agent_installs": return ["codex", "claude", "antigravity"].map((id) => ({ id, installed: true, path: `/mock/${id}` }));
    case "team_list": return [];
    case "team_leads": return [];
    case "chat_task": return { chatId: request.args?.chatId, projectId: "general" };
    case "sandbox_snapshot": return { defaultEnabled: false, environments: {} };
    case "codex_skills": return [];
    case "git_status": return { branch: "main", files: [] };
    default: return null;
  }
}
const send = (event, payload) => appSocket?.send(JSON.stringify({ t: "event", event, payload }));
const rowButton = (page, title) => page.locator(".sidebar .chat-btn").filter({ has: page.locator(".chat-title", { hasText: title }) });
const cards = (page) => page.locator(".access-card");
const answered = () => calls.filter(({ cmd }) => cmd === "chat_set_access" || cmd === "access_request_answer")
  .map(({ cmd, args }) => [cmd, args?.key ?? args?.id, args?.access ?? args?.decision]);
async function eventually(read, expected, what) {
  let last;
  for (let i = 0; i < 100; i += 1) {
    last = await read();
    if (JSON.stringify(last) === JSON.stringify(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(last)}`);
}
const step = (name) => console.error(`[access-request] ${name}`);
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
async function shoot(page, card, name) {
  await card.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.getAnimations().length === 0).catch(() => {});
  await card.screenshot({ path: join(artifacts, `${name}-card.png`) });
  await page.screenshot({ path: join(artifacts, `${name}-page.png`) });
}

let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await context.addInitScript(() => {
    if (location.protocol === "about:") return;
    localStorage.setItem("octiq.v2.gitColumn", "0");
  });
  await context.route("**/token", (route) => route.fulfill({ body: "mock-token" }));
  await context.route("**/auth", (route) => route.fulfill({ body: "ok" }));
  await context.routeWebSocket(/.*/, (socket) => {
    appSocket = socket;
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw));
      if (request.t !== "invoke") return;
      calls.push(request);
      try {
        socket.send(JSON.stringify({ t: "reply", id: request.id, ok: true, result: answer(request) }));
      } catch (error) {
        socket.send(JSON.stringify({ t: "reply", id: request.id, ok: false, error: error.message }));
      }
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(180_000);
  page.on("pageerror", (error) => errors.push(error.stack ?? String(error)));
  const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await rowButton(page, "Fix chat").waitFor({ timeout: 180_000 });

  // 1. The host's card, refilled on connect: both levels in Claude's words,
  //    the reason, and the deadline. The row is badged like a permission.
  step("1 the agent's card");
  await page.locator('.sidebar .pending-action-badge[aria-label*="Fix chat"]').waitFor();
  await rowButton(page, "Fix chat").click();
  const fix = cards(page).filter({ hasText: "Write the fix" });
  await fix.waitFor();
  const text = await fix.innerText();
  assert.match(text, /Raise this chat's access to Accept edits\?/);
  assert.match(text, /Now\s+Plan/i);
  assert.match(text, /Asked for\s+Accept edits/i);
  assert.match(text, /none within three minutes leaves the level as it is/);
  assert.deepEqual(answered(), [], "nothing changes before the click");
  assert(await noSideScroll(page));
  await shoot(page, fix, "desktop-claude");

  // 2. Raise: the picker's change first, then the card's answer.
  step("2 raise");
  await fix.getByRole("button", { name: "Raise to Accept edits" }).click();
  await eventually(() => fix.count(), 0, "card gone");
  assert.deepEqual(answered(), [["chat_set_access", "chat:fix", "edits"], ["access_request_answer", "r-fix", "raised"]]);

  // 3. A live card in another chat, declined: nothing changes.
  step("3 decline");
  pending = [...pending, asked("r-docs", "docs", { requested: "auto", reason: "Run the test suite." })];
  send("access-request", pending.at(-1));
  await rowButton(page, "Docs chat").click();
  const docs = cards(page).filter({ hasText: "Run the test suite." });
  await docs.waitFor();
  await docs.getByRole("button", { name: "Not now" }).click();
  await eventually(() => docs.count(), 0, "declined card gone");
  assert.deepEqual(answered().slice(2), [["access_request_answer", "r-docs", "declined"]]);

  // 4. Antigravity's refused turn asks on the same card. Its first raise is
  //    refused (a turn still running): the card stays and says why. The
  //    second goes through, and no host card is answered for it.
  step("4 antigravity refusal");
  await rowButton(page, "Agy chat").click();
  const agy = cards(page).filter({ hasText: "Antigravity refused" });
  await agy.waitFor();
  const agyText = await agy.innerText();
  assert.match(agyText, /Raise this chat's access to Accept edits\?/);
  assert.match(agyText, /a file change \(write to file\) at Plan access/);
  assert.match(agyText, /applies from your next message/);
  assert.equal(await page.locator(".tool-card, [class*=tool]").filter({ hasText: "cannot ask anyone while it works, so no permission card" }).count(), 0,
    "the old warning row is gone");
  await shoot(page, agy, "desktop-antigravity");
  await agy.getByRole("button", { name: "Raise to Accept edits" }).click();
  await agy.locator(".access-card-error").filter({ hasText: "between turns" }).waitFor();
  assert.equal(await agy.count(), 1, "the card stays for another try");
  await shoot(page, agy, "desktop-antigravity-refused");
  await agy.getByRole("button", { name: "Raise to Accept edits" }).click();
  await eventually(() => agy.count(), 0, "covered, so gone");
  assert.deepEqual(answered().slice(3), [["chat_set_access", "chat:agy", "edits"], ["chat_set_access", "chat:agy", "edits"]]);

  // 5. Phone width.
  step("5 phone");
  pending = [asked("r-fix-2", "fix", { requested: "full", current: "edits", reason: "Install the toolchain system-wide." })];
  send("access-request", pending[0]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("about:blank");
  await page.goto(`${base}#/c/fix`, { waitUntil: "domcontentloaded" });
  const phone = cards(page).filter({ hasText: "toolchain" });
  await phone.waitFor({ timeout: 180_000 });
  assert.match(await phone.innerText(), /needs a fresh agent/);
  assert(await noSideScroll(page), "no sideways scroll at 390px");
  const box = await phone.boundingBox();
  assert(box && box.width <= 390, `card fits: ${JSON.stringify(box)}`);
  await shoot(page, phone, "phone-claude-bypass");

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, artifacts }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
