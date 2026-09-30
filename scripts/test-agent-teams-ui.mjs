// App-shell regression for agent teams and peer help. The socket is MOCKED;
// everything else is the real App, Settings → Agents, the Agents page and the
// run panel. It checks that the person can add, rename and remove a team, put
// an agent on one from its form, see the team badge on the org chart and the
// Agents page, and read a worker's logged peer exchange in the task view.
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const artifacts = process.env.OCTIQ_EVIDENCE_DIR
  || await mkdtemp(join(tmpdir(), "octiq-agent-teams-"));
await mkdir(artifacts, { recursive: true });

const now = Date.now();
const agent = (id, name, over = {}) => ({
  id, name, role: "", agent: "claude", model: "sonnet", effort: "high", access: "auto",
  createdAt: now - 100_000, updatedAt: now - 100_000, ...over,
});
let teams = [{ id: "team_web", name: "Web", createdAt: now - 90_000, updatedAt: now - 90_000 }];
let team = [
  agent("maya", "Maya", { role: "CTO", model: "opus" }),
  agent("ada", "Ada", { role: "Frontend engineer", reportsTo: "maya", teamId: "team_web" }),
  agent("bo", "Bo", { role: "Backend engineer: owns the Rust server and its stores", reportsTo: "maya", teamId: "team_web" }),
  agent("cy", "Cy", { role: "Reviewer", reportsTo: "maya", projectId: "octiq" }),
];
const chat = (id, title) => ({
  id, projectId: "general", title, customTitle: true, modelId: "claude:opus", access: "auto",
  sessionId: `session-${id}`, createdAt: now - 200_000, updatedAt: now - 190_000,
});
const TASK = "Build the export button";
const chats = [chat("lead", "Ship the export"), chat("orch-1", TASK)];
const logs = new Map(chats.map(({ id, title }) => [`chat:${id}`, [
  { seq: 1, event: { type: "user", uuid: `u-${id}`, octiq_user_turn: true, message: { content: [{ type: "text", text: `Start: ${title}` }] } } },
  { seq: 2, event: { type: "item.completed", item: { id: `i-${id}`, type: "agent_message", text: `First answer in ${id}.` } } },
  { seq: 3, event: { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } } },
]]));
const snapshot = {
  runs: [{ id: "run-1", coordinatorChatKey: "chat:lead", objective: "Ship the export", workspaceId: "general",
    rootPath: "/Users/kyson/General", status: "running", maxConcurrent: 2, createdAt: now - 190_000, updatedAt: now - 20_000,
    planApproval: { status: "approved", requestedAt: now - 189_000, decidedAt: now - 188_000 } }],
  tasks: [{ id: "t1", runId: "run-1", title: TASK, spec: "Add the button.", dependsOn: [], status: "running",
    activeAttemptId: "a1", assignee: { id: "ada", name: "Ada" }, createdAt: now - 180_000, updatedAt: now - 20_000 }],
  attempts: [{ id: "a1", runId: "run-1", taskId: "t1", number: 1, workerChatKey: "chat:orch-1", agent: "claude", model: "sonnet",
    access: "auto", status: "running", cwd: "/w", branch: "feature/export", isWorktree: true, filesModified: [],
    assignee: { id: "ada", name: "Ada" },
    execution: { state: "executing", retryCount: 0, lastActivityAt: now - 1_000 }, createdAt: now - 150_000, updatedAt: now - 1_000 }],
  gates: [], messages: [],
  peerAsks: [
    { id: "peer_1", runId: "run-1", taskId: "t1", attemptId: "a1", asker: { id: "ada", name: "Ada" }, helper: { id: "bo", name: "Bo" },
      helperAgent: "claude", helperModel: "sonnet", helperEffort: "high",
      question: "Which command writes the export file, and does it hold the store lock while it writes?",
      contextPaths: ["src-tauri/src/dispatch.rs"], status: "answered",
      answer: "`export_write` in dispatch.rs. It takes the store's inner mutex only to read the rows, then writes the file outside the lock, so a slow disk never blocks other commands.",
      usage: { inputTokens: 5400, outputTokens: 180 }, askedAt: now - 120_000, answeredAt: now - 95_000 },
    { id: "peer_2", runId: "run-1", taskId: "t1", attemptId: "a1", asker: { id: "ada", name: "Ada" }, helper: { id: "bo", name: "Bo" },
      helperAgent: "claude", helperModel: "sonnet", question: "Is there a size limit on an export?", status: "asking",
      askedAt: now - 5_000 },
  ],
};

const calls = [];
const errors = [];
function resultFor(request) {
  const args = request.args ?? {};
  switch (request.cmd) {
    case "list_workspaces": return [
      { id: "general", name: "General", primary_path: "/Users/kyson/General" },
      { id: "octiq", name: "OctiqFlow", primary_path: "/repo/octiq" },
    ];
    case "chat_index_list": return chats;
    case "chat_index_deleted": return [];
    case "chat_page": return { events: logs.get(args.key) ?? [], context: [], before: null };
    case "chat_since": return (logs.get(args.key) ?? []).filter((frame) => frame.seq > (args.after ?? 0));
    case "chat_list": return [];
    case "chat_activity": return [];
    case "chat_queue_state": return { live: false, queuedTurnIds: [] };
    case "orchestration_snapshot": return snapshot;
    case "permission_pending": return [];
    case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
    case "usage_summary": return {};
    case "agent_installs": return [{ id: "claude", installed: true, path: "/mock/claude" }];
    case "team_list": return args.all ? team : team.filter((a) => !a.projectId);
    case "team_head": return team[0];
    case "team_leads": return [{ chatKey: "chat:lead", leadId: "maya", leadName: "Maya", projectId: "general", createdAt: now - 60_000 }];
    case "team_home": return "general";
    case "team_save": {
      const saved = { ...team.find((a) => a.id === args.agent.id), ...args.agent, updatedAt: Date.now() };
      if (saved.teamId === "") delete saved.teamId;
      team = team.map((a) => a.id === saved.id ? saved : a);
      return saved;
    }
    case "agent_team_list": return teams;
    case "agent_team_save": {
      const given = args.team;
      const saved = given.id
        ? { ...teams.find((t) => t.id === given.id), name: given.name, ...(given.projectId ? { projectId: given.projectId } : {}), updatedAt: Date.now() }
        : { id: `team_${teams.length + 1}`, name: given.name, ...(given.projectId ? { projectId: given.projectId } : {}), createdAt: Date.now(), updatedAt: Date.now() };
      if (!given.projectId) delete saved.projectId;
      teams = given.id ? teams.map((t) => t.id === saved.id ? saved : t) : [...teams, saved];
      return saved;
    }
    case "agent_team_delete":
      teams = teams.filter((t) => t.id !== args.id);
      team = team.map((a) => a.teamId === args.id ? { ...a, teamId: undefined } : a);
      return null;
    case "agent_avatar_status": return { available: false, reason: "mock" };
    case "levels_list": case "agent_levels": return [];
    case "chat_task": return { chatId: args.chatId, projectId: "general" };
    case "sandbox_snapshot": return { defaultEnabled: false, environments: {} };
    case "codex_skills": return [];
    case "pr_repositories": return [];
    case "pr_local_list": case "pr_remote_list": return { items: [], warnings: [] };
    default: return null;
  }
}

const server = await createServer({
  root: new URL("../web", import.meta.url).pathname,
  configFile: new URL("../web/vite.config.ts", import.meta.url).pathname,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
const rowOf = (scope, name) => scope.locator("li").filter({ has: scope.page().locator(".team-row-name", { hasText: name }) });
const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const settled = (page) => page.waitForFunction(() => document.getAnimations({ subtree: true }).length === 0).catch(() => {});

let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: "reduce" });
  await context.addInitScript(() => {
    if (location.protocol === "about:") return;
    localStorage.setItem("octiq.agentsMode", "on");
    localStorage.setItem("octiq.v2.gitColumn", "0");
    localStorage.setItem("octiq.theme", "dark");
  });
  await context.route("**/token", (route) => route.fulfill({ body: "mock-token" }));
  await context.route("**/auth", (route) => route.fulfill({ body: "ok" }));
  await context.routeWebSocket(/.*/, (socket) => {
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
  const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
  await page.goto(`${base}#/p/general/c/lead`, { waitUntil: "domcontentloaded" });

  // ── The Agents page badges each agent with its team.
  await page.locator(".sidebar-places").getByRole("button", { name: "Agents", exact: true }).click();
  const dashboard = page.getByRole("region", { name: "Agents" });
  await rowOf(dashboard, "Bo").waitFor();
  assert.equal(await rowOf(dashboard, "Ada").locator(".team-badge").innerText(), "Web");
  assert.equal(await rowOf(dashboard, "Bo").locator(".team-badge").innerText(), "Web");
  assert.equal(await rowOf(dashboard, "Cy").locator(".team-badge").count(), 0);
  await page.screenshot({ path: join(artifacts, "agents-page-team-badges.png"), fullPage: true });

  // ── Settings → Agents: the Teams block, and badges on the org chart.
  await page.getByRole("button", { name: "Manage agents", exact: true }).click();
  const settings = page.locator(".team-settings");
  const groups = settings.locator(".team-groups");
  await groups.getByText("2 agents · Every project").waitFor();
  assert.equal(await rowOf(settings.locator(".team-list"), "Bo").locator(".team-badge").innerText(), "Web");
  // Teams sit beside the chart: Bo still reports to Maya.
  assert.equal(await rowOf(settings.locator(".team-list"), "Bo").evaluate((li) => getComputedStyle(li).getPropertyValue("--team-depth").trim()), "1");

  // Add a project team.
  await groups.getByRole("button", { name: "Add team", exact: true }).click();
  await groups.getByLabel("Team name").fill("Review");
  await groups.getByLabel("Team available in").selectOption("octiq");
  await groups.getByRole("button", { name: "Add", exact: true }).click();
  await groups.getByText("0 agents · OctiqFlow").waitFor();
  assert.deepEqual(calls.findLast((c) => c.cmd === "agent_team_save").args.team, { name: "Review", projectId: "octiq" });

  // Put Cy (an OctiqFlow agent) on it from Cy's own form.
  await rowOf(settings.locator(".team-list"), "Cy").getByRole("button", { name: "Edit Cy" }).click();
  const form = settings.locator(".team-form");
  const teamSelect = form.locator("label").filter({ hasText: /^Team/ }).locator("select");
  assert.deepEqual(await teamSelect.locator("option").allInnerTexts(), ["None", "Web", "Review"]);
  await teamSelect.selectOption({ label: "Review" });
  await settled(page);
  await form.screenshot({ path: join(artifacts, "settings-agent-form-team.png") });
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await rowOf(settings.locator(".team-list"), "Cy").locator(".team-badge", { hasText: "Review" }).waitFor();
  const cySave = calls.findLast((c) => c.cmd === "team_save").args.agent;
  assert.equal(cySave.teamId, "team_2");
  assert.equal(cySave.reportsTo, "maya", "the team never touches the reporting line");
  await groups.getByText("1 agent · OctiqFlow").waitFor();

  // Rename Web.
  await groups.getByRole("button", { name: "Rename Web" }).click();
  await groups.getByLabel("Team name").fill("Web platform");
  await groups.getByRole("button", { name: "Save", exact: true }).click();
  await rowOf(settings.locator(".team-list"), "Ada").locator(".team-badge", { hasText: "Web platform" }).waitFor();
  await settled(page);
  await settings.locator(".team-groups").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifacts, "settings-teams.png"), fullPage: true });

  // Remove Review: Cy stays registered, on no team.
  await groups.getByRole("button", { name: "Remove team Review" }).click();
  await groups.getByText("1 agent · OctiqFlow").waitFor({ state: "detached" });
  await rowOf(settings.locator(".team-list"), "Cy").locator(".team-badge").waitFor({ state: "detached" });
  assert.equal(await groups.locator(".team-group-row").count(), 1, "only Web platform is left");
  assert.equal(calls.findLast((c) => c.cmd === "agent_team_delete").args.id, "team_2");

  await page.setViewportSize({ width: 390, height: 844 });
  await settled(page);
  assert.equal(await noHorizontalScroll(page), true, "Settings teams: no sideways scroll at 390px");
  await groups.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifacts, "settings-teams-390.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 });

  // ── The task view logs the peer exchange.
  await page.goto("about:blank");
  await page.goto(`${base}#/p/general/c/lead`, { waitUntil: "domcontentloaded" });
  const toggle = page.locator(".orch-run-accordion-toggle").first();
  await page.locator(".orch-task").first().waitFor();
  if (await toggle.count() && await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
  const row = page.locator(".orch-task").filter({ has: page.locator(".orch-task-title", { hasText: TASK }) });
  await row.getByRole("button", { name: `Expand task progress: ${TASK}` }).click();
  const log = row.locator(".orch-peer-help");
  await log.waitFor();
  assert.equal((await log.locator("summary").innerText()).replace(/\s+/g, " "), "Peer help 2 questions · 1 waiting");
  await log.locator("summary").click();
  await log.locator("li").nth(1).waitFor();
  assert.match(await log.locator("li").first().innerText(), /Ada asked Bo[\s\S]*Answered[\s\S]*5\.6k tokens[\s\S]*store lock[\s\S]*dispatch\.rs[\s\S]*export_write/);
  assert.match(await log.locator("li").nth(1).innerText(), /Waiting for an answer/);
  await settled(page);
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifacts, "task-view-peer-help.png"), fullPage: false });
  await row.screenshot({ path: join(artifacts, "task-row-peer-help.png") });

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, mockedBackend: true, artifacts }));
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  await page?.screenshot({ path: join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ error: String(error), errors }));
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
