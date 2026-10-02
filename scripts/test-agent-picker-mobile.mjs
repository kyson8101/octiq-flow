// App-shell regression for the "Talk to" agent picker on a new conversation in
// agents mode. The socket is mocked, so no message reaches a live agent, but
// every interaction goes through App.tsx, the empty page and the Composer.
//
// On a phone the picker used to be a centred flex-wrap of pills, each its own
// width: seven agents became a ragged cloud, two on the first row and one per
// row after, that took most of the screen. It is now one aligned list of
// equal-width rows. This checks that at 375, 430 and 1440 wide, with seven
// agents, a long name and a CJK name, and that the composer stays on the first
// screen however long the roster grows.
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
// PLAYWRIGHT_BROWSER=webkit runs the same checks in the engine an iPhone uses.
const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const engine = playwright[process.env.PLAYWRIGHT_BROWSER || "chromium"];
const artifacts = process.env.OCTIQ_EVIDENCE_DIR
  || await mkdtemp(join(tmpdir(), "octiq-agent-picker-"));
await mkdir(artifacts, { recursive: true });

const LONG_NAME = "Bartholomew Montgomery-Fitzwilliam the Third";
const now = Date.now();
const agent = (id, name, extra) => ({
  id, name, role: `${name}'s role`, agent: "claude", model: "sonnet", effort: "medium", access: "auto",
  createdAt: now - 100_000, updatedAt: now - 100_000, projectId: "starfall", ...extra,
});
// The roster from the report's screenshot, plus a long name.
const seven = [
  agent("potato", "Potato Juice", { agent: "codex", model: "gpt-5.6-sol", projectId: undefined }),
  agent("canon", "STAR CANON 昭宁"),
  agent("aria", "STAR MUSIC Aria"),
  agent("relay", "STAR SOCIAL Relay"),
  agent("vesper", "STAR STORY Vesper", { role: "Starfall prose writer" }),
  agent("encore", "STAR VIDEO Encore"),
  agent("ampest", "STAR YT Ampest"),
  agent("long", LONG_NAME),
];
// A roster nobody has yet, to prove the list scrolls before the composer goes.
const crowd = [...seven, ...Array.from({ length: 12 }, (_, i) => agent(`extra${i}`, `STAR EXTRA ${i + 1}`))];
let roster = seven;
const workspaces = [
  { id: "general", name: "General", primary_path: "/mock/General" },
  { id: "starfall", name: "starfall-novel", primary_path: "/mock/Starfall" },
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
    case "team_head": return roster[0];
    case "team_leads": return [];
    case "team_home": return "general";
    case "agent_team_list": return [];
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

async function layout(page) {
  return page.evaluate(() => {
    const rect = (el) => el && (({ top, bottom, left, right, width, height }) => ({ top, bottom, left, right, width, height }))(el.getBoundingClientRect());
    const list = document.querySelector(".lead-picker-list");
    return {
      overflowX: document.documentElement.scrollWidth > innerWidth,
      picker: rect(list),
      pickerScrolls: list ? list.scrollHeight > list.clientHeight + 1 : false,
      manage: rect(document.querySelector(".lead-picker-note button")),
      resume: rect(document.querySelector(".hero .resume-open")),
      composer: rect(document.querySelector("textarea")),
      hint: document.querySelector(".composer-hint")?.textContent ?? null,
      chips: [...document.querySelectorAll(".lead-chip")].map((chip) => ({
        ...rect(chip),
        text: chip.querySelector(".lead-chip-name").textContent,
        name: rect(chip.querySelector(".lead-chip-name")),
        nameClipped: (() => { const n = chip.querySelector(".lead-chip-name"); return n.scrollWidth > n.clientWidth + 1; })(),
        meta: rect(chip.querySelector(".lead-chip-meta")),
        on: chip.classList.contains("is-on"),
        background: getComputedStyle(chip).backgroundColor,
        // The picked row's accent bar is an inset shadow on a phone, its
        // border on a desktop.
        edge: `${getComputedStyle(chip).borderColor} ${getComputedStyle(chip).boxShadow}`,
      })),
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
  const contexts = {};
  const open = async (width, height, touch) => {
    const key = `${width}x${height}${touch ? "-touch" : ""}`;
    if (!contexts[key]) {
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
      contexts[key] = page;
    }
    const page = contexts[key];
    const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
    await page.goto("about:blank");
    await page.goto(`${base}#/p/starfall`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Talk to Potato Juice", exact: true }).waitFor();
    return page;
  };
  const measured = {};

  for (const [width, height, touch] of [[375, 667, true], [430, 932, true], [1440, 960, false]]) {
    roster = seven;
    const page = await open(width, height, touch);
    await radios(page).filter({ hasText: "STAR STORY Vesper" }).click();
    await page.getByRole("heading", { name: "Talk to STAR STORY Vesper", exact: true }).waitFor();
    await page.locator(".hero .resume-count").waitFor();
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(artifacts, `picker-${width}.png`) });
    const shot = await layout(page);
    measured[width] = shot;
    assert.equal(shot.overflowX, false, `no sideways scroll at ${width}`);
    assert.equal(shot.chips.length, seven.length);

    if (width < 860) {
      // 1. One aligned list: every row the same width and left edge, one per
      //    row, inside the page.
      const [first] = shot.chips;
      for (const chip of shot.chips) {
        assert(Math.abs(chip.left - first.left) < 1, `rows share a left edge at ${width}: ${chip.left} vs ${first.left}`);
        assert(Math.abs(chip.width - first.width) < 1, `rows share a width at ${width}: ${chip.width} vs ${first.width}`);
        assert(chip.left >= 0 && chip.right <= width, `row inside the width at ${width}`);
        // 2. Still a 44px target, but no taller than it needs to be.
        assert(chip.height >= 44 && chip.height <= 48, `row height ${chip.height} at ${width}`);
        // The name starts at the left, after the avatar; the project sits at
        // the right end of the same row.
        assert(chip.name.left - chip.left < 48, `name left-aligned at ${width}`);
        if (chip.meta) assert(Math.abs(chip.meta.right - (chip.right - 12)) < 3, `project label at the right end at ${width}`);
      }
      for (let i = 1; i < shot.chips.length; i += 1) {
        assert(shot.chips[i].top >= shot.chips[i - 1].bottom - 1, `one row per agent at ${width}`);
      }
      // 3. The long name is cut off with an ellipsis rather than wrapping or
      //    pushing the project label out.
      const long = shot.chips.find((chip) => chip.text === LONG_NAME);
      assert.equal(long.nameClipped, true, `long name truncated at ${width}`);
      assert(long.meta && long.meta.right <= long.right, `long name keeps its project label at ${width}`);
      // 4. Picked reads differently from not picked.
      const on = shot.chips.find((chip) => chip.on);
      const off = shot.chips.find((chip) => !chip.on);
      assert(on && off && on.background !== off.background && /rgb.*3px 0px 0px/.test(on.edge) && !/3px 0px 0px/.test(off.edge), `picked row stands out at ${width}`);
      // 5. Everything the page offers sits above the composer, on screen.
      for (const [name, box] of [["picker", shot.picker], ["manage", shot.manage], ["resume", shot.resume]]) {
        assert(box.bottom <= shot.composer.top, `${name} above the composer at ${width}`);
      }
      assert(shot.composer.bottom <= height, `composer on screen at ${width}`);
      // 6. On a touch screen Enter is a new line and nothing else, so the
      //    composer does not spend its hint line saying so.
      assert(!/Enter/.test(shot.hint ?? ""), `no Enter hint on touch at ${width}: ${shot.hint}`);

      // 7. Twenty agents: the list scrolls in place, the composer stays.
      roster = crowd;
      const crowded = await open(width, height, touch);
      await crowded.locator(".hero .resume-count").waitFor();
      await crowded.waitForTimeout(250);
      const many = await layout(crowded);
      assert.equal(many.chips.length, crowd.length);
      assert.equal(many.overflowX, false, `no sideways scroll with ${crowd.length} agents at ${width}`);
      assert.equal(many.pickerScrolls, true, `long roster scrolls inside the picker at ${width}`);
      assert(many.picker.bottom <= many.composer.top, `long roster above the composer at ${width}`);
      assert(many.resume.bottom <= many.composer.top, `resume above the composer with a long roster at ${width}`);
      assert(many.composer.bottom <= height, `composer on screen with a long roster at ${width}`);
      await crowded.screenshot({ path: join(artifacts, `picker-crowd-${width}.png`) });
    } else {
      // Desktop keeps its centred chips and its keyboard hint.
      const tops = new Set(shot.chips.map((chip) => Math.round(chip.top)));
      assert(tops.size < shot.chips.length, "desktop chips share rows");
      assert.match(shot.hint ?? "", /Enter to send/);
    }
  }

  // 8. Behaviour is unchanged: arrow keys move the pick, Manage agents opens
  //    Settings, and a send goes to the picked agent.
  roster = seven;
  const page = await open(375, 667, true);
  await radios(page).filter({ hasText: "Potato Juice" }).focus();
  await page.keyboard.press("ArrowDown");
  await page.getByRole("heading", { name: `Talk to ${LONG_NAME}`, exact: true }).waitFor();
  await page.keyboard.press("ArrowDown");
  await page.getByRole("heading", { name: "Talk to STAR CANON 昭宁", exact: true }).waitFor();
  await radios(page).filter({ hasText: "STAR STORY Vesper" }).click();
  await page.getByRole("heading", { name: "Talk to STAR STORY Vesper", exact: true }).waitFor();
  const mark = calls.length;
  await page.locator("textarea").fill("Outline chapter three");
  await page.locator("button.send").click();
  await waitFor(page, () => since(mark, "chat_start").length, "chat_start");
  assert.deepEqual(since(mark, "team_brief").map(({ leadId, projectId }) => ({ leadId, projectId })),
    [{ leadId: "vesper", projectId: "starfall" }]);
  // A fresh context, since the one above now has a conversation open.
  const manage = await open(376, 667, true);
  await manage.getByRole("button", { name: "Manage agents", exact: true }).click();
  await manage.getByText("Registered agents", { exact: true }).waitFor();

  for (const cmd of ["team_head_set", "team_save", "team_delete", "team_home_set"]) {
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
