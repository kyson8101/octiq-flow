// App-shell regression for who a new agents-mode conversation is with. The
// socket is mocked, so no message reaches a live agent, but every interaction
// goes through App.tsx, the Sidebar, the empty page's picker and the Composer.
//
// The chart: Potato (global, the configured head) and Vesper (only in Website)
// report to the person. Mango (project) and Glen (global) report to Potato;
// Aria reports to Vesper. Only Potato and Vesper may be offered.
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const artifacts = process.env.OCTIQ_EVIDENCE_DIR
  || await mkdtemp(join(tmpdir(), "octiq-conversation-recipients-"));
await mkdir(artifacts, { recursive: true });

const now = Date.now();
const agent = (id, name, extra) => ({
  id, name, role: `${name}'s role`, agent: "claude", model: "sonnet", effort: "medium", access: "auto",
  createdAt: now - 100_000, updatedAt: now - 100_000, ...extra,
});
const potato = agent("potato", "Potato", { role: "CTO", agent: "codex", model: "gpt-5.6-sol", effort: "high" });
const vesper = agent("vesper", "Vesper", { role: "Head of the website", model: "opus", effort: "low", projectId: "site" });
const roster = [
  potato,
  agent("mango", "Mango", { projectId: "octiq", reportsTo: "potato" }),
  agent("glen", "Glen", { reportsTo: "potato" }),
  vesper,
  agent("aria", "Aria", { projectId: "site", reportsTo: "vesper" }),
];
const workspaces = [
  { id: "general", name: "General", primary_path: "/mock/General" },
  { id: "octiq", name: "OctiqFlow", primary_path: "/mock/octiq-flow" },
  { id: "site", name: "Website", primary_path: "/mock/website", paths: ["/mock/website-api"] },
];

const calls = [];
const errors = [];
const server = await createServer({
  root: new URL("../web", import.meta.url).pathname,
  configFile: new URL("../web/vite.config.ts", import.meta.url).pathname,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

function resultFor(request) {
  const args = request.args ?? {};
  switch (request.cmd) {
    case "list_workspaces": return workspaces;
    case "chat_index_list": return [];
    case "chat_index_deleted": return [];
    case "chat_page": return { events: [], context: [], before: null };
    case "chat_list": return [];
    case "chat_queue_state": return { live: false, queuedTurnIds: [] };
    case "orchestration_snapshot": return { runs: [], tasks: [], attempts: [], gates: [], messages: [] };
    case "sandbox_snapshot": return { defaultEnabled: false, environments: {} };
    case "permission_pending": return [];
    case "memory_usage": return { totalMb: 0, procs: 0, rows: [] };
    case "usage_summary": return {};
    case "git_status": return { branch: "main", files: [] };
    case "git_local_branches": return { is_repo: true, current: "main", branches: ["main"], is_worktree: false };
    case "git_prepare_chat_workspace":
      return { cwd: `${args.path}-worktree`, branch: "feature/mock", is_repo: true, is_worktree: true };
    case "agent_installs": return [
      { id: "codex", installed: true, path: "/mock/codex" },
      { id: "claude", installed: true, path: "/mock/claude" },
    ];
    // Scoped lists are what the old picker read; the new one must not need them.
    case "team_list": return args.all ? roster : roster.filter((a) => !a.projectId || a.projectId === args.projectId);
    case "team_head": return potato;
    case "team_leads": return [];
    case "team_home": return "general";
    case "team_brief": return `${args.task}\n\n=== OctiqFlow agents mode ===\nLead: mocked`;
    case "chat_task": return { chatId: args.chatId, projectId: "general" };
    case "codex_skills": return [];
    default: return null;
  }
}

const since = (mark, cmd) => calls.slice(mark).filter((call) => call.cmd === cmd).map((call) => call.args);
async function waitFor(page, check, what) {
  for (let index = 0; index < 100; index += 1) {
    const value = check();
    if (value) return value;
    await page.waitForTimeout(50);
  }
  throw new Error(`Timed out waiting for ${what}`);
}
const radios = (page) => page.getByRole("radiogroup", { name: "Talk to", exact: true }).getByRole("radio");
async function offered(page) {
  const names = await radios(page).evaluateAll((els) => els.map((el) => ({
    name: el.querySelector(".lead-chip-name")?.textContent, checked: el.getAttribute("aria-checked"),
  })));
  return names;
}
async function send(page, text) {
  const mark = calls.length;
  await page.locator("textarea").fill(text);
  await page.locator("textarea").press("Enter");
  const [start] = await waitFor(page, () => since(mark, "chat_start").length && since(mark, "chat_start"), "chat_start");
  return { start, briefs: since(mark, "team_brief"), prepares: since(mark, "git_prepare_chat_workspace") };
}

let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: "reduce" });
  await context.addInitScript(() => {
    localStorage.setItem("octiq.agentsMode", "on");
    localStorage.setItem("octiq.v2.gitColumn", "0");
    // A pick remembered by the old picker must not decide the default.
    localStorage.setItem("octiq.agentsLead", "mango");
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

  // 1. First load: the head is selected, and only the two top-level agents
  //    are offered, whatever their scope. No subordinate, global or not.
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Talk to Potato", exact: true }).waitFor();
  assert.deepEqual(await offered(page), [
    { name: "Potato", checked: "true" }, { name: "Vesper", checked: "false" },
  ]);
  await page.screenshot({ path: join(artifacts, "desktop-first-load.png") });

  // 2. Picking Vesper moves the draft to Website and says so.
  await radios(page).filter({ hasText: "Vesper" }).click();
  await page.getByRole("heading", { name: "Talk to Vesper", exact: true }).waitFor();
  assert.match(new URL(page.url()).hash, /^#\/p\/website/);
  assert.match(await page.locator(".hero-sub").first().innerText(), /Works only in Website/);
  await page.screenshot({ path: join(artifacts, "desktop-vesper-picked.png") });

  // Keyboard: arrows move the choice within the group, Tab stops once.
  await radios(page).filter({ hasText: "Vesper" }).focus();
  await page.keyboard.press("ArrowLeft");
  await page.getByRole("heading", { name: "Talk to Potato", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.querySelector(".lead-chip-name")?.textContent), "Potato");
  await page.keyboard.press("ArrowRight");
  await page.getByRole("heading", { name: "Talk to Vesper", exact: true }).waitFor();
  assert.deepEqual(await radios(page).evaluateAll((els) => els.map((el) => el.tabIndex)), [-1, 0]);

  // 3. Sending goes to Vesper, in Website, on Vesper's own provider and model,
  //    in a new worktree of Website's primary checkout.
  const toVesper = await send(page, "Refresh the pricing page");
  assert.deepEqual(toVesper.briefs.map(({ leadId, projectId, crossProject }) => ({ leadId, projectId, crossProject })),
    [{ leadId: "vesper", projectId: "site", crossProject: false }]);
  assert.equal(toVesper.prepares.length, 1);
  assert.equal(toVesper.prepares[0].path, "/mock/website");
  assert.equal(toVesper.prepares[0].newWorktree, true);
  assert.equal(toVesper.start.agent, "claude");
  assert.equal(toVesper.start.model, "opus");
  assert.equal(toVesper.start.effort, "low");
  assert.equal(toVesper.start.cwd, "/mock/website-worktree");
  assert.deepEqual(toVesper.start.extraDirs, ["/mock/website-api"]);

  // 4. New conversation in the sidebar opens the same picker, back on the head.
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await page.getByRole("heading", { name: "Talk to Potato", exact: true }).waitFor();
  assert.deepEqual(await offered(page), [
    { name: "Potato", checked: "true" }, { name: "Vesper", checked: "false" },
  ]);
  const toPotato = await send(page, "Plan the next release");
  assert.deepEqual(toPotato.briefs.map(({ leadId, projectId, crossProject }) => ({ leadId, projectId, crossProject })),
    [{ leadId: "potato", projectId: "general", crossProject: true }]);
  assert.equal(toPotato.prepares.length, 0, "the head coordinates from home with no checkout");
  assert.equal(toPotato.start.agent, "codex");
  assert.equal(toPotato.start.model, "gpt-5.6-sol");

  // 5. First load inside Vesper's own project still opens on the head.
  await page.goto(`${base}#/p/website`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Talk to Potato", exact: true }).waitFor();

  // 6. Phone width: the same picker, inside the viewport, and it still routes.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Show chats", exact: true }).click();
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await page.getByRole("heading", { name: "Talk to Potato", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const box = await page.getByRole("radiogroup", { name: "Talk to", exact: true }).boundingBox();
  assert(box && box.x >= 0 && box.x + box.width <= 390, `picker inside the viewport: ${JSON.stringify(box)}`);
  await page.screenshot({ path: join(artifacts, "mobile-picker-390.png") });
  await radios(page).filter({ hasText: "Vesper" }).click();
  await page.getByRole("heading", { name: "Talk to Vesper", exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, "mobile-vesper-picked-390.png") });
  const mobile = await send(page, "Fix the footer on phones");
  assert.deepEqual(mobile.briefs.map(({ leadId, projectId }) => ({ leadId, projectId })),
    [{ leadId: "vesper", projectId: "site" }]);

  // Choosing who a conversation is with never changes the team's settings.
  for (const cmd of ["team_head_set", "team_save", "team_delete", "team_home_set"]) {
    assert.equal(calls.filter((call) => call.cmd === cmd).length, 0, `${cmd} must not be called`);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, mockedBackend: true, artifacts }));
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  console.error(JSON.stringify({
    error: String(error), errors,
    body: await page?.locator("body").innerText({ timeout: 2_000 }).catch(() => "unavailable"),
  }));
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
