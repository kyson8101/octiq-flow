const { chromium } = await import(
  process.env.OCTIQOS_PLAYWRIGHT_MODULE ?? "@playwright/test"
);
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const base = process.env.OCTIQOS_E2E_BASE_URL;
assert.ok(base, "Set OCTIQOS_E2E_BASE_URL to an isolated test service");
const target = new URL(base);
assert.ok(
  ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname),
  "Tests require loopback",
);
assert.ok(
  !["1421", "1422"].includes(target.port),
  "Do not use the production or installed preview port",
);
const output =
  process.env.OCTIQOS_E2E_OUTPUT ??
  (await fs.mkdtemp(path.join(os.tmpdir(), "octiqos-world-e2e-")));
await fs.mkdir(output, { recursive: true });
const token = await (await fetch(`${base}/token`)).text();
const socket = new WebSocket(
  `${base.replace("http", "ws")}/ws?token=${encodeURIComponent(token.trim())}`,
);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});
let seq = 0;
const pending = new Map();
socket.onmessage = (e) => {
  const f = JSON.parse(e.data);
  if (f.t === "reply") {
    const p = pending.get(f.id);
    pending.delete(f.id);
    if (p) f.ok ? p.resolve(f.result) : p.reject(new Error(f.error));
  }
};
const invoke = (cmd, args = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ t: "invoke", id, cmd, args }));
  });
const initial = await invoke("world_snapshot");
assert.equal(
  initial.providers.claude_api,
  false,
  "UI tests must not call a live provider",
);
assert.equal(
  initial.world.orgs.length,
  0,
  "Tests require an empty disposable world",
);
await fs.mkdir(path.join(output, "screenshots"), { recursive: true });
for (const project of ["project-a", "project-b"])
  await fs.mkdir(path.join(output, project), { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.OCTIQOS_CHROME_EXECUTABLE,
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(`${base}/os`);
  await page
    .getByRole("heading", { name: "Your world", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Create organization", exact: false })
    .click();
  let modal = page.getByRole("dialog");
  await modal.getByLabel("Organization name").fill("Atlas Lab");
  await modal
    .getByLabel("What is this organization for?")
    .fill("A focused team building thoughtful software.");
  await modal.getByRole("button", { name: "Build your office" }).click();
  await page.getByRole("heading", { name: "Atlas Lab", exact: true }).waitFor();
  await page.getByRole("button", { name: "setup", exact: true }).click();
  for (const [name, folder, context] of [
    ["Project A", "project-a", "Build a reliable onboarding flow."],
    ["Project B", "project-b", "PRIVATE_B_CONTEXT"],
  ]) {
    await page
      .getByRole("button", { name: "Add project", exact: false })
      .click();
    modal = page.getByRole("dialog");
    await modal.getByLabel("Project name").fill(name);
    await modal.getByLabel("Workspace folder").fill(path.join(output, folder));
    await modal.getByLabel("Shared project context").fill(context);
    await modal
      .getByRole("button", { name: "Create project", exact: true })
      .click();
    await modal.waitFor({ state: "hidden" });
  }
  await page.getByRole("button", { name: "office", exact: true }).click();
  for (const [name, profession] of [
    ["Alex", "Developer"],
    ["Quinn", "Tester"],
    ["Morgan", "Project Manager"],
  ]) {
    await page
      .getByRole("button", { name: "Welcome a new member", exact: false })
      .click();
    modal = page.getByRole("dialog");
    await modal.getByLabel("Agent name").fill(name);
    await modal
      .getByLabel("Profession", { exact: true })
      .selectOption({ label: profession });
    await modal
      .getByLabel("Provider", { exact: true })
      .selectOption("claude_api");
    await modal.getByLabel("Model ID").fill("configured-model-required");
    await modal
      .getByLabel("Describe their favorite avatar")
      .fill(`${name}, a cheerful woodland character in a cozy office outfit`);
    await modal.getByLabel("Project A", { exact: true }).check();
    await modal.getByRole("button", { name: "Welcome to the team" }).click();
    await modal.waitFor({ state: "hidden" });
    await page
      .getByRole("button", { name: "Close details", exact: true })
      .click();
  }
  await page.getByRole("button", { name: "setup", exact: true }).click();
  await page
    .getByRole("button", { name: "Create workflow", exact: false })
    .click();
  modal = page.getByRole("dialog");
  await modal.getByLabel("Workflow name").fill("Develop, test, refine");
  await modal.getByRole("button", { name: "Add step", exact: false }).click();
  await modal
    .getByRole("button", { name: "Move step 3 up", exact: true })
    .click();
  await modal
    .getByRole("button", { name: "Create workflow", exact: true })
    .click();
  await modal.waitFor({ state: "hidden" });
  const wfState = await invoke("world_snapshot");
  const wf = wfState.world.workflows[0];
  assert.equal(wf.professionIds.length, 3);
  assert.equal(wf.professionIds[0], wf.professionIds[1]);
  await page.getByRole("button", { name: "office", exact: true }).click();
  await page.screenshot({
    path: path.join(output, "screenshots/office-desktop.png"),
    fullPage: true,
  });
  await page.locator(".ow-desk").filter({ hasText: "Alex" }).click();
  await page.getByRole("button", { name: "Give task", exact: true }).click();
  modal = page.getByRole("dialog");
  await modal
    .getByLabel("What needs to be done?")
    .fill("Fix the mobile login button");
  await modal
    .getByLabel("Context and what done looks like")
    .fill("A tap should open the login form; preserve desktop behavior.");
  assert.equal(
    await modal
      .getByLabel("Project", { exact: true })
      .locator("option")
      .allTextContents()
      .then((v) => v.includes("Project B")),
    false,
  );
  await modal.getByRole("button", { name: "Create task", exact: true }).click();
  await modal.waitFor({ state: "hidden" });
  await page
    .getByRole("heading", { name: "Fix the mobile login button", exact: true })
    .waitFor();
  await page
    .getByLabel("Your direction")
    .fill("Keep the fix focused on the button.");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.locator(".ow-inspector .ow-status.paused").waitFor();
  await page
    .getByRole("button", { name: "Close details", exact: true })
    .click();
  await page.locator(".ow-desk").filter({ hasText: "Alex" }).click();
  await page.getByRole("button", { name: "memory", exact: true }).click();
  await page
    .getByLabel("Add a confirmed lesson")
    .fill("Always check touch behavior on the login button.");
  await page.getByRole("button", { name: "Save memory" }).click();
  await page
    .getByText("Always check touch behavior on the login button.", {
      exact: true,
    })
    .waitFor();
  await page
    .getByRole("button", { name: "Invite to meeting", exact: true })
    .click();
  modal = page.getByRole("dialog");
  await modal
    .getByLabel("What are we discussing?")
    .fill("Testing the onboarding flow");
  await modal.getByLabel("Quinn", { exact: false }).check();
  await modal
    .getByRole("button", { name: "Open meeting", exact: true })
    .click();
  await modal.waitFor({ state: "hidden" });
  const before = (await invoke("world_snapshot")).world.tasks.length;
  await page
    .getByLabel("Join the discussion")
    .fill("What edge cases should we consider? Yes, the idea sounds good.");
  await page.getByRole("button", { name: "Discuss", exact: true }).click();
  await page
    .getByText(
      "What edge cases should we consider? Yes, the idea sounds good.",
      { exact: true },
    )
    .waitFor();
  assert.equal((await invoke("world_snapshot")).world.tasks.length, before);
  await page.screenshot({
    path: path.join(output, "screenshots/meeting-desktop.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Convert to task", exact: false })
    .click();
  modal = page.getByRole("dialog");
  await modal
    .getByLabel("What needs to be done?")
    .fill("Write the approved onboarding test plan");
  await modal
    .getByLabel("Context and what done looks like")
    .fill("Cover touch behavior and failure cases.");
  await modal.getByRole("button", { name: "Create task", exact: true }).click();
  await modal.waitFor({ state: "hidden" });
  let state = await invoke("world_snapshot");
  assert.equal(state.world.tasks.length, before + 1);
  const projectA = state.world.projects.find((p) => p.name === "Project A");
  const projectB = state.world.projects.find((p) => p.name === "Project B");
  const alex = state.world.agents.find((a) => a.name === "Alex");
  const context = await invoke("world_context", {
    agentId: alex.id,
    projectId: projectA.id,
  });
  assert.ok(JSON.stringify(context).includes("Always check touch"));
  assert.ok(!JSON.stringify(context).includes("PRIVATE_B"));
  await assert.rejects(
    invoke("world_context", { agentId: alex.id, projectId: projectB.id }),
    /not authorized/,
  );
  const requestId = crypto.randomUUID();
  const taskArgs = {
    requestId,
    projectId: projectA.id,
    route: "direct",
    agentId: alex.id,
    title: "Idempotent task",
  };
  const first = await invoke("world_create_task", taskArgs);
  const repeat = await invoke("world_create_task", taskArgs);
  assert.equal(first.result.id, repeat.result.id);
  await assert.rejects(
    invoke("world_create_task", {
      ...taskArgs,
      requestId: crypto.randomUUID(),
      projectId: projectB.id,
    }),
    /not authorized/,
  );
  await page
    .getByRole("button", { name: "Close details", exact: true })
    .click();
  await page.getByRole("button", { name: "board", exact: true }).click();
  await page
    .getByRole("button", { name: /Fix the mobile login button/ })
    .waitFor();
  await page.screenshot({
    path: path.join(output, "screenshots/board-desktop.png"),
    fullPage: true,
  });
  await page.reload();
  await page
    .getByRole("heading", { name: "Your world", exact: true })
    .waitFor();
  await page.screenshot({
    path: path.join(output, "screenshots/map-desktop.png"),
    fullPage: true,
  });
  await page.locator(".ow-building").filter({ hasText: "Atlas Lab" }).click();
  await page.locator(".ow-desk").filter({ hasText: "Alex" }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: path.join(output, "screenshots/office-mobile.png"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
  );
  assert.deepEqual(errors, []);
  state = await invoke("world_snapshot");
  assert.equal(state.world.orgs.length, 1);
  assert.equal(state.world.agents.length, 3);
  assert.equal(
    state.world.tasks.filter((t) => t.title === "Idempotent task").length,
    1,
  );
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        flows: [
          "org creation",
          "projects",
          "profession-specific registration",
          "office desks",
          "ordered and repeated workflow steps",
          "direct task intake",
          "pause",
          "memory",
          "multi-agent meeting",
          "no implicit execution",
          "explicit task conversion",
          "scope enforcement",
          "idempotent retry",
          "reload persistence",
          "mobile layout",
        ],
        pageErrors: errors,
        screenshots: path.join(output, "screenshots"),
      },
      null,
      2,
    ),
  );
} catch (error) {
  await page.screenshot({
    path: path.join(output, "screenshots/failure.png"),
    fullPage: true,
  });
  console.log((await page.locator("body").innerText()).slice(-5000));
  throw error;
} finally {
  await browser.close();
  socket.close();
}
