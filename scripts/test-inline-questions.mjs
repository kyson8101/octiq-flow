// App-shell check of the two things a reply can now hold besides prose: the
// agent's questions, drawn where they were asked, and a card diagram.
//
//   * a pending question is a block in the transcript at its `ask_user` call:
//     no card, the recommended option selected, `Other…` last, one button;
//     it never takes the focus; the button drops a held key and a press that
//     repeats the one made before the block arrived;
//   * the button sends `question_answer_batch` with one answer per question;
//     answered, the block is a quiet line and the answer is a bubble with no
//     controls, and a reload draws the same from the call's result;
//   * out of view, one row above the composer says `1 question waiting`;
//     pressing it goes to the block and puts the keyboard on its first control;
//   * a diagram's block is one quiet line while it is written and holds the
//     height of the rows written so far; closed, it is the diagram, with
//     nothing below it moving; a row's nodes stack under 480px;
//   * Windows: nothing widens the transcript, with a wider font and classic
//     scrollbars; a backslash path in a title is text.
//
// The socket is mocked; everything else is the real App and CSS.
//
//   OCTIQ_THEME=light|dark|fun|manga|guofeng   the appearance mode (dark)
//   WIDE_FONT=1            a wider font, standing in for a Windows fallback
//   CLASSIC_SCROLLBARS=1   Chromium's 15px classic scrollbars, as on Windows
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const webRoot = resolve(process.env.OCTIQ_WEB_ROOT || new URL("../web", import.meta.url).pathname);
const require = createRequire(join(webRoot, "package.json"));
const { createServer } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const wideFont = process.env.WIDE_FONT === "1";
const classic = process.env.CLASSIC_SCROLLBARS === "1";
const theme = process.env.OCTIQ_THEME || "dark";
const artifacts = process.env.OCTIQ_EVIDENCE_DIR || await mkdtemp(join(tmpdir(), "octiq-inline-questions-"));
await mkdir(artifacts, { recursive: true });
const tag = [theme, wideFont && "wide", classic && "classic"].filter(Boolean).join("-");

const now = Date.now();
const root = "/Users/kyson/03-projects/octiq-flow";
const ASK = "mcp__octiq__ask_user";

const SLEEP_Q = {
  question: "How many hours do you sleep on an average night?",
  options: [
    { label: "Under 5 hours" },
    { label: "5 to 6 hours", description: "Short of the seven hours an adult is advised to get" },
    { label: "6 to 7 hours" },
    { label: "Over 7 hours, but I go to bed late" },
  ],
  recommended: 1,
};
const BATCH = [
  { question: "Which checks should run before the merge?", options: ["Unit tests", "Type check", "Browser pass on Windows"], multiple: true, recommended: 0 },
  { question: "这个改动要不要同时更新 AGENTS.md 里关于提问卡片的段落，还是另开一个任务处理？", options: [{ label: "同时更新", description: "同一个提交里改，评审时一起看" }, { label: "另开任务" }] },
  { question: "What should the branch be called?" },
];
const DIAGRAM = {
  rows: [
    [{ title: "Too little sleep (5 to 6 hours)", note: "Tiredness builds up and makes a twitch more likely", icon: "moon" }],
    [
      { title: "Caffeine", note: "Can raise muscle excitability, and affects sleep", icon: "coffee" },
      { title: "Long screen time", note: "Eye strain, less blinking and dryness", icon: "screen" },
    ],
    [{ title: "Twitching of the lower left eyelid", note: "Fits the usual harmless eyelid myokymia", plain: true }],
  ],
};
const WIDE_DIAGRAM = {
  rows: [
    [{ title: "C:\\Users\\kyson\\03-projects\\octiq-flow", note: "The checkout the server was started in", icon: "folder" }],
    [
      { title: "睡眠不足（每天五到六小时），连续一周以上", note: "疲劳累积，增加眼皮跳动的可能性，也影响白天的注意力", icon: "moon" },
      { title: "Averyveryveryverylongunbrokenwordthatcannotwrapanywhereelse", icon: "code" },
      { title: "Server", icon: "server" },
      { title: "Database", note: "One file", icon: "database" },
    ],
    [{ title: "Done", icon: "check" }],
  ],
};
const fence = (value) => "```octiq-diagram\n" + JSON.stringify(value, null, 2) + "\n```";

const text = (value) => ({ kind: "text", text: value });
const call = (id, questions, result) => ({
  kind: "tool", id, name: ASK, argsJson: "{}",
  args: questions.length === 1 ? questions[0] : { questions },
  ...(result === undefined ? { state: "running" } : { state: "done", result }),
});
const you = (id, words) => ({ id, role: "user", streaming: false, echo: `echo-${id}`, turnId: `turn-${id}`, blocks: [text(words)] });
const agent = (id, blocks) => ({ id, role: "assistant", streaming: false, blocks });
const filler = (from, count) => Array.from({ length: count }, (_, i) => [
  you(`u${from + i}`, `Follow-up number ${i + 1}: and what about this other thing?`),
  agent(`a${from + i}`, [text(`Answer number ${i + 1}.\n\n` + "It runs to a few lines so the transcript is taller than the window. ".repeat(6))]),
]).flat();

/** Each chat is one scene. */
const SCENES = {
  // A question that is waiting, at the call that asked it.
  ask: { messages: [you("u1", "My eyelid keeps twitching. What could it be?"), agent("a1", [text("One thing is worth confirming first.\n\nYou said you often stay up late, so I would like to know how much you actually sleep."), call("t-ask", [SLEEP_Q])])],
    questions: [{ id: "q1", ...SLEEP_Q }] },
  // The same call after the answer came back as its result: what a reload draws.
  answered: { messages: [you("u1", "My eyelid keeps twitching. What could it be?"), agent("a1", [text("One thing is worth confirming first."), call("t-ask", [SLEEP_Q], "5 to 6 hours"), text("Then sleep is the first thing to look at.")])], questions: [] },
  // Three questions of one call: a set, a one-of with a description, free text.
  batch: { messages: [you("u1", "Get this ready to merge."), agent("a1", [text("Three things before I go on."), call("t-batch", BATCH)])],
    questions: BATCH.map((q, i) => ({ id: `b${i + 1}`, batch: "batch-1", batchSize: 3, ...q })) },
  // Answers the host still lists: saved, on their way.
  saved: { messages: [you("u1", "Get this ready to merge."), agent("a1", [text("Three things before I go on."), call("t-batch", BATCH)])],
    questions: BATCH.map((q, i) => ({ id: `s${i + 1}`, batch: "batch-2", batchSize: 3, ...q, status: "saved", answer: ["Unit tests, Type check", "同时更新", "feature/inline-questions"][i] })) },
  // A question left behind by the turns that followed it.
  behind: { messages: [you("u1", "My eyelid keeps twitching."), agent("a1", [text("One thing first."), call("t-ask", [SLEEP_Q], "The questions are saved and still waiting for the user. End this turn without assuming an answer or repeating the questions. OctiqFlow will continue this conversation when the answers arrive."), text("I will carry on once you have answered.")]), ...filler(2, 4)],
    questions: [{ id: "q2", ...SLEEP_Q }] },
  // The same, so far back that its turn is behind "Load earlier messages":
  // the page does not draw that call, so the question is at the end.
  far: { messages: [you("u1", "My eyelid keeps twitching."), agent("a1", [text("One thing first."), call("t-ask", [SLEEP_Q], "The questions are saved and still waiting for the user. End this turn without assuming an answer or repeating the questions. OctiqFlow will continue this conversation when the answers arrive.")]), ...filler(2, 8)],
    questions: [{ id: "q3", ...SLEEP_Q }] },
  // A pending question with no call in the transcript the page holds.
  loose: { messages: [you("u1", "Carry on from yesterday."), agent("a1", [text("Picking it up.")])], questions: [{ id: "q9", question: "Rebase onto develop first?", options: ["Rebase", "Merge", "Leave it"] }] },
  // A question that arrives while the page is open.
  arrive: { messages: [you("u1", "Ship it?"), agent("a1", [text("Before I do."), call("t-arrive", [{ question: "Ship to production now?", options: ["Ship now", "Wait for the review"], recommended: 0 }])])], questions: [] },
  // A card diagram in a reply, an invalid one beside it, and one that has to wrap.
  diagram: { messages: [you("u1", "Why would these three affect each other?"), agent("a1", [text("**Why these three can affect each other**\n\n" + fence(DIAGRAM) + "\n\nStill, we cannot be sure that sleep is the only cause, because caffeine and dry eyes can each set off a twitch on their own.\n\n" + fence(WIDE_DIAGRAM) + "\n\nA block that is not a diagram stays a code block:\n\n```octiq-diagram\n{ \"rows\": [[{ \"title\": 7 }]] }\n```")])], questions: [] },
  // A reply that will be streamed in.
  stream: { messages: [you("u1", "Draw the flow.")], questions: [] },
};

const chatOf = (id) => ({
  id, projectId: "octiq", title: `Scene ${id}`, customTitle: true, modelId: "claude:opus", access: "auto",
  sessionId: `session-${id}`, cwd: root, createdAt: now - 3_000_000, updatedAt: now - 1_000,
});
const chats = Object.keys(SCENES).map(chatOf);
const localChats = chats.map((chat) => ({ ...chat, messages: SCENES[chat.id].messages }));
let pending = Object.entries(SCENES).flatMap(([id, scene]) => scene.questions.map((q) => ({ chatKey: `chat:${id}`, ...q })));

const calls = [];
let answerWith = () => ({ saved: true });
function resultFor(request) {
  calls.push({ cmd: request.cmd, args: request.args });
  switch (request.cmd) {
    case "list_workspaces": return [{ id: "octiq", name: "octiq-flow", primary_path: root }];
    case "chat_index_list": return chats;
    case "chat_index_deleted": return [];
    case "chat_page": return { events: [], context: [], before: null };
    case "question_pending": return pending;
    case "question_answer_batch": return answerWith(request.args);
    case "chat_list": case "chat_activity": case "permission_pending": case "access_request_pending":
    case "safety_block_pending": case "pr_repositories": case "codex_skills": case "team_list":
      return [];
    case "chat_queue_state": return { live: false, queuedTurnIds: [] };
    case "orchestration_snapshot": return { runs: [], tasks: [], attempts: [], gates: [], messages: [], notifications: [], reports: {} };
    case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
    case "usage_summary": return {};
    case "agent_installs": return [{ id: "claude", installed: true, path: "/mock/claude" }];
    case "agent_models": return { source: "mock", models: [] };
    case "pr_local_list": case "pr_remote_list": return { items: [], warnings: [] };
    case "sandbox_snapshot": return { defaultEnabled: false, environments: {} };
    case "git_status_summary": return [{ path: root, repo_root: root, is_repo: true, branch: "develop", changed: 0, ahead: 0, behind: 0 }];
    case "git_local_branches": return { is_repo: true, current: "develop", branches: ["develop"], is_worktree: false };
    case "chat_task": return { chatId: request.args?.chatId, projectId: "octiq" };
    default: return null;
  }
}

const server = await createServer({
  root: webRoot,
  configFile: join(webRoot, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
const errors = [];
const report = { artifacts, theme, wideFont, classic, sizes: {} };

async function open(browser, scene, { width, height, phone = false }) {
  const context = await browser.newContext({
    viewport: { width, height }, reducedMotion: "reduce",
    ...(phone ? { hasTouch: true, isMobile: true } : {}),
  });
  await context.addInitScript(({ stored, mode, wide }) => {
    localStorage.setItem("octiq.v2.gitColumn", "0");
    localStorage.setItem("octiq.theme", mode);
    localStorage.setItem("octiq.v2.theme", mode);
    localStorage.setItem("octiq.v2.conversations", JSON.stringify(stored));
    if (wide) addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = "*, *::before, *::after { font-family: Verdana, sans-serif !important; letter-spacing: 0.02em !important; }";
      document.head.append(style);
    });
  }, { stored: localChats, mode: theme, wide: wideFont });
  await context.route("**/token", (route) => route.fulfill({ body: "mock-token" }));
  await context.route("**/auth", (route) => route.fulfill({ body: "ok" }));
  const sockets = [];
  await context.routeWebSocket(/.*/, (socket) => {
    sockets.push(socket);
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw));
      if (request.t !== "invoke") return;
      socket.send(JSON.stringify({ t: "reply", id: request.id, ok: true, result: resultFor(request) }));
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  page.on("pageerror", (error) => errors.push(error.stack ?? String(error)));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/#/p/octiq-flow/c/${scene}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  await page.locator(".msgs-inner .msg").first().waitFor({ timeout: 180_000 });
  const send = (event, payload) => sockets.forEach((socket) => socket.send(JSON.stringify({ t: "event", event, payload })));
  return { context, page, send };
}

/** Nothing in the transcript is wider than it, and the page does not scroll
 *  sideways: a classic scrollbar would take room for either. */
async function fits(page, label) {
  const found = await page.evaluate(() => {
    const scroller = document.querySelector(".msgs");
    const inner = document.querySelector(".msgs-inner").getBoundingClientRect();
    const over = [...document.querySelectorAll(".qa-turn *, .dgm *, .dgm-pending, .qa-said, .msg-answer")]
      .filter((el) => { const box = el.getBoundingClientRect(); return box.width > 0 && (box.right > inner.right + 0.5 || box.left < inner.left - 0.5); })
      .map((el) => el.className || el.tagName);
    return { page: document.documentElement.scrollWidth <= innerWidth, sideways: scroller.scrollWidth <= scroller.clientWidth, over };
  });
  assert(found.page, `${label}: the page scrolls sideways`);
  assert(found.sideways, `${label}: the transcript scrolls sideways`);
  assert.deepEqual(found.over, [], `${label}: drawn outside the transcript's column`);
}

const sent = (cmd) => calls.filter((item) => item.cmd === cmd);
const shot = (page, name) => page.screenshot({ path: join(artifacts, `${name}.png`) });

async function askScene(browser, size, label, out) {
  const { context, page } = await open(browser, "ask", size);
  const answersAtStart = sent("question_answer_batch").length;
  const block = page.locator(".qa-block");
  await block.waitFor();
  await fits(page, `${label} ask`);

  // No card, in the reply, in place of the call's tool row.
  out.ask = await page.evaluate(() => {
    const block = document.querySelector(".qa-block");
    const style = getComputedStyle(block);
    const reply = block.closest(".msg-assistant");
    return {
      inReply: !!reply, toolRows: reply.querySelectorAll(".tool-head").length,
      border: style.borderTopWidth, background: style.backgroundColor,
      checked: [...block.querySelectorAll("input:checked")].map((el) => el.closest("label").querySelector(".qa-row-label").firstChild.textContent),
      rows: [...block.querySelectorAll(".qa-row-label")].map((el) => el.firstChild.textContent),
      submit: { text: block.querySelector(".qa-submit").textContent, off: block.querySelector(".qa-submit").getAttribute("aria-disabled"),
        width: block.querySelector(".qa-submit").getBoundingClientRect().width, block: block.getBoundingClientRect().width },
      focusInside: block.contains(document.activeElement), oldCard: document.querySelectorAll(".qa-card").length,
      waitingRow: document.querySelectorAll(".qa-waiting").length,
    };
  });
  assert(out.ask.inReply && out.ask.toolRows === 0, `${label}: the block stands in the reply, in place of the tool row`);
  assert.equal(out.ask.border, "0px", `${label}: no frame round the block`);
  assert.equal(out.ask.background, "rgba(0, 0, 0, 0)", `${label}: no fill behind the block`);
  assert.deepEqual(out.ask.checked, ["5 to 6 hours"], `${label}: the recommended option is selected`);
  assert.equal(out.ask.rows.at(-1), "Other…", `${label}: Other is the last row`);
  assert.equal(out.ask.submit.off, "false");
  assert(Math.abs(out.ask.submit.width - out.ask.submit.block) < 1, `${label}: the button is as wide as the block`);
  assert(!out.ask.focusInside, `${label}: the block took the focus`);
  assert.equal(out.ask.oldCard, 0, `${label}: the old card is still drawn`);
  assert.equal(out.ask.waitingRow, 0, `${label}: the waiting row is drawn while the block is in view`);
  await shot(page, `${label}-pending`);

  // A key held down answers nothing.
  const held = await page.evaluate(() => {
    const button = document.querySelector(".qa-submit");
    const press = (repeat) => {
      const event = new KeyboardEvent("keydown", { key: "Enter", repeat, bubbles: true, cancelable: true });
      button.dispatchEvent(event);
      return event.defaultPrevented;
    };
    return { repeat: press(true), first: press(false) };
  });
  assert.deepEqual(held, { repeat: true, first: false }, `${label}: a held Enter on the button`);

  // Other… reveals its text box, by tap or click, and takes the keyboard there.
  const other = block.locator(".qa-row.is-other");
  await (size.phone ? other.tap() : other.click());
  const input = block.locator(".qa-input");
  await input.waitFor();
  assert(await input.evaluate((el) => el === document.activeElement), `${label}: the text box did not take the focus`);
  assert.equal(await block.locator(".qa-submit").getAttribute("aria-disabled"), "true");
  assert.equal((await block.locator(".qa-why").textContent()).trim(), "Type your answer to send it.");
  await shot(page, `${label}-other`);
  // Off means off: a press sends nothing.
  await block.locator(".qa-submit").click({ force: true });
  assert.equal(sent("question_answer_batch").length, answersAtStart, `${label}: an off button sent an answer`);

  // The keyboard alone: back to the options, pick one, and send.
  const second = block.locator('.qa-row input[type="radio"]').nth(1);
  await second.focus();
  await page.keyboard.press("ArrowDown");
  assert.deepEqual(await block.locator("input:checked").evaluateAll((els) => els.map((el) => el.closest("label").textContent.trim())), ["6 to 7 hours"]);
  await page.keyboard.press("ArrowUp");
  assert.equal(await block.locator(".qa-submit").getAttribute("aria-disabled"), "false");
  assert.equal(await block.locator(".qa-input").count(), 0, `${label}: the text box stays after another option is chosen`);

  const before = sent("question_answer_batch").length;
  await block.locator(".qa-submit").focus();
  await page.keyboard.press("Enter");
  await page.locator(".qa-said").waitFor();
  const batch = sent("question_answer_batch").slice(before);
  assert.deepEqual(batch.map((item) => item.args), [{ answers: [{ id: "q1", answer: "5 to 6 hours" }] }], `${label}: what the button sent`);

  // Answered: a quiet line, the bubble, and nothing on the bubble that acts.
  out.sent = await page.evaluate(() => ({
    form: document.querySelectorAll(".qa-block").length,
    asked: document.querySelector(".qa-asked").textContent,
    bubble: document.querySelector(".qa-said-body").textContent,
    controls: document.querySelectorAll(".qa-said button, .qa-said a, .qa-said [tabindex]").length,
    right: Math.round(document.querySelector(".qa-turn").getBoundingClientRect().right - document.querySelector(".qa-said-body").getBoundingClientRect().right),
    order: !!(document.querySelector(".qa-asked").compareDocumentPosition(document.querySelector(".qa-said")) & Node.DOCUMENT_POSITION_FOLLOWING),
  }));
  assert.equal(out.sent.form, 0);
  assert.match(out.sent.asked, /How many hours do you sleep.*Answers saved · waiting for the agent/);
  assert.equal(out.sent.bubble, "5 to 6 hours");
  assert.equal(out.sent.controls, 0, `${label}: the bubble has controls`);
  assert.equal(out.sent.right, 0, `${label}: the bubble is not at the right edge`);
  assert(out.sent.order, `${label}: the bubble is not after the questions`);
  await fits(page, `${label} sent`);
  await context.close();

  // What a reload draws, with no record of the question left: the same.
  const again = await open(browser, "answered", size);
  await again.page.locator(".qa-said").waitFor();
  out.reload = await again.page.evaluate(() => ({
    bubble: document.querySelector(".qa-said-body").textContent,
    asked: document.querySelector(".qa-asked-q").textContent,
    userBubbles: document.querySelectorAll(".msg-user").length,
    mapPoints: document.querySelectorAll("[data-map-turn]").length,
  }));
  assert.equal(out.reload.bubble, "5 to 6 hours");
  assert.equal(out.reload.userBubbles, 1, `${label}: the answer is drawn as a message of the person's`);
  assert.equal(out.reload.mapPoints, 1, `${label}: the answer is a point on the conversation map`);
  await fits(again.page, `${label} answered`);
  await shot(again.page, `${label}-answered`);
  await again.context.close();
}

async function batchScene(browser, size, label, out) {
  const { context, page } = await open(browser, "batch", size);
  const block = page.locator(".qa-block");
  await block.waitFor();
  await fits(page, `${label} batch`);
  out.batch = await page.evaluate(() => {
    const block = document.querySelector(".qa-block");
    return {
      questions: block.querySelectorAll(".qa-q-title").length, buttons: block.querySelectorAll(".qa-submit").length,
      boxes: block.querySelectorAll('input[type="checkbox"]').length, radios: block.querySelectorAll('input[type="radio"]').length,
      why: block.querySelector(".qa-why").textContent, submit: block.querySelector(".qa-submit").textContent,
      desc: getComputedStyle(block.querySelector(".qa-row-desc")).display,
      // Each row's words wrap inside the block, in any font.
      wrapped: [...block.querySelectorAll(".qa-row, .qa-q-title, .qa-submit")].every((el) => el.scrollWidth <= el.clientWidth + 1),
    };
  });
  assert.deepEqual({ ...out.batch, wrapped: undefined, desc: undefined }, {
    questions: 3, buttons: 1, boxes: 4, radios: 3, why: "2 of 3 questions still need an answer.", submit: "Send 3 answers", wrapped: undefined, desc: undefined,
  });
  assert(out.batch.wrapped, `${label}: a row's words run outside it`);
  assert.notEqual(out.batch.desc, "none", `${label}: the description is not drawn`);
  await shot(page, `${label}-batch`);

  const press = (locator) => (size.phone ? locator.tap() : locator.click());
  await press(block.locator(".qa-row", { hasText: "Type check" }));
  await press(block.locator(".qa-row", { hasText: "另开任务" }));
  await block.locator(".qa-input").fill("feature/inline-questions");
  assert.equal(await block.locator(".qa-submit").getAttribute("aria-disabled"), "false");
  assert.equal((await block.locator(".qa-why").textContent()).trim(), "");
  const before = sent("question_answer_batch").length;
  // Delivered to the agent, and the host could not write it down.
  answerWith = () => ({ saved: false, delivered: true, unsaved: "The profile folder /Volumes/work/octiq is not available right now." });
  await press(block.locator(".qa-submit"));
  await page.locator(".qa-said").waitFor();
  answerWith = () => ({ saved: true });
  assert.deepEqual(sent("question_answer_batch").slice(before).map((item) => item.args.answers), [[
    { id: "b1", answer: "Unit tests, Type check" }, { id: "b2", answer: "另开任务" }, { id: "b3", answer: "feature/inline-questions" },
  ]], `${label}: what the batch sent`);
  out.unsaved = await page.evaluate(() => ({
    note: document.querySelector(".qa-note > span").textContent,
    saysSaved: /Answers saved/.test(document.querySelector(".qa-turn").textContent),
    lines: [...document.querySelectorAll(".qa-said-line")].map((el) => el.textContent),
  }));
  assert.equal(out.unsaved.note, "Answers sent · not saved");
  assert(!out.unsaved.saysSaved, `${label}: called saved what was not`);
  assert.equal(out.unsaved.lines.length, 3);
  assert.match(out.unsaved.lines[0], /^Which checks should run before the merge\? Unit tests, Type check$/);
  assert.match(out.unsaved.lines[2], /^What should the branch be called\? feature\/inline-questions$/);
  await fits(page, `${label} unsaved`);
  await shot(page, `${label}-batch-sent-not-saved`);
  await context.close();

  const saved = await open(browser, "saved", size);
  await saved.page.locator(".qa-said").waitFor();
  assert.match(await saved.page.locator(".qa-asked").textContent(), /Answers saved · waiting for the agent/);
  assert.equal(await saved.page.locator(".qa-block").count(), 0);
  await fits(saved.page, `${label} saved`);
  await saved.context.close();
}

async function waitingScene(browser, size, label, out) {
  const { context, page } = await open(browser, "behind", size);
  const row = page.locator(".qa-waiting");
  await row.waitFor();
  out.waiting = await page.evaluate(() => {
    const row = document.querySelector(".qa-waiting");
    const label = row.querySelector(".status-row-label");
    const box = row.getBoundingClientRect();
    const composer = document.querySelector(".composer, .composer-box")?.getBoundingClientRect();
    return {
      text: label.textContent, colour: getComputedStyle(label).color,
      decide: getComputedStyle(document.documentElement).getPropertyValue("--decide").trim(),
      height: Math.round(box.height), aboveComposer: composer ? box.bottom <= composer.top + 1 : null,
      oneLine: label.scrollWidth <= label.clientWidth + 1, isButton: !!row.querySelector("button.status-row-main"),
    };
  });
  assert.equal(out.waiting.text, "1 question waiting");
  assert.equal(out.waiting.height, 28, `${label}: the row is not the group's one line`);
  assert(out.waiting.isButton && out.waiting.oneLine);
  assert.notEqual(out.waiting.aboveComposer, false, `${label}: the row is not above the composer`);
  await shot(page, `${label}-waiting-row`);

  // By tap or by keyboard, never by hover.
  if (size.phone) await row.locator("button").tap();
  else { await row.locator("button").focus(); await page.keyboard.press("Enter"); }
  await page.waitForFunction(() => {
    const block = document.querySelector(".qa-block");
    const pane = document.querySelector(".msgs").getBoundingClientRect();
    const box = block.getBoundingClientRect();
    return box.top >= pane.top - 1 && box.top < pane.bottom && !document.querySelector(".qa-waiting");
  });
  out.revealed = await page.evaluate(() => ({
    focus: document.activeElement?.closest(".qa-block") ? document.activeElement.type : null,
    first: document.activeElement === document.querySelector(".qa-block input"),
    sent: null,
  }));
  assert(out.revealed.first, `${label}: the keyboard is not on the block's first control`);
  await page.waitForTimeout(250);
  await shot(page, `${label}-waiting-revealed`);
  // Scrolled away again, the row comes back.
  await page.evaluate(() => { const pane = document.querySelector(".msgs"); pane.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 })); pane.scrollTop = pane.scrollHeight; });
  await row.waitFor();
  await context.close();

  const far = await open(browser, "far", size);
  await far.page.locator(".qa-turn.is-loose .qa-block").waitFor();
  out.far = await far.page.evaluate(() => ({
    earlier: !!document.querySelector(".history-more"), blocks: document.querySelectorAll(".qa-block").length,
    waitingRow: document.querySelectorAll(".qa-waiting").length,
  }));
  assert.deepEqual(out.far, { earlier: true, blocks: 1, waitingRow: 0 }, `${label}: a question whose call is not drawn`);
  await far.context.close();

  const loose = await open(browser, "loose", size);
  await loose.page.locator(".qa-turn.is-loose .qa-block").waitFor();
  out.loose = await loose.page.evaluate(() => {
    const block = document.querySelector(".qa-turn.is-loose");
    const last = [...document.querySelectorAll(".msgs-inner .msg")].at(-1);
    return { afterLastTurn: !!(last.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING), checked: block.querySelectorAll("input:checked").length,
      off: block.querySelector(".qa-submit").getAttribute("aria-disabled"), why: block.querySelector(".qa-why").textContent };
  });
  assert.deepEqual(out.loose, { afterLastTurn: true, checked: 0, off: "true", why: "Choose an answer to send it." });
  await fits(loose.page, `${label} loose`);
  await shot(loose.page, `${label}-loose`);
  await loose.context.close();
}

/** A question that arrives while the page is open: under the pointer and
 *  the keyboard, and answered by neither. */
async function arrivalScene(browser, size, label, out) {
  const { context, page, send } = await open(browser, "arrive", size);
  await page.locator(".qa-asked").waitFor();
  const question = { id: "qa1", chatKey: "chat:arrive", question: "Ship to production now?", options: [{ label: "Ship now" }, { label: "Wait for the review" }], recommended: 0 };
  const composer = page.locator(".composer textarea, .composer [contenteditable]").first();
  if (await composer.count()) await composer.focus();
  const focusBefore = await page.evaluate(() => document.activeElement?.tagName ?? "");
  const before = sent("question_answer_batch").length;
  const cancelsBefore = sent("question_cancel").length;
  const widthBefore = await page.evaluate(() => document.querySelector(".msgs-inner").getBoundingClientRect().width);
  pending = [...pending, question];
  // First, only to learn where the button lands: the second pass below makes
  // a press at that spot before the block is there.
  send("user-question", question);
  await page.locator(".qa-block").waitFor();
  out.arrival = await page.evaluate(() => {
    const button = document.querySelector(".qa-submit");
    const box = button.getBoundingClientRect();
    const at = { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
    return { focus: document.activeElement?.tagName ?? "", focusInBlock: !!document.activeElement?.closest(".qa-block"), at,
      checked: document.querySelectorAll(".qa-block input:checked").length, off: button.getAttribute("aria-disabled"),
      width: document.querySelector(".msgs-inner").getBoundingClientRect().width };
  });
  assert.equal(out.arrival.focus, focusBefore, `${label}: the focus moved when the block arrived`);
  assert(!out.arrival.focusInBlock);
  assert.equal(out.arrival.checked, 1);
  assert.equal(out.arrival.off, "false");
  // The block arriving does not change how wide the transcript is.
  assert.equal(out.arrival.width, widthBefore, `${label}: the transcript changed width when the block arrived`);
  await fits(page, `${label} arrived`);
  await context.close();

  // The same arrival, with a press made just before it at the spot the button
  // lands on, and repeated there.
  pending = pending.filter((item) => item.id !== "qa1");
  const second = await open(browser, "arrive", size);
  await second.page.locator(".qa-asked").waitFor();
  const at = out.arrival.at;
  await second.page.evaluate((where) => {
    document.body.dispatchEvent(new MouseEvent("click", { ...where, detail: 1, bubbles: true, cancelable: true }));
    window.__pressedAt = performance.now();
    // The repeat is made in the page, the moment the block is drawn. Made
    // from here it crossed to the browser and back first, and on a busy
    // machine that alone outlasted the guard's 700 ms: the press then went
    // through, answered the question, and the next step found no button
    // (two runs in eight).
    const click = (target) => {
      const event = new MouseEvent("click", { ...where, detail: 1, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const watch = new MutationObserver(() => {
      const button = document.querySelector(".qa-submit");
      const dismiss = document.querySelector(".qa-dismiss");
      if (!button || !dismiss) return;
      watch.disconnect();
      const since = performance.now() - window.__pressedAt;
      window.__stray = { since: Math.round(since), repeat: click(button), dismiss: click(dismiss) };
    });
    watch.observe(document.body, { childList: true, subtree: true });
  }, at);
  pending = [...pending, question];
  second.send("user-question", question);
  await second.page.locator(".qa-block").waitFor();
  await second.page.waitForFunction(() => !!window.__stray);
  out.stray = await second.page.evaluate(() => window.__stray);
  await second.page.waitForTimeout(150);
  out.stray.sentByRepeat = sent("question_answer_batch").length - before;
  out.stray.cancelledByRepeat = sent("question_cancel").length - cancelsBefore;
  if (out.stray.since < 700) {
    assert(out.stray.repeat, `${label}: a press repeating the one before the block arrived reached the button (${out.stray.since} ms)`);
    assert(out.stray.dismiss, `${label}: the same press reached Dismiss`);
    assert.equal(out.stray.sentByRepeat, 0, `${label}: the repeated press answered the question`);
    assert.equal(out.stray.cancelledByRepeat, 0, `${label}: the repeated press dismissed the question`);
  } else out.stray.note = "the block took longer than the guard's 700 ms to draw; not measured in this run";
  // A press somewhere else on the button, and a press made later, go through.
  const moved = await second.page.evaluate((where) => {
    const button = document.querySelector(".qa-submit");
    const event = new MouseEvent("click", { clientX: where.clientX + 40, clientY: where.clientY, detail: 1, bubbles: true, cancelable: true });
    button.dispatchEvent(event);
    return event.defaultPrevented;
  }, at);
  assert(!moved, `${label}: an aimed press was dropped`);
  await second.page.locator(".qa-said").waitFor();
  assert.deepEqual(sent("question_answer_batch").at(-1).args, { answers: [{ id: "qa1", answer: "Ship now" }] });
  await second.context.close();
  pending = pending.filter((item) => item.id !== "qa1");
}

async function diagramScene(browser, size, label, out) {
  const { context, page } = await open(browser, "diagram", size);
  await page.locator(".dgm").first().waitFor();
  await fits(page, `${label} diagram`);
  out.diagram = await page.evaluate(() => {
    const [first, wide] = document.querySelectorAll(".dgm");
    const rows = [...first.querySelectorAll(".dgm-row")];
    const pair = [...rows[1].querySelectorAll(".dgm-node")].map((el) => el.getBoundingClientRect());
    const four = [...wide.querySelectorAll(".dgm-row")][1].querySelectorAll(".dgm-node");
    const boxes = [...four].map((el) => el.getBoundingClientRect());
    const node = getComputedStyle(first.querySelector(".dgm-node"));
    const plain = getComputedStyle(first.querySelector(".dgm-node.is-plain"));
    return {
      count: document.querySelectorAll(".dgm").length, codeBlocks: document.querySelectorAll(".code").length,
      label: first.getAttribute("aria-label"), role: first.getAttribute("role"), items: first.querySelectorAll('[role="listitem"]').length,
      arrows: first.querySelectorAll(".dgm-arrow").length, width: Math.round(first.getBoundingClientRect().width),
      sideBySide: Math.abs(pair[0].top - pair[1].top) < 1, equal: Math.abs(pair[0].width - pair[1].width) < 1,
      fourTops: new Set(boxes.map((box) => Math.round(box.top))).size, fourWidths: new Set(boxes.map((box) => Math.round(box.width))).size,
      border: node.borderTopWidth, shadow: node.boxShadow, plainBorder: plain.borderTopColor, align: node.textAlign,
      // Every title and note stays inside its frame, in any font.
      inside: [...document.querySelectorAll(".dgm-node")].every((el) => {
        const box = el.getBoundingClientRect();
        return [...el.querySelectorAll(".dgm-title, .dgm-note")].every((part) => {
          const inner = part.getBoundingClientRect();
          return inner.left >= box.left - 0.5 && inner.right <= box.right + 0.5 && part.scrollWidth <= part.clientWidth + 1;
        });
      }),
      path: [...document.querySelectorAll(".dgm-title")].map((el) => el.textContent).find((words) => words.startsWith("C:")),
      icons: document.querySelectorAll(".dgm-icon svg").length,
    };
  });
  assert.equal(out.diagram.count, 2);
  assert.equal(out.diagram.codeBlocks, 1, `${label}: the invalid block is not the one code block`);
  assert.equal(out.diagram.role, "list");
  assert.equal(out.diagram.items, 3);
  assert.equal(out.diagram.arrows, 2);
  assert.match(out.diagram.label, /^Diagram: Too little sleep \(5 to 6 hours\), then Caffeine and Long screen time, then Twitching/);
  assert.equal(out.diagram.shadow, "none");
  assert.equal(out.diagram.align, "center");
  assert(out.diagram.inside, `${label}: words drawn outside a node's frame`);
  assert.equal(out.diagram.path, "C:\\Users\\kyson\\03-projects\\octiq-flow");
  if (out.diagram.width > 480) {
    assert(out.diagram.sideBySide && out.diagram.equal, `${label}: a row's nodes are not side by side at equal widths`);
    assert.equal(out.diagram.fourTops, 1);
    assert.equal(out.diagram.fourWidths, 1);
  } else {
    assert(!out.diagram.sideBySide, `${label}: a row's nodes did not stack under 480px`);
    assert.equal(out.diagram.fourTops, 4);
  }
  await page.locator(".dgm").first().evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(150);
  await shot(page, `${label}-diagram`);
  await page.locator(".dgm").nth(1).evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(150);
  await shot(page, `${label}-diagram-wrap`);
  await context.close();
}

/** A reply streamed in a few characters at a time: the block is one line
 *  until its fence closes, and nothing below it moves when it does. */
async function streamScene(browser, size, label, out) {
  const { context, page, send } = await open(browser, "stream", size);
  const key = "chat:stream";
  // Numbered, as the host numbers a record's lines: an event with no place
  // in the record is not shown in a chat that is still being read.
  let seq = 0;
  const emit = (event) => send("chat-event", { key, seq: ++seq, event });
  await page.waitForTimeout(600);
  const stream = (event) => emit({ type: "stream_event", session_id: "session-stream", event });
  const whole = "Here is the flow.\n\n" + fence(DIAGRAM) + "\n\nThat is the whole of it.";
  const closeAt = whole.indexOf("\n```\n\nThat") + 4;
  stream({ type: "message_start", message: { id: "msg-stream-1", type: "message", role: "assistant", content: [], model: "claude-opus" } });
  stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  const say = (from, to) => stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: whole.slice(from, to) } });
  const seen = [];
  const look = () => page.evaluate(() => {
    const wait = document.querySelector(".dgm-pending");
    return {
      pending: !!wait, ghostRows: wait ? wait.querySelectorAll(".dgm-ghost .dgm-row").length : 0,
      height: wait ? Math.round(wait.getBoundingClientRect().height * 10) / 10 : 0,
      shownGhost: wait && wait.querySelector(".dgm-ghost") ? getComputedStyle(wait.querySelector(".dgm-ghost")).visibility : null,
      code: document.querySelectorAll(".msgs .code").length, raw: /"rows"/.test(document.querySelector(".msgs-inner").textContent),
      diagram: [...document.querySelectorAll(".dgm")].filter((el) => !el.closest(".dgm-ghost")).length,
    };
  });
  let at = 0;
  // After the fence opens, after each of the first two rows closes, and after
  // the last NODE closes: its row and the fence close in the next delta.
  const rowOne = whole.indexOf("\n    ]") + 6;
  const rowTwo = whole.indexOf("\n    ]", rowOne) + 6;
  const lastNode = whole.lastIndexOf("}", whole.lastIndexOf("}") - 1) + 1;
  for (const [rows, stop] of [whole.indexOf("```octiq-diagram") + 20, rowOne, rowTwo, lastNode].entries()) {
    say(at, stop);
    at = stop;
    // Waited for, not timed: the rows written so far are held once the page
    // has taken the delta in, and on a busy machine that is not always
    // within the 400 ms that used to be all this waited (one run in four
    // read the row count of the stop before). The settle after it is what
    // would show a row too many.
    await page.waitForFunction((held) => {
      const wait = document.querySelector(".dgm-pending");
      return !!wait && wait.querySelectorAll(".dgm-ghost .dgm-row").length >= held;
    }, rows);
    await page.waitForTimeout(400);
    seen.push({ ...(await look()), wrote: JSON.stringify(whole.slice(Math.max(0, stop - 14), stop)) });
  }
  await shot(page, `${label}-diagram-being-written`);
  const before = seen.at(-1);
  // The closing fence, alone.
  say(at, closeAt);
  at = closeAt;
  await page.waitForFunction(() => !document.querySelector(".dgm-pending") && !!document.querySelector(".dgm"));
  const closed = await page.evaluate(() => {
    const box = document.querySelector(".dgm").getBoundingClientRect();
    return { height: Math.round(box.height * 10) / 10, margin: parseFloat(getComputedStyle(document.querySelector(".dgm")).marginBottom) };
  });
  say(at, whole.length);
  stream({ type: "content_block_stop", index: 0 });
  stream({ type: "message_stop" });
  await page.getByText("That is the whole of it.").waitFor();
  out.stream = { seen, closed };
  assert.deepEqual(seen.map((s) => s.pending), [true, true, true, true]);
  assert.deepEqual(seen.map((s) => s.ghostRows), [0, 1, 2, 3], `${label}: the rows held while the block is written`);
  assert(seen.every((s) => s.code === 0 && !s.raw && s.diagram === 0), `${label}: half a diagram was drawn, or its JSON`);
  assert.equal(before.shownGhost, "hidden");
  assert(Math.abs(before.height - closed.height) < 1, `${label}: the block was ${before.height}px before it closed and the diagram is ${closed.height}px`);
  await fits(page, `${label} stream`);
  await context.close();
}

let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(classic ? { ignoreDefaultArgs: ["--hide-scrollbars"], args: ["--disable-features=OverlayScrollbar"] } : {}),
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  for (const size of [{ name: "1280", width: 1280, height: 900, phone: false }, { name: "390", width: 390, height: 844, phone: true }]) {
    const label = `${tag}-${size.name}`;
    const out = report.sizes[size.name] = {};
    await askScene(browser, size, label, out);
    await batchScene(browser, size, label, out);
    await waitingScene(browser, size, label, out);
    await arrivalScene(browser, size, label, out);
    await diagramScene(browser, size, label, out);
    await streamScene(browser, size, label, out);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, mockedBackend: true, ...report }, null, 1));
} catch (error) {
  const page = browser?.contexts().at(-1)?.pages().at(-1);
  await page?.screenshot({ path: join(artifacts, `${tag}-failure.png`), fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ passed: false, ...report, errors }, null, 1));
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
