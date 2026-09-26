// App-shell regression for the new-conversation welcome in agents mode. The
// socket is mocked, so no message reaches a live agent, but every interaction
// goes through App.tsx, the Sidebar, the empty page and the Composer.
//
// A real role runs to a thousand characters. Printed whole under the heading
// it filled a phone and pushed the picker and composer off the first screen,
// so the welcome shows one line about the agent and keeps the rest behind a
// "Details" toggle. This checks that at 375, 430 and 1440 wide, with a long
// role and a long name, and that picking, Manage agents, resume and sending
// still work.
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const artifacts = process.env.OCTIQ_EVIDENCE_DIR
  || await mkdtemp(join(tmpdir(), "octiq-agent-welcome-"));
await mkdir(artifacts, { recursive: true });

// The role from the report's screenshot, verbatim in substance.
const LONG_ROLE = "Starfall creative lead and novelist. Reports directly to the person, alongside Potato Juice rather than under the CTO. Owns novel outlines, chapters, dialogue, editing, story canon and creative direction. Read project instructions and relevant canon before writing; preserve established language, voices, timeline and continuity. Separate proposed ideas from approved canon. Coordinate Aria for OST and lyrics, Encore for video production and Ampest for publishing; give concise briefs and review their work for story consistency and quality. Write novel work directly and delegate specialist production when authorized. Work only in /Users/kyson/03-projects/Starfall. Keep technical work with Potato Juice when needed. Preserve permission prompts and obtain authorization for external publishing or paid generation.";
const LONG_NAME = "Bartholomew Montgomery-Fitzwilliam the Third";

const now = Date.now();
const agent = (id, name, extra) => ({
  id, name, role: `${name}'s role`, agent: "claude", model: "sonnet", effort: "medium", access: "auto",
  createdAt: now - 100_000, updatedAt: now - 100_000, ...extra,
});
const potato = agent("potato", "Potato Juice", { role: "CTO. Owns technical direction across every project.", agent: "codex", model: "gpt-5.6-sol", effort: "high" });
const vesper = agent("vesper", "Vesper", { role: LONG_ROLE, model: "opus", effort: "low", projectId: "starfall" });
const long = agent("long", LONG_NAME, { role: "", projectId: "starfall" });
const roster = [potato, vesper, long, agent("aria", "Aria", { projectId: "starfall", reportsTo: "vesper" })];
const workspaces = [
  { id: "general", name: "General", primary_path: "/mock/General" },
  { id: "starfall", name: "starfall", primary_path: "/mock/Starfall" },
];
const history = Array.from({ length: 600 }, (_, index) => ({
  agent: "claude", sessionId: `s${index}`, title: `Session ${index}`, cwd: "/mock/Starfall",
  startedAt: now - index * 60_000, updatedAt: now - index * 60_000,
}));

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
    case "agent_history_list": return history;
    case "team_list": return args.all ? roster : roster.filter((a) => !a.projectId || a.projectId === args.projectId);
    case "team_head": return potato;
    case "team_leads": return [];
    case "team_home": return "general";
    case "team_brief": return `${args.task}\n\n=== OctiqFlow agents mode ===\nLead: mocked`;
    case "chat_task": return { chatId: args.chatId, projectId: "general" };
    case "codex_skills": return [];
    case "agent_avatar_status": return { available: false, jobs: [] };
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
const roleText = (page) => page.getByText("Coordinate Aria for OST and lyrics", { exact: false });

/** Everything a phone has to reach on the first screen, measured. */
async function layout(page) {
  return page.evaluate(() => {
    const rect = (el) => el && (({ top, bottom, left, right, height }) => ({ top, bottom, left, right, height }))(el.getBoundingClientRect());
    const title = document.querySelector(".hero .hero-title");
    return {
      width: innerWidth,
      height: innerHeight,
      overflowX: document.documentElement.scrollWidth > innerWidth,
      titleSize: title ? parseFloat(getComputedStyle(title).fontSize) : null,
      title: rect(title),
      picker: rect(document.querySelector(".lead-picker-list")),
      resume: rect(document.querySelector(".hero .resume-open")),
      composer: rect(document.querySelector("textarea")),
      hero: rect(document.querySelector(".hero")),
      chips: [...document.querySelectorAll(".lead-chip")].map(rect),
    };
  });
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
    if (location.protocol === "about:") return;
    localStorage.setItem("octiq.agentsMode", "on");
    localStorage.setItem("octiq.v2.gitColumn", "0");
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
  const measured = {};
  // A goto to the URL already open only moves the hash, which keeps the last
  // pick; each width starts from a fresh load.
  const fresh = async () => {
    await page.goto("about:blank");
    await page.goto(`${base}#/p/starfall`, { waitUntil: "domcontentloaded" });
  };

  for (const [width, height] of [[375, 667], [430, 932], [1440, 960]]) {
    await page.setViewportSize({ width, height });
    await fresh();
    await page.getByRole("heading", { name: "Talk to Potato Juice", exact: true }).waitFor();
    await radios(page).filter({ hasText: "Vesper" }).click();
    await page.getByRole("heading", { name: "Talk to Vesper", exact: true }).waitFor();
    await page.locator(".hero .resume-count").waitFor();
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(artifacts, `vesper-${width}.png`) });

    // 1. The heading is modest and the role is one line, not the whole brief.
    const shut = await layout(page);
    measured[width] = shut;
    assert.equal(shut.overflowX, false, `no sideways scroll at ${width}`);
    assert(shut.titleSize <= 20, `heading ${shut.titleSize}px at ${width}`);
    assert.equal(await roleText(page).isVisible(), false, `the full role is shut at ${width}`);
    const summary = page.locator(".hero .hero-sub").first();
    assert.match(await summary.innerText(), /Starfall creative lead and novelist/);
    assert.match(await summary.innerText(), /Works only in starfall/);
    // 2. Everything a phone needs is on the first screen, above the composer.
    for (const [name, box] of [["picker", shut.picker], ["resume", shut.resume]]) {
      assert(box && box.left >= 0 && box.right <= width, `${name} inside the width at ${width}: ${JSON.stringify(box)}`);
      assert(box.bottom <= shut.composer.top, `${name} above the composer at ${width}: ${JSON.stringify(box)} vs ${JSON.stringify(shut.composer)}`);
    }
    assert(shut.composer.bottom <= height, `composer on screen at ${width}`);
    for (const chip of shut.chips) assert(chip.height >= (width < 860 ? 44 : 32), `chip tall enough to tap at ${width}: ${chip.height}`);

    // 3. The whole role opens on request, in place, and shuts again.
    const toggle = page.getByRole("button", { name: "Details about Vesper", exact: true });
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    const region = await toggle.getAttribute("aria-controls");
    assert(region, "the toggle names what it opens");
    if (width < 860) assert((await toggle.boundingBox()).height >= 44, `details toggle tall enough to tap at ${width}`);
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    assert.equal(await roleText(page).isVisible(), true);
    assert.equal(await page.locator(`[id="${region}"]`).isVisible(), true);
    assert.match(await page.locator(`[id="${region}"]`).innerText(), /Work only in \/Users\/kyson\/03-projects\/Starfall/);
    assert.equal((await layout(page)).overflowX, false, `no sideways scroll with details open at ${width}`);
    await page.screenshot({ path: join(artifacts, `vesper-details-${width}.png`), fullPage: true });
    await toggle.click();
    assert.equal(await roleText(page).isVisible(), false);

    // 4. A long name wraps inside the page, and an agent with no role still
    //    says where it works.
    await radios(page).filter({ hasText: LONG_NAME }).click();
    await page.getByRole("heading", { name: `Talk to ${LONG_NAME}`, exact: true }).waitFor();
    const named = await layout(page);
    assert.equal(named.overflowX, false, `long name fits at ${width}`);
    assert(named.title.right <= width && named.title.left >= 0, `long heading inside the width at ${width}`);
    assert.match(await page.locator(".hero .hero-sub").first().innerText(), /Works only in starfall/);
    // The composer's own label for the agent stops short of Send.
    const [identity, sendButton] = await Promise.all([
      page.locator(".composer-identity").boundingBox(), page.locator("button.send").boundingBox(),
    ]);
    assert(identity.x + identity.width <= sendButton.x, `composer name clear of Send at ${width}`);
    await page.screenshot({ path: join(artifacts, `long-name-${width}.png`) });

    // 5. Switching back shuts the details again (they belong to one agent).
    await radios(page).filter({ hasText: "Vesper" }).click();
    await page.getByRole("heading", { name: "Talk to Vesper", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Details about Vesper", exact: true }).getAttribute("aria-expanded"), "false");
  }

  // 6. Resume still opens its search, and Manage agents still opens Settings.
  await page.setViewportSize({ width: 375, height: 667 });
  await page.getByRole("button", { name: /Resume an earlier session/ }).click();
  await page.locator(".resume-input").waitFor();
  await page.locator(".resume-close").click();
  await page.getByRole("button", { name: "Manage agents", exact: true }).click();
  await page.getByText("Registered agents", { exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, "manage-agents-375.png") });

  // 7. Sending still goes to the picked agent.
  await fresh();
  await radios(page).filter({ hasText: "Vesper" }).click();
  await page.getByRole("heading", { name: "Talk to Vesper", exact: true }).waitFor();
  const mark = calls.length;
  await page.locator("textarea").fill("Outline chapter three");
  await page.locator("textarea").press("Enter");
  await waitFor(page, () => since(mark, "chat_start").length, "chat_start");
  assert.deepEqual(since(mark, "team_brief").map(({ leadId, projectId }) => ({ leadId, projectId })),
    [{ leadId: "vesper", projectId: "starfall" }]);

  // The welcome only reads the team; the stored roles are never written.
  for (const cmd of ["team_head_set", "team_save", "team_delete", "team_home_set"]) {
    assert.equal(calls.filter((call) => call.cmd === cmd).length, 0, `${cmd} must not be called`);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, mockedBackend: true, artifacts, measured }));
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
