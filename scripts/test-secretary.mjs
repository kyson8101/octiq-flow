// Isolated UI test: mounts the real Secretary with an in-memory backend.
// OCTIQOS_PLAYWRIGHT_MODULE may point to an existing Playwright installation.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.OCTIQOS_PLAYWRIGHT_MODULE ?? "@playwright/test");
const output = await mkdtemp(path.join(tmpdir(), "octiq-secretary-ui-"));
const blueprint = {
  summary: "A focused writing team for Starfall Media. You keep creative direction and final approval.",
  projects: [{ name: "Starfall", context: "Plan and write the Starfall story together." }],
  professions: [{ name: "Story Planner", kind: "custom", guidance: "Develop outlines, character arcs and continuity." }],
  agents: [{ name: "Nova", profession: "Story Planner", projects: ["Starfall"] }],
  workflows: [{ name: "Chapter planning", professions: ["Story Planner"] }],
  questions: ["Should the editor review every chapter, or only the chapters you select?"],
  warnings: [],
};
const secretary = { id: "secretary", orgId: "org", name: "Secretary", professionId: "role", provider: "codex", model: "default", kind: "consultant", allProjects: false, projectIds: [], avatar: null, appearance: "Owl", desk: 0 };
const draft = { id: "first", orgId: "org", secretaryId: "secretary", message: "Help me organize the Starfall writing team.", status: "ready", blueprint, error: null, baseSignature: 1, createdAt: 1 };
const initial = { orgs: [{ id: "org", name: "Starfall Media", description: "" }], projects: [], professions: [], agents: [secretary], workflows: [], tasks: [], meetings: [], secretaryDrafts: [draft], memories: [], runs: [], usage: [], xp: [], revision: 1 };
const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { SecretaryDesk } from "/src/os/world/Secretary.tsx";
import { Modal } from "/src/os/world/Forms.tsx";
import "/src/styles.css";
import "/src/os/world/world.css";
const initial = ${JSON.stringify(initial)};
const initialBlueprint = ${JSON.stringify(blueprint)};
let world = structuredClone(initial);
let update;
window.calls = [];
window.failNext = false;
window.replaceDrafts = (drafts) => { world = { ...world, secretaryDrafts: drafts }; update(world); };
window.inspected = () => window.replaceDrafts(world.secretaryDrafts.map((d, index) => index === world.secretaryDrafts.length - 1 ? { ...d, fileActivity: [{ action: "read_file", workspacePath: world.secretaryWorkspaces[0].path, path: "AGENTS.md", error: null }] } : d));
window.finish = (status = "ready") => {
  const drafts = [...world.secretaryDrafts];
  const last = drafts.at(-1);
  drafts[drafts.length - 1] = { ...last, status, blueprint: status === "ready" ? { ...initialBlueprint, summary: "The editor will review every chapter.", questions: [], projects: [{ name: "Starfall", context: "Every chapter receives an editorial review.", workspacePath: world.secretaryWorkspaces?.[0]?.path }] } : null, error: status === "failed" ? "Provider unavailable. Please try again." : null };
  window.replaceDrafts(drafts);
};
function App() {
  const [current, setCurrent] = useState(world);
  const [open, setOpen] = useState(true);
  const [error, setError] = useState("");
  update = setCurrent;
  const mutate = async (action, args) => {
    window.calls.push({ action, args });
    setError("");
    if (window.failNext) { window.failNext = false; setError("Connection interrupted. Try again."); throw new Error("offline"); }
    if (action === "authorize_secretary_workspace" || action === "revoke_secretary_workspace") {
      const id = args.workspaceId ?? crypto.randomUUID();
      const folders = world.secretaryWorkspaces ?? [];
      world = { ...world, secretaryWorkspaces: action === "authorize_secretary_workspace" ? [...folders, { id, orgId: args.orgId, path: args.path }] : folders.filter(f => f.id !== id), secretaryDrafts: world.secretaryDrafts.map(d => ({ ...d, status: d.status === "ready" ? "stale" : ["queued", "generating"].includes(d.status) ? "cancelled" : d.status })) };
      update(world);
      return { id };
    }
    if (action === "create_secretary_request") {
      const next = { ...${JSON.stringify(draft)}, id: crypto.randomUUID(), message: args.message, status: "queued", blueprint: null };
      window.replaceDrafts([...world.secretaryDrafts, next]);
      return { id: next.id };
    }
    window.replaceDrafts(world.secretaryDrafts.map(d => d.id === args.draftId ? { ...d, status: action === "cancel_secretary_request" ? "cancelled" : "applied" } : d));
    return { id: args.draftId };
  };
  return React.createElement(React.Fragment, null,
    React.createElement("button", { onClick: () => setOpen(true) }, "Open Secretary"),
    open && React.createElement(Modal, { title: "Starfall Media Secretary", close: () => setOpen(false), className: "ow-secretary-modal" },
      React.createElement(SecretaryDesk, { world: current, orgId: "org", secretary: initial.agents[0], mutate, busy: false, error })));
}
createRoot(document.getElementById("root")).render(React.createElement(App));
`;
const server = await createServer({
  root: fileURLToPath(new URL("../web", import.meta.url)),
  configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)),
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  plugins: [{
    name: "secretary-test-fixture",
    resolveId(id) { if (id === "secretary-test-fixture") return "\0secretary-test-fixture"; },
    load(id) { if (id === "\0secretary-test-fixture") return fixture; },
    configureServer(server) {
      server.middlewares.use("/__secretary-test", async (_req, res, next) => {
        try {
          res.setHeader("Content-Type", "text/html");
          res.end(await server.transformIndexHtml("/__secretary-test", '<html><head><style>*{box-sizing:border-box}body{margin:0;background:#101b20}</style></head><body><div id="root"></div><script type="module">import "secretary-test-fixture"</script></body></html>'));
        } catch (error) { next(error); }
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OCTIQOS_CHROME_EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/__secretary-test`);
  const chat = page.getByRole("region", { name: "Secretary conversation", exact: true });
  const plan = page.getByRole("region", { name: "Blueprint preview", exact: true });
  const input = page.getByRole("textbox", { name: "Message your Secretary" });
  const confirm = page.getByRole("button", { name: "Confirm and apply blueprint" });
  await input.waitFor();
  const left = await chat.boundingBox(), right = await plan.boundingBox();
  assert.ok(left.x + left.width <= right.x, "Desktop panels must be side by side");
  assert.ok(Math.abs(left.y - right.y) < 1);
  assert.equal(await confirm.isDisabled(), true);
  assert.equal(await chat.getByText(blueprint.questions[0], { exact: true }).count(), 1);
  assert.equal(await plan.getByText(blueprint.questions[0], { exact: true }).count(), 0);
  await page.screenshot({ animations: "disabled", path: path.join(output, "desktop-question.png") });

  // Normal chat, including multiline and IME input, must not accidentally send.
  await input.fill("Every chapter");
  await input.press("Shift+Enter");
  assert.match(await input.inputValue(), /\n/);
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  assert.equal(await page.evaluate(() => window.calls.length), 0);
  await input.fill("Every chapter, please.");
  await input.press("Enter");
  await page.getByRole("button", { name: "Stop", exact: true }).waitFor();
  assert.equal(await input.inputValue(), "");
  assert.equal(await confirm.isDisabled(), true);
  assert.equal(await plan.getByText("Nova", { exact: true }).count(), 1);
  await input.fill("A later thought");
  await input.press("Enter");
  assert.equal(await page.evaluate(() => window.calls.length), 1, "Do not submit during generation");
  await page.evaluate(() => window.finish());
  await page.waitForFunction(() => !document.querySelector(".ow-secretary-confirm .ow-primary").disabled);
  assert.equal(await input.inputValue(), "A later thought", "Preserve text composed while thinking");
  assert.equal(await plan.locator(".ow-blueprint-changed").count(), 1);
  await page.screenshot({ animations: "disabled", path: path.join(output, "desktop-revised.png") });

  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Open Secretary", exact: true }).click();
  assert.equal(await chat.getByText("Every chapter, please.", { exact: true }).count(), 1, "Reopening restores conversation");
  await page.evaluate(() => { window.failNext = true; });
  await confirm.click();
  await plan.getByRole("alert").waitFor();
  assert.equal(await chat.getByRole("alert").count(), 0, "Apply errors appear alongside the plan");
  await confirm.click();
  await chat.getByText("Blueprint applied to this organization.", { exact: true }).waitFor();
  assert.equal(await confirm.isDisabled(), true);

  await page.evaluate(() => { window.failNext = true; });
  await input.fill("Please add another writer");
  await input.press("Enter");
  await page.getByRole("alert").waitFor();
  assert.equal(await input.inputValue(), "Please add another writer", "Submission failure preserves the message");
  await input.press("Enter");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await chat.getByText("Stopped. You can send another message to continue.").waitFor();
  assert.equal(await confirm.isDisabled(), true);

  await input.fill("Try the revised team again");
  await input.press("Enter");
  await page.evaluate(() => window.finish("failed"));
  await chat.getByText("Provider unavailable. Please try again.").waitFor();
  assert.equal(await confirm.isDisabled(), true);

  // A path is a suggestion, never implicit access. Permission and messages persist independently.
  const access = page.locator(".ow-secretary-folder-access");
  const folder = page.getByLabel("Folder on the server", { exact: true });
  const allow = page.getByRole("button", { name: "Allow read-only access", exact: true });
  const beforeAccess = await page.evaluate(() => window.calls.length);
  await input.fill("Read /Users/kyson/03-projects/starfall/AGENTS.md and plan the team");
  await access.locator("summary").click();
  assert.equal(await folder.inputValue(), "/Users/kyson/03-projects/starfall");
  await folder.press("Enter");
  assert.equal(await page.evaluate(() => window.calls.length), beforeAccess);
  await page.evaluate(() => { window.failNext = true; });
  await allow.click();
  await access.getByRole("alert").waitFor();
  assert.equal(await folder.inputValue(), "/Users/kyson/03-projects/starfall");
  await allow.click();
  await page.getByRole("button", { name: "Remove access to /Users/kyson/03-projects/starfall", exact: true }).waitFor();
  assert.equal(await confirm.isDisabled(), true, "Changing scope invalidates the old preview");
  assert.match(await input.inputValue(), /Read .*AGENTS.md/);
  await input.press("Enter");
  assert.equal(await allow.isDisabled(), true, "Do not change scope while preparing a reply; removal remains available");
  await page.evaluate(() => window.inspected());
  await page.locator(".ow-secretary-file-activity summary").click();
  await chat.getByText("Read: /Users/kyson/03-projects/starfall/AGENTS.md", { exact: true }).waitFor();
  await page.evaluate(() => window.finish());
  await page.waitForFunction(() => !document.querySelector(".ow-secretary-confirm .ow-primary").disabled);
  await plan.getByText("Workspace: /Users/kyson/03-projects/starfall", { exact: false }).waitFor();
  await page.screenshot({ animations: "disabled", path: path.join(output, "desktop-folder-access.png") });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Open Secretary", exact: true }).click();
  await access.locator("summary").click();
  assert.equal(await page.getByRole("button", { name: "Remove access to /Users/kyson/03-projects/starfall", exact: true }).count(), 1);
  await input.fill("Read the workflow next");
  await input.press("Enter");
  await page.getByRole("button", { name: "Remove access to /Users/kyson/03-projects/starfall", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Stop", exact: true }).count(), 0, "Revocation stops the active inspection");
  assert.equal(await confirm.isDisabled(), true);
  await access.locator("summary").click();

  // Restore the unanswered turn to verify narrow layouts and reply navigation.
  await page.evaluate(draft => window.replaceDrafts([draft]), draft);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await chat.isVisible(), true);
  assert.equal(await plan.isVisible(), false);
  await page.getByRole("button", { name: "Blueprint · v1", exact: true }).click();
  assert.equal(await plan.isVisible(), true);
  assert.equal(await chat.isVisible(), false);
  await page.screenshot({ animations: "disabled", path: path.join(output, "mobile-blueprint.png") });
  await page.getByRole("button", { name: "Reply in conversation", exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.tagName === "TEXTAREA");
  assert.equal(await chat.isVisible(), true);
  assert.ok(await chat.getByText(blueprint.questions[0], { exact: true }).evaluate(el => {
    const bounds = el.getBoundingClientRect();
    const pane = el.closest('[role="log"]').getBoundingClientRect();
    return bounds.top >= pane.top && bounds.bottom <= pane.bottom;
  }), "Reply navigation brings the latest question into view");
  await page.screenshot({ animations: "disabled", path: path.join(output, "mobile-conversation.png") });
  assert.ok(await page.evaluate(() => {
    const dialog = document.querySelector("dialog");
    return dialog.scrollWidth <= dialog.clientWidth && dialog.scrollHeight <= dialog.clientHeight;
  }), "The modal must not overflow at mobile width");
  await page.setViewportSize({ width: 320, height: 568 });
  assert.ok(await page.evaluate(() => {
    const dialog = document.querySelector("dialog");
    const log = document.querySelector('[role="log"]');
    return dialog.scrollWidth <= dialog.clientWidth && dialog.scrollHeight <= dialog.clientHeight && log.clientHeight > 0;
  }), "A small phone retains a scrollable conversation and composer");
  await access.locator("summary").click();
  await folder.fill("/Users/kyson/a-project-with-a-very-long-folder-name/starfall");
  await allow.scrollIntoViewIfNeeded();
  await page.screenshot({ animations: "disabled", path: path.join(output, "mobile-folder-access.png") });
  assert.ok(await page.evaluate(() => {
    const dialog = document.querySelector("dialog");
    return dialog.scrollWidth <= dialog.clientWidth && dialog.scrollHeight <= dialog.clientHeight;
  }), "Folder permissions fit a small phone");
  await page.getByRole("button", { name: "Send", exact: true }).scrollIntoViewIfNeeded();
  assert.ok(await page.getByRole("button", { name: "Send", exact: true }).evaluate(button => {
    const pane = button.closest(".ow-secretary-conversation").getBoundingClientRect();
    const bounds = button.getBoundingClientRect();
    return bounds.bottom <= pane.bottom && document.querySelector('[role="log"]').clientHeight > 0;
  }), "An expanded permission panel must not hide the composer or consume the conversation");
  assert.deepEqual(errors, []);
  console.log(`Secretary browser checks passed. Screenshots: ${output}`);
} finally {
  await browser?.close();
  await server.close();
}
