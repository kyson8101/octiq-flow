// App-shell regression for Claude classifier-outage cards (feedback
// 664f03c0). The socket is mocked; everything else is the real App: the cards
// come in through `safety_block_pending` on connect and `safety-blocked`
// events, exactly as the server sends them.
//
// "Outage worker" holds one outage card that grows while the page is open
// (the server re-announces the same card id with a higher count). "Deploy
// worker" holds an ordinary Claude safety refusal, which must look exactly as
// it did before outages had a card of their own.
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const artifacts = process.env.OCTIQ_EVIDENCE_DIR
  || await mkdtemp(join(tmpdir(), "octiq-outage-card-"));
await mkdir(artifacts, { recursive: true });

const now = Date.now();
const chat = (id, title, updated) => ({
  id, projectId: "general", title, customTitle: true, modelId: "claude:model:claude-opus-5-5", access: "auto",
  sessionId: `session-${id}`, createdAt: now - 90_000, updatedAt: now - updated, readAt: now,
});
const chats = [chat("outage", "Outage worker", 10_000), chat("deploy", "Deploy worker", 20_000)];

// The server's words, verbatim (`safety_block::outage_guidance`).
const GUIDANCE = "Claude's safety check was unavailable, so the command did not run. It was not judged unsafe, and it was not approved. Continue with your other steps. OctiqFlow never re-runs it. You may try the same command once more, as-is: Claude checks that try again. If it is refused again, do not try it a third time. Never reword a command to get past the check. Report every refused command in your worker report, and do not describe any of them as approved or as having run.";
const MESSAGE = "The server-side auto mode classifier gave no verdict (error), so auto mode cannot determine the safety of Bash. This is a transient failure of the check, not a judgment about the action: a later response may get a verdict.";
const outageCard = (commands) => {
  const count = commands.reduce((sum, c) => sum + c.count, 0);
  const calls = Array.from({ length: count }, (_, i) => `toolu_0${i + 1}`).join(", ");
  return {
    id: "group-1", chatKey: "chat:outage", kind: "outage", provider: "claude",
    title: "Claude's safety check was unavailable", summary: "Classifier unavailable",
    detail: `${MESSAGE}\n\nTool calls: ${calls}`, action: commands.at(-1).action,
    count, commands, guidance: GUIDANCE,
  };
};
const safetyCard = {
  id: "safety-1", chatKey: "chat:deploy", kind: "high-risk-action", provider: "claude",
  title: "Claude's auto mode blocked an action", summary: "Production Deploy",
  detail: "Permission for this action was denied by the Claude Code auto mode classifier.\n\nTool call: toolu_deploy",
  action: "eas update --branch production --message 'OTA 1.4.2'",
};
let pendingCards = [
  outageCard([{ action: "git fetch origin", count: 2 }, { action: "cat POLICY.md", count: 1 }]),
  safetyCard,
];

const logs = new Map();
const record = (key, event) => {
  const log = logs.get(key) ?? [];
  log.push({ seq: log.length + 1, event });
  logs.set(key, log);
};
for (const { id, title } of chats) {
  record(`chat:${id}`, { type: "user", uuid: `u-${id}`, octiq_user_turn: true, message: { content: [{ type: "text", text: `Start: ${title}` }] } });
  record(`chat:${id}`, { type: "assistant", message: { content: [{ type: "text", text: `${title}: checking the repository first.` }] } });
  record(`chat:${id}`, { type: "result", subtype: "success", result: "ok" });
}

const calls = [];
const errors = [];
let appSocket;
const server = await createServer({
  root: new URL("../web", import.meta.url).pathname,
  configFile: new URL("../web/vite.config.ts", import.meta.url).pathname,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
function resultFor(request) {
  switch (request.cmd) {
    case "list_workspaces": return [{ id: "general", name: "General", primary_path: "/Users/kyson/General" }];
    case "chat_index_list": return chats;
    case "chat_index_deleted": return [];
    case "chat_page": return { events: logs.get(request.args?.key) ?? [], context: [], before: null };
    case "chat_since": return (logs.get(request.args?.key) ?? []).filter((frame) => frame.seq > (request.args?.after ?? 0));
    case "chat_list": return [];
    case "chat_activity": return [];
    case "chat_queue_state": return { live: false, queuedTurnIds: [] };
    case "orchestration_snapshot": return { runs: [], tasks: [], attempts: [], gates: [], messages: [] };
    case "permission_pending": return [];
    case "question_pending": return [];
    case "safety_block_pending": return pendingCards;
    case "safety_block_dismiss":
      pendingCards = pendingCards.filter((card) => card.id !== request.args?.id);
      return true;
    case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
    case "usage_summary": return {};
    case "agent_installs": return [{ id: "codex", installed: true, path: "/mock/codex" }, { id: "claude", installed: true, path: "/mock/claude" }];
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
const cards = (page) => page.locator("#dock .safety-card");
async function eventually(read, expected, what) {
  let last;
  for (let i = 0; i < 80; i += 1) {
    last = await read();
    if (last === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(last)}`);
}
const step = (name) => console.error(`[outage-card] ${name}`);
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
/** Screenshot the card itself, and the whole page for context. */
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
      socket.send(JSON.stringify({ t: "reply", id: request.id, ok: true, result: resultFor(request) }));
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(180_000);
  page.on("pageerror", (error) => errors.push(error.stack ?? String(error)));
  const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await rowButton(page, "Outage worker").waitFor({ timeout: 180_000 });

  // 1. The outage card: its own title and words, the commands listed once
  //    each with a count, and only details + dismiss.
  step("1 outage card, desktop");
  await rowButton(page, "Outage worker").click();
  const outage = cards(page).filter({ hasText: "safety check was unavailable" });
  await outage.waitFor();
  assert.equal(await cards(page).count(), 1, "one card for the group");
  const text = await outage.innerText();
  assert.match(text, /Claude's safety check was unavailable/);
  assert.match(text, /3 refused/);
  assert.match(text, /Nothing was judged unsafe/);
  // The refused calls did not run; the same line may run on its one retry.
  assert.match(text, /These refused calls did not run\. Nothing was approved\./);
  assert.doesNotMatch(text, /None of these commands ran/);
  assert.match(text, /What it tried/i);
  assert.match(text, /×2/);
  assert.match(text, /What the agent was told/i);
  assert(text.includes(GUIDANCE), "the server's guidance, word for word");
  assert.doesNotMatch(text, /blocked an action|Why it was blocked|Manual command approval|Use safer approach/i);
  // Retry once, details, dismiss. This card names no rule and no settings
  // file, so it offers no "Always allow" (test-outage-recovery.mjs has one).
  assert.doesNotMatch(text, /Always allow/i);
  assert.equal(await outage.locator("button").count(), 3);
  assert.match(text, /Retry once/);
  assert(await noSideScroll(page));
  // The chat list: an outage has nothing to review, a safety refusal does.
  const badge = (label, title) => page.locator(`.sidebar .pending-action-badge[aria-label^="${label} for ${title}:"]`);
  await badge("Safety check was down", "Outage worker").waitFor();
  await badge("Review needed", "Deploy worker").waitFor();
  assert.equal(await badge("Review needed", "Outage worker").count(), 0, "an outage is not 'Review needed'");
  await shoot(page, outage, "desktop-outage-3");

  // 2. Another refusal joins the group: the same card, one more count, and
  //    the new line collapsed into the list.
  step("2 the group grows live");
  pendingCards = [outageCard([{ action: "git fetch origin", count: 2 }, { action: "cat POLICY.md", count: 1 }, { action: "ls docs", count: 1 }]), safetyCard];
  send("safety-blocked", pendingCards[0]);
  await eventually(async () => (await outage.innerText()).includes("4 refused"), true, "count grows");
  assert.equal(await cards(page).count(), 1, "still one card");
  await outage.getByRole("button", { name: "Technical details" }).click();
  await eventually(async () => (await outage.innerText()).includes("toolu_01, toolu_02, toolu_03, toolu_04"), true, "details");
  await shoot(page, outage, "desktop-outage-4-details");
  await outage.getByRole("button", { name: "Hide technical details" }).click();

  // 3. The ordinary safety card is unchanged.
  step("3 safety card, desktop");
  await rowButton(page, "Deploy worker").click();
  const safety = cards(page).filter({ hasText: "blocked an action" });
  await safety.waitFor();
  const safetyText = await safety.innerText();
  assert.match(safetyText, /Why it was blocked/i);
  assert.match(safetyText, /Production Deploy/);
  assert.match(safetyText, /eas update --branch production/);
  assert.match(safetyText, /Use safer approach/);
  assert.match(safetyText, /Manual command approval/);
  assert.doesNotMatch(safetyText, /safety check was unavailable|once more/);
  await shoot(page, safety, "desktop-safety");

  // 4. Phone width, both cards.
  step("4 phones");
  await page.setViewportSize({ width: 390, height: 844 });
  await safety.waitFor();
  assert(await noSideScroll(page), "no sideways scroll at 390px (safety)");
  await shoot(page, safety, "phone-safety");
  await page.goto(`${base}#/c/outage`, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.goto("about:blank");
  await page.goto(`${base}#/c/outage`, { waitUntil: "domcontentloaded" });
  await outage.waitFor({ timeout: 180_000 });
  assert(await noSideScroll(page), "no sideways scroll at 390px (outage)");
  const box = await outage.boundingBox();
  assert(box && box.width <= 390, `card fits: ${JSON.stringify(box)}`);
  await shoot(page, outage, "phone-outage-4");

  // 5. One dismiss closes the whole group, and nothing else is asked.
  step("5 dismiss");
  await outage.getByRole("button", { name: "Dismiss" }).click();
  await eventually(() => outage.count(), 0, "group gone");
  const answered = calls.filter(({ cmd }) => /safety_block/.test(cmd) && cmd !== "safety_block_pending");
  assert.deepEqual(answered.map(({ cmd, args }) => [cmd, args?.id]), [["safety_block_dismiss", "group-1"]]);
  assert.equal(calls.filter(({ cmd }) => /chat_send|chat_start/.test(cmd)).length, 0, "dismiss sends the agent nothing");

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, artifacts }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
