const { chromium } = await import(
  process.env.OCTIQOS_PLAYWRIGHT_MODULE ?? "@playwright/test"
);
import assert from "node:assert/strict";
import fs from "node:fs/promises";
assert.equal(
  process.env.OCTIQOS_RECRUITER_LIVE_TEST,
  "1",
  "Explicit live model test opt-in required",
);
const base = process.env.OCTIQOS_E2E_BASE_URL;
assert.ok(base, "Set an isolated test service URL");
const target = new URL(base);
assert.ok(
  ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) &&
    !["1421", "1422"].includes(target.port),
  "Do not use production or preview",
);
const output = process.env.OCTIQOS_E2E_OUTPUT;
assert.ok(output, "Set a fresh test output directory");
await fs.mkdir(output, { recursive: true });
const token = (await (await fetch(`${base}/token`)).text()).trim();
const ws = new WebSocket(
  `${base.replace("http", "ws")}/ws?token=${encodeURIComponent(token)}`,
);
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = j;
});
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.t === "reply") {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (p) m.ok ? p.r(m.result) : p.j(Error(m.error));
  }
};
const invoke = (cmd, args = {}) =>
  new Promise((r, j) => {
    const id = ++seq;
    pending.set(id, { r, j });
    ws.send(JSON.stringify({ t: "invoke", id, cmd, args }));
  });
const mutate = async (action, args) =>
  (await invoke(`world_${action}`, { ...args, requestId: crypto.randomUUID() }))
    .result;
const snapshot = () => invoke("world_snapshot");
const browser = await chromium.launch({
  executablePath: process.env.OCTIQOS_CHROME_EXECUTABLE,
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  assert.equal((await snapshot()).world.orgs.length, 0);
  const org = (await mutate("create_org", { name: "Recruiter QA" })).id;
  const project = (
    await mutate("create_project", {
      orgId: org,
      name: "Mobile app",
      context: "PRIVATE_PROJECT_CONTEXT_NOT_FOR_RECRUITER",
    })
  ).id;
  const other = (
    await mutate("create_project", {
      orgId: org,
      name: "Other app",
      context: "UNRELATED_PROJECT",
    })
  ).id;
  await page.goto(`${base}/os`);
  await page
    .locator(".ow-building")
    .filter({ hasText: "Recruiter QA" })
    .click();
  await page
    .getByRole("button", { name: "Welcome a new member", exact: false })
    .click();
  let modal = page.getByRole("dialog");
  await modal.getByLabel("Agent name", { exact: true }).fill("Quinn");
  await modal
    .getByLabel("Profession", { exact: true })
    .selectOption({ label: "Tester" });
  await modal
    .getByLabel("Provider", { exact: true })
    .selectOption("claude_api");
  await modal
    .getByLabel("Model ID", { exact: true })
    .fill("configured-model-required");
  await modal.getByLabel("Mobile app", { exact: true }).check();
  await modal
    .getByLabel("Describe the role", { exact: true })
    .fill(
      "A mobile QA specialist who designs negative-path and regression tests. Focus on touch interactions and accessibility. Ask the founder when expected behavior is unclear. Report only checks actually run.",
    );
  await modal
    .getByRole("button", { name: "Polish with Recruiter", exact: true })
    .click();
  await modal.getByText("Recruiter is polishing…", { exact: true }).waitFor();
  assert.equal(await modal.locator('button[type="submit"]').isDisabled(), true);
  let draft;
  for (let n = 0; n < 150; n++) {
    const s = await snapshot();
    draft = s.world.recruitmentDrafts[0];
    if (draft?.status === "failed") throw Error(draft.error);
    if (draft?.status === "ready") break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  assert.equal(draft.status, "ready");
  assert.ok(draft.prompt.length > 100);
  await page.waitForFunction(
    (prompt) =>
      document.querySelector('textarea[name="rolePrompt"]')?.value === prompt,
    draft.prompt,
  );
  assert.equal(
    (await snapshot()).world.agents.length,
    1,
    "Only recruiter created while polishing",
  );
  assert.equal((await snapshot()).world.tasks.length, 0);
  console.log(
    "PASS: real Codex recruiter produced a persisted prompt without creating tasks/candidate",
  );
  await modal.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByRole("button", { name: "Welcome a new member", exact: false })
    .click();
  modal = page.getByRole("dialog");
  await modal
    .getByLabel("Profession", { exact: true })
    .selectOption({ label: "Tester" });
  await modal
    .getByLabel("Saved recruiter drafts", { exact: true })
    .selectOption(draft.id);
  await page.waitForFunction(
    (prompt) =>
      document.querySelector('textarea[name="rolePrompt"]')?.value === prompt,
    draft.prompt,
  );
  const polished =
    draft.prompt + "\nEscalate ambiguous gesture behavior to the founder.";
  await modal.getByLabel("Agent role prompt", { exact: true }).fill(polished);
  await modal.getByLabel("Agent name", { exact: true }).fill("Quinn");
  await modal
    .getByLabel("Provider", { exact: true })
    .selectOption("claude_api");
  await modal
    .getByLabel("Model ID", { exact: true })
    .fill("configured-model-required");
  await modal.getByLabel("Mobile app", { exact: true }).check();
  await modal
    .getByRole("button", { name: "Welcome to the team", exact: true })
    .click();
  await modal.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "role", exact: true }).click();
  assert.equal(
    await page.getByLabel("Agent role prompt", { exact: true }).inputValue(),
    polished,
  );
  let s = await snapshot();
  const member = s.world.agents.find((a) => a.name === "Quinn");
  assert.equal(member.rolePrompt, polished);
  assert.equal(
    (await invoke("world_context", { agentId: member.id, projectId: project }))
      .rolePrompt,
    polished,
  );
  await assert.rejects(
    invoke("world_context", { agentId: member.id, projectId: other }),
    /not authorized/,
  );
  const edited = polished + "\nKeep handoffs concise.";
  await page.getByLabel("Agent role prompt", { exact: true }).fill(edited);
  await page
    .getByRole("button", { name: "Save role prompt", exact: true })
    .click();
  await page
    .getByText("Role prompt saved. New task and meeting turns will use it.", {
      exact: true,
    })
    .waitFor();
  s = await snapshot();
  assert.equal(
    s.world.agents.find((a) => a.id === member.id).rolePrompt,
    edited,
  );
  assert.deepEqual(s.world.agents.find((a) => a.id === member.id).projectIds, [
    project,
  ]);
  const recruiter = s.world.agents.find((a) => a.name === "Recruiter");
  const usage = s.stats.find((a) => a.agentId === recruiter.id);
  assert.ok(usage.inputTokens > 0 && usage.outputTokens > 0);
  assert.equal(usage.active, 0);
  assert.equal(usage.recruiting, 0);
  assert.equal(usage.xp, 0);
  await page.screenshot({ path: `${output}/role-editor.png`, fullPage: true });
  await page
    .getByRole("button", { name: "Close details", exact: true })
    .click();
  await page.locator(".ow-desk").filter({ hasText: "Recruiter" }).click();
  await page
    .getByRole("button", { name: "Hire a teammate", exact: true })
    .click();
  await page.getByRole("dialog").waitFor();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Close details", exact: true })
    .click();
  await page.screenshot({ path: `${output}/office.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  assert.deepEqual(errors, []);
  await fs.writeFile(
    `${output}/result.json`,
    JSON.stringify(
      {
        status: "PASS",
        draftId: draft.id,
        agentId: member.id,
        promptBytes: Buffer.byteLength(edited),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: saved draft restored, edited prompt applied to new and existing agent, scope preserved, recruiter token attribution, hire entry and mobile layout",
  );
} finally {
  await browser.close();
  ws.close();
}
