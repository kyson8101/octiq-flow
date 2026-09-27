// Live check of agent levels against this checkout's DEBUG octiq-server under
// a throwaway HOME.
//
// The ledger is SEEDED, and every seeded title says "(seeded)". It is written
// as a store from before the acceptance ledger existed: awards and each task's
// current acceptance, no `acceptances`, so the server has to rebuild the
// ledger on load. Every number on screen is computed by the real server, and
// every Accept click goes through the real host command.
//
//   pnpm --dir web build
//   (cd src-tauri && cargo build --bin octiq-server)
//   OUT=/absolute/evidence/dir \
//   PLAYWRIGHT_MODULE=~/.npm/_npx/<hash>/node_modules/playwright/index.mjs \
//   node scripts/test-agent-levels-live.mjs
//
// OUT receives the screenshots, the seeded HOME and the server log.
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const REPO = process.env.REPO ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.OUT;
if (!OUT) throw new Error("Set OUT to the directory the evidence goes in.");
const HOME = join(OUT, "home");
const PROJECT = join(OUT, "project");
const PORT = Number(process.env.PORT ?? 14794);
const TOKEN = "levels-check-token";
const profile = join(HOME, ".octiqflow", "profiles", "default");
await rm(HOME, { recursive: true, force: true });
await mkdir(join(profile, "chats"), { recursive: true });
await mkdir(PROJECT, { recursive: true });

const now = Date.now();
const day = 86_400_000;
const agent = (id, name, over = {}) => ({
  id, name, role: "", agent: "codex", model: "gpt-5.6-sol", effort: "high", access: "auto",
  createdAt: now - 30 * day, updatedAt: now - day, ...over,
});
await writeFile(join(profile, "team.json"), JSON.stringify({
  agents: [
    agent("agent_potato", "Potato Juice", { agent: "claude", model: "opus", role: "CTO." }),
    agent("agent_mango", "Mango Juice", { role: "Primary OctiqFlow developer.", reportsTo: "agent_potato" }),
    agent("agent_kiwi", "Kiwi Juice", { agent: "claude", model: "sonnet", role: "Reviewer.", reportsTo: "agent_mango" }),
  ],
  leads: [{ chatKey: "chat:lead-demo", leadId: "agent_potato", leadName: "Potato Juice", projectId: "general", createdAt: now - 5 * day }],
  head: "agent_potato",
}, null, 2));

const run = {
  id: "run_demo", objective: "Levels demo (seeded)", coordinatorChatKey: "chat:lead-demo", workspaceId: "general",
  rootPath: PROJECT, status: "running", maxConcurrent: 2, createdAt: now - 5 * day, updatedAt: now - day,
  planApproval: { status: "approved", requestedAt: now - 5 * day, decidedAt: now - 5 * day, revision: 1, revisedAt: now - 5 * day },
};
const tasks = {}, attempts = {}, xpAwards = {};
const mango = { id: "agent_mango", name: "Mango Juice" };
const kiwi = { id: "agent_kiwi", name: "Kiwi Juice" };
const XP = { small: 25, medium: 75, large: 150 };
const PERSON = { kind: "person" };
const LEAD = { kind: "lead", agentId: "agent_potato", agentName: "Potato Juice" };
let n = 0;
function attempt(taskId, number, assignee, at) {
  const id = `attempt_demo${n}_${number}`;
  attempts[id] = {
    id, runId: run.id, taskId, number, workerChatKey: `chat:orch-demo${n}-${number}`, agent: "codex",
    model: "gpt-5.6-sol", access: "auto", status: "completed", cwd: "/tmp", branch: "b", isWorktree: false,
    assignee, filesModified: [], finishedAt: at, createdAt: at - day / 4, updatedAt: at,
    execution: { state: "completed", retryCount: 0 },
  };
  return id;
}
/** A completed task. `accepted` names who accepted its (first) result;
 *  `paid` whether that paid; `reopened` adds a second completed attempt that
 *  nobody has accepted yet. */
function add(title, assignee, size, { accepted = null, paid = !!size, reopened = false } = {}) {
  n += 1;
  const id = `task_demo${n}`;
  const at = now - (12 - n) * day / 2;
  const first = attempt(id, 1, assignee, at);
  const current = reopened ? attempt(id, 2, assignee, at + day / 3) : first;
  tasks[id] = {
    id, runId: run.id, title, spec: "Seeded demo task.", assignee, ...(size ? { size } : {}), dependsOn: [],
    status: "completed", worker: { agent: "codex", access: "auto", model: "gpt-5.6-sol" }, approvedAt: now - 5 * day,
    card: { problem: "Seeded for the levels check.", goal: "Show a level.", acceptance: ["It shows."] },
    createdAt: at - day, updatedAt: at, activeAttemptId: current, result: "Done.",
  };
  if (accepted) {
    tasks[id].acceptance = { attemptId: first, at, by: accepted };
    if (paid) {
      xpAwards[id] = { taskId: id, runId: run.id, agentId: assignee.id, agentName: assignee.name, title, size,
        xp: XP[size], attemptId: first, acceptedAt: at, acceptedBy: accepted };
    }
  }
  return id;
}
add("Agent usage ledger (seeded)", mango, "large", { accepted: PERSON });
add("Plan card size picker (seeded)", mango, "medium", { accepted: LEAD });
add("Fix level chip spacing (seeded)", mango, "small", { accepted: PERSON });
// Started before sizes existed, accepted, paid nothing.
const legacy = add("Legacy import from before sizes (seeded)", mango, null, { accepted: PERSON });
// Paid on its first result, then reopened: the new result waits.
const reopened = add("Reopened review fixes (seeded)", mango, "medium", { accepted: LEAD, reopened: true });
// Started before sizes existed, finished, nobody has accepted it.
const unsizedWaiting = add("Unsized follow-up (seeded)", mango, null);
add("Review the XP ledger (seeded)", kiwi, "small", { accepted: LEAD });
await writeFile(join(profile, "orchestrations.json"), JSON.stringify({
  version: 4, runs: { [run.id]: run }, tasks, attempts, xp_awards: xpAwards, scoring_since: now - 6 * day,
}, null, 2));

const server = spawn(join(REPO, "src-tauri/target/debug/octiq-server"), [], {
  env: { ...process.env, HOME, OCTIQ_WEB_PORT: String(PORT), OCTIQ_WEB_TOKEN: TOKEN, OCTIQ_CHAT_IDLE_MINS: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
process.on("exit", () => server.kill());
let log = "";
server.stdout.on("data", (d) => { log += d; });
server.stderr.on("data", (d) => { log += d; });
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 150; i += 1) {
  try { if ((await fetch(`${base}/?token=${TOKEN}`)).ok) break; } catch { /* not yet */ }
  await new Promise((r) => setTimeout(r, 200));
}

// One command over the real socket, as the browser sends it.
async function invoke(cmd, args) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const reply = new Promise((resolve) => {
    ws.onmessage = (ev) => {
      const frame = JSON.parse(ev.data);
      if (frame.id === 1 && (frame.t === "reply" || "ok" in frame)) resolve(frame);
    };
  });
  ws.send(JSON.stringify({ t: "invoke", id: 1, cmd, args }));
  const frame = await reply;
  ws.close();
  if (!frame.ok) throw new Error(`${cmd}: ${frame.error ?? JSON.stringify(frame)}`);
  return frame.result;
}
const workspace = await invoke("add_workspace", { name: "Levels Demo", primaryPath: PROJECT });
await invoke("chat_index_save", { meta: { id: "lead-demo", projectId: workspace.id ?? workspace, title: "Levels demo (seeded)", customTitle: true, createdAt: now - 5 * day, updatedAt: now - day } });

// The server rebuilt the ledger from the old store: the legacy acceptance
// counts, at 0 XP.
const before = await invoke("agent_level_profile", { agentId: "agent_mango" });
assert.equal(before.xp, 150 + 75 + 25 + 75);
assert.equal(before.level, 3);
assert.equal(before.acceptedTasks, 5, "four paid tasks and the legacy one");
assert.equal(before.historyTotal, 5);
const legacyRow = before.history.find((r) => r.taskId === legacy);
assert.equal(legacyRow.xp, 0);
assert.equal(legacyRow.unpaid, "unsized");
assert.deepEqual(before.awaiting.map((a) => a.taskId).sort(), [reopened, unsizedWaiting].sort());
assert.ok(before.awaiting.every((a) => a.unscored));

// The hook, with the person's token and no chat capability, naming the run's
// coordinator: refused before anything is looked at. The token is not an
// agent credential at all.
for (const capability of [undefined, "not-a-real-capability"]) {
  const response = await fetch(`${base}/hook/orchestration?token=${TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(capability ? { "x-octiq-chat-capability": capability } : {}) },
    body: JSON.stringify({ chatKey: "chat:lead-demo", action: "task_accept",
      args: { taskId: reopened, attemptId: tasks[reopened].activeAttemptId } }),
  });
  assert.equal(response.status, 401, `forged coordinator, capability ${capability ?? "absent"}`);
}
// Nor is the person's socket a lead: it has its own accept command, and the
// lead's refuses to run there, whatever chat it names.
await assert.rejects(
  invoke("orchestration_task_accept_in_chat", {
    actorChatKey: "chat:lead-demo", taskId: reopened, attemptId: tasks[reopened].activeAttemptId,
  }),
  /only runs from its chat/,
);
const unchanged = await invoke("agent_level_profile", { agentId: "agent_mango" });
assert.equal(unchanged.historyTotal, 5, "the forged calls accepted nothing");

const browser = await chromium.launch();
const shots = [];
async function page(width, height) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  await context.addInitScript(({ token }) => {
    if (location.protocol === "about:") return;
    localStorage.setItem("octiq.web.token", token);
    localStorage.setItem("octiq.agentsMode", "on");
    localStorage.setItem("octiq.theme", "dark");
  }, { token: TOKEN });
  const p = await context.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(`${base}/?token=${TOKEN}`);
  await p.waitForLoadState("networkidle");
  return { p, errors, context };
}
async function openAgents(p, phone) {
  if (phone) {
    const show = p.getByRole("button", { name: /show chats/i });
    if (await show.count()) await show.first().click();
  }
  await p.getByRole("button", { name: /^Agents$/ }).first().click();
  await p.getByRole("list").filter({ hasText: "Mango Juice" }).first().waitFor();
}
async function shot(p, name, fullPage = false) {
  const file = join(OUT, `${name}.png`);
  await p.screenshot({ path: file, fullPage });
  shots.push(file);
}
const stat = (p) => p.locator(".agent-profile-stats dd").first();

// Desktop.
{
  const { p, errors, context } = await page(1440, 900);
  await openAgents(p, false);
  const chip = p.getByRole("button", { name: /Mango Juice: level 3, 325 XP/ });
  await chip.waitFor();
  assert.equal(await p.getByRole("button", { name: /Potato Juice: level 1, 0 XP/ }).count(), 1);
  await shot(p, "desktop-roster");

  // Nobody has accepted anything of Potato's: the count and the history agree.
  await p.getByRole("button", { name: /Potato Juice: level 1, 0 XP/ }).click();
  await p.getByText("No accepted tasks yet.").waitFor();
  assert.match(await stat(p).innerText(), /^0\s*lifetime$/);
  await shot(p, "desktop-profile-empty");

  await p.getByRole("button", { name: "Back to all agents" }).click();
  await chip.click();
  await p.getByRole("progressbar").waitFor();
  assert.match(await stat(p).innerText(), /^5\s*lifetime$/);
  await p.getByRole("button", { name: "Legacy import from before sizes (seeded): 0 XP, No size recorded. Open task" }).waitFor();
  await p.getByText("How levels work", { exact: true }).click();
  await shot(p, "desktop-profile-before");
  await shot(p, "desktop-profile-before-full", true);

  // Accept the reopened task's new result: recorded, not paid again.
  const accept = (title) => p.locator(".xp-row", { hasText: title }).getByRole("button", { name: "Accept" });
  await accept("Reopened review fixes (seeded)").click();
  await p.getByText("Accepted. XP for this task was already paid; a task pays once.").waitFor();
  await p.getByRole("button", { name: /Reopened review fixes \(seeded\): 0 XP, Accepted again · paid the first time\. Open task/ }).waitFor();
  assert.match(await stat(p).innerText(), /^5\s*lifetime$/, "the same task, counted once");
  // Accept the unsized one: counted, 0 XP.
  await accept("Unsized follow-up (seeded)").click();
  await p.getByText("Accepted. This task started before sizes were recorded, so it earns no XP.").waitFor();
  await p.getByRole("button", { name: "Unsized follow-up (seeded): 0 XP, No size recorded. Open task" }).waitFor();
  assert.match(await stat(p).innerText(), /^6\s*lifetime$/);
  assert.equal(await p.getByRole("progressbar").getAttribute("aria-valuenow"), "325", "no XP from either");
  await shot(p, "desktop-profile-after");
  await shot(p, "desktop-profile-after-full", true);

  // A history row opens its run's main chat.
  await p.getByRole("button", { name: /Reopened review fixes \(seeded\): 0 XP/ }).click();
  await p.waitForTimeout(600);
  const hash = await p.evaluate(() => location.hash);
  assert.match(hash, /lead-demo/);
  await shot(p, "desktop-history-opened-run");
  assert.deepEqual(errors, []);
  await context.close();
}

const after = await invoke("agent_level_profile", { agentId: "agent_mango" });
assert.equal(after.xp, 325);
assert.equal(after.acceptedTasks, 6);
assert.equal(after.historyTotal, 7, "the reopened task has two lines");
const reopenedRows = after.history.filter((r) => r.taskId === reopened);
assert.deepEqual(reopenedRows.map((r) => [r.xp, r.unpaid ?? null]), [[0, "already_paid"], [75, null]]);
assert.equal(reopenedRows[1].attemptId, tasks[reopened].acceptance.attemptId, "the first acceptance is unchanged");
assert.equal(reopenedRows[1].acceptedBy.agentId, "agent_potato");
const summaries = await invoke("agent_levels", {});
assert.deepEqual(summaries.map((s) => [s.agentId, s.xp, s.acceptedTasks]).sort(),
  [["agent_kiwi", 25, 1], ["agent_mango", 325, 6]]);

// Phone.
{
  const { p, errors, context } = await page(390, 844);
  await openAgents(p, true);
  await shot(p, "phone-roster");
  await p.getByRole("button", { name: /Mango Juice: level 3, 325 XP/ }).click();
  await p.getByRole("progressbar").waitFor();
  assert.match(await stat(p).innerText(), /^6\s*lifetime$/);
  await shot(p, "phone-profile");
  await shot(p, "phone-profile-full", true);
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `no sideways scroll on a phone (${overflow}px)`);
  assert.deepEqual(errors, []);
  await context.close();
}

await browser.close();
server.kill();
await writeFile(join(OUT, "server.log"), log);
console.log("agent levels live check passed");
console.log(shots.join("\n"));
