// Actual App-shell regression for the sidebar's Pull requests place and the
// Agents page's roster. The socket is mocked, but every interaction goes
// through App.tsx, Sidebar, the top bar and AgentsDashboard, and host events
// arrive the way the real server sends them.
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const artifacts = process.env.OCTIQ_EVIDENCE_DIR
  || await mkdtemp(join(tmpdir(), "octiq-agents-roster-"));
await mkdir(artifacts, { recursive: true });

const now = Date.now();
const agent = (id, name, over = {}) => ({
  id, name, role: "", agent: "claude", model: "opus", effort: "high", access: "auto",
  createdAt: now - 100_000, updatedAt: now - 100_000, ...over,
});
const team = [
  agent("maya", "Maya", { role: "CTO" }),
  agent("noah", "Noah", { role: "Frontend engineer", projectId: "octiq", reportsTo: "maya" }),
  agent("priya", "Priya", { role: "Backend engineer", projectId: "panda", reportsTo: "maya" }),
  agent("ivan", "Ivan", { role: "Reviewer", projectId: "octiq", reportsTo: "maya" }),
];
const chat = (id, projectId, title) => ({
  id, projectId, title, customTitle: true, modelId: "claude:opus", access: "auto",
  sessionId: `session-${id}`, createdAt: now - 60_000, updatedAt: now - 50_000,
});
const chats = [
  chat("head-live", "general", "Plan the release"),
  chat("orch-t1", "octiq", "Build the roster page"),
  chat("orch-t4", "octiq", "Old review"),
];
const localChats = chats.map((item) => ({
  ...item,
  messages: [{ id: `m-${item.id}`, role: "assistant", streaming: false, blocks: [{ kind: "text", text: `${item.title} answer.` }] }],
}));
const destination = (projectId, projectName) => ({ projectId, projectName, repository: `/repo/${projectId}` });
const task = (id, over) => ({
  id, runId: "run-live", spec: "", dependsOn: [], createdAt: now - 40_000, updatedAt: now - 20_000, ...over,
});
const snapshot = {
  runs: [
    { id: "run-live", coordinatorChatKey: "chat:head-live", objective: "Ship the release", workspaceId: "general",
      rootPath: "/Users/kyson/General", status: "running", maxConcurrent: 2, createdAt: now - 45_000, updatedAt: now - 20_000,
      planApproval: { status: "approved", requestedAt: now - 44_000, decidedAt: now - 43_000 } },
    { id: "run-old", coordinatorChatKey: "chat:head-live", objective: "Last week", workspaceId: "general",
      rootPath: "/Users/kyson/General", status: "stopped", maxConcurrent: 1, createdAt: now - 900_000, updatedAt: now - 800_000 },
  ],
  tasks: [
    task("t1", { title: "Build the roster page", status: "running", activeAttemptId: "a1",
      assignee: { id: "noah", name: "Noah (old name)" }, destination: destination("octiq", "OctiqFlow") }),
    task("t2", { title: "Polish the PR row", status: "pending", assignee: { id: "noah", name: "Noah" },
      destination: destination("octiq", "OctiqFlow") }),
    task("t3", { title: "Payroll export API", status: "ready", assignee: { id: "priya", name: "Priya" },
      destination: destination("panda", "Pandahrms") }),
    // History: blocked in a stopped run is not a current state.
    task("t4", { runId: "run-old", title: "Old review", status: "blocked", activeAttemptId: "a4",
      assignee: { id: "ivan", name: "Ivan" } }),
  ],
  attempts: [
    { id: "a1", runId: "run-live", taskId: "t1", number: 1, workerChatKey: "chat:orch-t1", agent: "claude",
      access: "auto", status: "running", cwd: "/w", branch: "feature/roster", isWorktree: true, filesModified: [],
      execution: { state: "executing", retryCount: 0, lastActivityAt: now - 1_000 },
      createdAt: now - 30_000, updatedAt: now - 1_000 },
    { id: "a4", runId: "run-old", taskId: "t4", number: 1, workerChatKey: "chat:orch-t4", agent: "claude",
      access: "auto", status: "blocked", cwd: "/w", branch: "b", isWorktree: true, filesModified: [],
      createdAt: now - 850_000, updatedAt: now - 800_000 },
  ],
  gates: [], messages: [],
};

let leadBusy = true;
let leadRunning = true;
let ledgerDown = false;
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
    case "list_workspaces": return [
      { id: "general", name: "General", primary_path: "/Users/kyson/General" },
      { id: "octiq", name: "OctiqFlow", primary_path: "/repo/octiq", color: "#3b82f6" },
      { id: "panda", name: "Pandahrms", primary_path: "/repo/panda", color: "#16a34a" },
    ];
    case "chat_index_list": return chats;
    case "chat_index_deleted": return [];
    case "chat_page": return { events: [], context: [], before: null };
    case "chat_list": return leadRunning ? ["chat:head-live"] : [];
    case "chat_activity": return leadRunning ? [{ key: "chat:head-live", busy: leadBusy }] : [];
    case "chat_queue_state": return { live: false, queuedTurnIds: [] };
    case "orchestration_snapshot": return snapshot;
    case "permission_pending": return [];
    case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
    case "usage_summary": return {};
    case "agent_installs": return [{ id: "claude", installed: true, path: "/mock/claude" }];
    // The page must ask for everyone, not the open chat's project.
    case "team_list": return request.args?.all ? team : team.filter((a) => !a.projectId);
    case "team_head": return team[0];
    case "team_leads": return [{ chatKey: "chat:head-live", leadId: "maya", leadName: "Maya", projectId: "general", crossProject: true, createdAt: now - 60_000 }];
    case "team_home": return "general";
    case "chat_task": return { chatId: request.args?.chatId, projectId: "general" };
    case "pr_repositories": return [];
    case "pr_local_list": case "pr_remote_list": return { items: [], warnings: [] };
    case "codex_skills": return [];
    default: return null;
  }
}

const send = (event, payload) => appSocket.send(JSON.stringify({ t: "event", event, payload }));
const agentRow = (page, name) => page.locator(".dash-agent").filter({ has: page.locator(".team-row-name", { hasText: name }) });
const stateOf = async (page, name) => (await agentRow(page, name).locator(".dash-state").innerText()).trim();
const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: "reduce" });
  await context.addInitScript((seed) => {
    if (location.search.includes("coding=1")) localStorage.removeItem("octiq.agentsMode");
    else localStorage.setItem("octiq.agentsMode", "on");
    localStorage.setItem("octiq.v2.gitColumn", "0");
    localStorage.setItem("octiq.v2.conversations", JSON.stringify(seed));
  }, localChats);
  await context.route("**/token", (route) => route.fulfill({ body: "mock-token" }));
  await context.route("**/auth", (route) => route.fulfill({ body: "ok" }));
  await context.routeWebSocket(/.*/, (socket) => {
    appSocket = socket;
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw));
      if (request.t !== "invoke") return;
      calls.push(request);
      if (request.cmd === "orchestration_snapshot" && ledgerDown) {
        socket.send(JSON.stringify({ t: "reply", id: request.id, ok: false, error: "ledger unavailable" }));
        return;
      }
      socket.send(JSON.stringify({ t: "reply", id: request.id, ok: true, result: resultFor(request) }));
    });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) => errors.push(error.stack ?? String(error)));
  const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
  await page.goto(`${base}#/p/general/c/head-live`, { waitUntil: "domcontentloaded" });
  await page.locator(".main").getByText("Plan the release answer.", { exact: true }).waitFor();

  // ── Pull requests is a sidebar place, right before Settings, and only there.
  const places = page.locator(".sidebar-places");
  const labels = (await places.locator(".sidebar-place span").allInnerTexts()).map((text) => text.trim());
  assert.deepEqual(labels.slice(-3), ["Agents", "Pull requests", "Settings"], `sidebar order: ${labels}`);
  await page.getByRole("button", { name: "Chat actions", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Pull requests", exact: true }).count(), 1,
    "no Pull requests item left in the top bar's menu");
  await page.keyboard.press("Escape");
  await places.getByRole("button", { name: "Pull requests", exact: true }).click();
  await page.getByRole("region", { name: "Pull requests dashboard" }).waitFor();
  assert.equal(await places.getByRole("button", { name: "Pull requests", exact: true }).getAttribute("aria-current"), "page");
  assert.equal(await places.locator('[aria-current="page"]').count(), 1);
  await page.screenshot({ path: join(artifacts, "desktop-pull-requests.png") });
  await page.getByRole("button", { name: "Back to chat", exact: true }).click();
  await page.locator(".main").getByText("Plan the release answer.", { exact: true }).waitFor();
  assert.equal(await places.locator('[aria-current="page"]').count(), 0);

  // ── Agents: every agent across projects, with what each is doing now.
  await places.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("region", { name: "Agents" }).waitFor();
  await agentRow(page, "Ivan").waitFor();
  assert(calls.some(({ cmd, args }) => cmd === "team_list" && args?.all === true), "the page asks for the whole roster");
  assert.equal(await page.locator(".dash-agent").count(), 4, "all four agents, from three projects, are listed");
  assert.equal(await stateOf(page, "Maya"), "Working", "a lead mid-turn in its own conversation is working");
  assert.equal(await stateOf(page, "Noah"), "Working");
  assert.equal(await stateOf(page, "Priya"), "Queued", "a queued-only agent is never shown working");
  assert.equal(await stateOf(page, "Ivan"), "Idle", "a blocked task in a stopped run is history");
  const noah = agentRow(page, "Noah");
  assert.match(await noah.innerText(), /1 queued/);
  assert.match(await noah.innerText(), /Build the roster page[\s\S]*Executing[\s\S]*OctiqFlow/);
  assert.match(await agentRow(page, "Priya").innerText(), /Payroll export API[\s\S]*Ready to start[\s\S]*Pandahrms/);
  assert.match(await agentRow(page, "Priya").innerText(), /Backend engineer · Pandahrms/);
  assert.match(await agentRow(page, "Maya").innerText(), /Plan the release[\s\S]*In conversation[\s\S]*Across projects/);
  assert.match(await agentRow(page, "Ivan").innerText(), /Last:\s+Old review/);
  assert.equal(await page.locator(".dash-avatar.is-working").count(), 2, "only the two working agents breathe");
  assert.match(await page.locator(".dash-summary").innerText(), /2 working · 1 queued · 1 idle/);
  assert.equal(await places.getByRole("button", { name: "Agents", exact: true }).getAttribute("aria-current"), "page");
  await page.screenshot({ path: join(artifacts, "desktop-agents.png"), fullPage: true });

  // A live execution update moves Noah off "Working" without a reload.
  send("orchestration-changed", { attemptId: "a1", execution: { state: "stalled", retryCount: 0, stalledAt: now } });
  await page.waitForFunction(() => [...document.querySelectorAll(".dash-agent")]
    .find((row) => row.textContent.includes("Noah"))?.querySelector(".dash-state")?.textContent === "Stalled");
  send("orchestration-changed", { attemptId: "a1", execution: { state: "executing", retryCount: 0 } });

  // The lead's conversation ends: Maya is idle, with a way back into it.
  leadBusy = false;
  leadRunning = false;
  send("chat-status", { key: "chat:head-live", kind: "exit", text: "", code: 0 });
  await page.waitForFunction(() => [...document.querySelectorAll(".dash-agent")]
    .find((row) => row.textContent.includes("Maya"))?.querySelector(".dash-state")?.textContent === "Idle");
  assert.match(await agentRow(page, "Maya").innerText(), /Last:\s+Plan the release/);
  await page.screenshot({ path: join(artifacts, "desktop-agents-lead-ended.png"), fullPage: true });

  // The ledger stops answering: the last known state stays, marked as such.
  ledgerDown = true;
  send("orchestration-changed", { runId: "run-live" });
  await page.getByText("Could not refresh work. Showing the last known state.", { exact: true }).waitFor();
  assert.equal(await stateOf(page, "Noah"), "Working (last known)");
  assert.equal(await page.locator(".dash-avatar.is-working").count(), 0, "nothing breathes on stale evidence");
  await page.screenshot({ path: join(artifacts, "desktop-agents-stale.png"), fullPage: true });
  ledgerDown = false;
  send("orchestration-changed", { runId: "run-live" });
  await page.getByText("Could not refresh work. Showing the last known state.", { exact: true }).waitFor({ state: "detached" });

  // Open goes straight to the task's own chat.
  await noah.getByRole("button", { name: /Executing: Build the roster page/ }).click();
  await page.waitForURL(/\/c\/orch-t1$/);
  assert.equal(await page.getByRole("region", { name: "Agents" }).count(), 0);

  // A task nobody has started opens its lead's run panel instead.
  await places.getByRole("button", { name: "Agents", exact: true }).click();
  await agentRow(page, "Priya").getByRole("button", { name: /Ready to start: Payroll export API/ }).click();
  await page.waitForURL(/\/c\/head-live$/);

  // ── 390px: the same page and places, no sideways scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Show chats", exact: true }).click();
  await places.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("region", { name: "Agents" }).waitFor();
  await agentRow(page, "Priya").waitFor();
  assert.equal(await noHorizontalScroll(page), true);
  assert.equal(await page.locator(".sidebar-places").isVisible(), false, "the chat list steps aside for the page");
  await page.screenshot({ path: join(artifacts, "mobile-agents-390.png"), fullPage: true });
  await page.getByRole("button", { name: "Show chats", exact: true }).click();
  await places.getByRole("button", { name: "Pull requests", exact: true }).click();
  await page.getByRole("region", { name: "Pull requests dashboard" }).waitFor();
  assert.equal(await noHorizontalScroll(page), true);
  await page.screenshot({ path: join(artifacts, "mobile-pull-requests-390.png") });
  await page.getByRole("button", { name: "Show chats", exact: true }).click();
  assert.equal(await places.getByRole("button", { name: "Pull requests", exact: true }).getAttribute("aria-current"), "page");
  await page.screenshot({ path: join(artifacts, "mobile-sidebar-390.png") });

  // ── Pull requests is there with agents mode off, too.
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${base}?coding=1#/p/general/c/head-live`, { waitUntil: "domcontentloaded" });
  await page.locator(".main").getByText("Plan the release answer.", { exact: true }).waitFor();
  const coding = (await page.locator(".sidebar-places .sidebar-place span").allInnerTexts()).map((text) => text.trim());
  assert.deepEqual(coding.slice(-2), ["Pull requests", "Settings"]);
  assert.equal(coding.includes("Agents"), false);
  await page.locator(".sidebar-places").getByRole("button", { name: "Pull requests", exact: true }).click();
  await page.getByRole("region", { name: "Pull requests dashboard" }).waitFor();

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, mockedBackend: true, artifacts }));
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  await page?.screenshot({ path: join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
  console.error(JSON.stringify({
    error: String(error), errors,
    body: await page?.locator("body").innerText({ timeout: 2_000 }).catch(() => "unavailable"),
  }));
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
