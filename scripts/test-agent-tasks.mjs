// Exercise the real office → agent → task navigation against an in-memory bridge.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.OCTIQOS_PLAYWRIGHT_MODULE ?? "@playwright/test");
const output = await mkdtemp(path.join(tmpdir(), "octiq-agent-tasks-"));
const agent = { id: "alex", orgId: "org", name: "Alex", professionId: "writer", provider: "codex", model: "default", kind: "worker", allProjects: true, projectIds: [], avatar: null, appearance: "Owl", desk: 0 };
const task = (id, title, status, extra = {}) => ({ id, title, status, orgId: "org", projectId: "project", detail: "Write a chapter that preserves character motivation and established continuity.", route: "direct", agentId: "alex", workflowId: null, steps: [], step: 0, messages: [], evidence: "", generation: 0, createdAt: 1, ...extra });
const initial = {
  revision: 1,
  orgs: [{ id: "org", name: "Starfall Media", description: "A focused writing team." }],
  projects: [{ id: "project", orgId: "org", name: "Starfall", context: "Story", workspacePath: "/fixture/starfall" }],
  professions: [{ id: "writer", orgId: "org", name: "Chapter Writer", kind: "custom", guidance: "Write" }, { id: "editor", orgId: "org", name: "Editor", kind: "custom", guidance: "Review" }],
  agents: [agent, { ...agent, id: "quinn", name: "Quinn", professionId: "editor", desk: 1 }],
  workflows: [],
  tasks: [
    task("chapter", "Draft the arrival chapter", "needs_input", { route: "auto", messages: [{ id: "q", actor: "alex", body: "Should the arrival feel hopeful or unsettling?", createdAt: 1 }], steps: [
      { professionId: "writer", agentId: "alex", instruction: "Write the arrival scene from Mira’s perspective.", evidence: "" },
      { professionId: "editor", agentId: null, instruction: "Review character motivation and continuity.", evidence: "" },
    ] }),
    task("review", "Review the archive chapter", "verifying", { agentId: "quinn", route: "auto", step: 2, steps: [
      { professionId: "writer", agentId: "alex", instruction: "Draft the archive chapter.", evidence: "Draft ready." },
      { professionId: "editor", agentId: "quinn", instruction: "Review the draft.", evidence: "Continuity checked." },
    ], messages: [{ id: "reviewed", actor: "quinn", body: "The archive chapter is ready for your verification.", createdAt: 2 }] }),
    task("done", "The opening chapter", "done", { evidence: "Founder reviewed the opening." }),
    task("other", "QUINN PRIVATE TASK", "working", { agentId: "quinn" }),
  ],
  meetings: [], memories: [], runs: [], usage: [], xp: [],
};
const mockBridge = `
let world = ${JSON.stringify(initial)};
window.taskCalls = [];
window.failNext = false;
const snapshot = () => ({ world: structuredClone(world), stats: [], providers: { codex: true } });
export const bridge = {
  state: "open",
  onState(fn) { fn("open"); return () => {}; },
  async invoke(cmd, args) {
    if (cmd === "world_snapshot") return snapshot();
    window.taskCalls.push({ cmd, args });
    if (window.failNext) { window.failNext = false; throw new Error("Connection interrupted. Try again."); }
    if (cmd === "world_update_project") {
      const project = world.projects.find(p => p.id === args.projectId);
      Object.assign(project, { workspacePath: args.workspacePath, context: args.context, runnerImage: args.runnerImage });
      world.revision++;
      return { result: { id: project.id }, snapshot: snapshot() };
    }
    const task = world.tasks.find(t => t.id === args.taskId);
    if (cmd === "world_task_direction") {
      task.messages.push({ id: crypto.randomUUID(), actor: "founder", body: args.body, createdAt: 2 });
      task.status = args.control === "pause" ? "paused" : args.control === "cancel" ? "cancelled" : "queued";
    } else if (cmd === "world_verify_task") {
      task.status = "done"; task.evidence = args.evidence;
    } else throw new Error("Unexpected mutation: " + cmd);
    world.revision++;
    return { result: { id: task.id }, snapshot: snapshot() };
  },
};
`;
const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { WorldPortal } from "/src/os/world/WorldPortal.tsx";
import "/src/styles.css";
createRoot(document.getElementById("root")).render(React.createElement(WorldPortal));
`;
const server = await createServer({
  root: fileURLToPath(new URL("../web", import.meta.url)),
  configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)),
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  plugins: [{
    name: "agent-task-test-fixture", enforce: "pre",
    resolveId(id) {
      if (id === "agent-task-fixture") return "\0agent-task-fixture";
      if (id.endsWith("/lib/bridge")) return "\0task-test-bridge";
    },
    load(id) {
      if (id === "\0agent-task-fixture") return fixture;
      if (id === "\0task-test-bridge") return mockBridge;
    },
    configureServer(server) {
      server.middlewares.use("/__agent-task-test", async (_req, res, next) => {
        try {
          res.setHeader("Content-Type", "text/html");
          res.end(await server.transformIndexHtml("/__agent-task-test", '<html><body><div id="root"></div><script type="module">import "agent-task-fixture"</script></body></html>'));
        } catch (error) { next(error); }
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OCTIQOS_CHROME_EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__agent-task-test`);
  await page.locator(".ow-building").filter({ hasText: "Starfall Media" }).click();
  await page.locator(".ow-desk").filter({ hasText: "Alex" }).click();
  const list = page.getByRole("region", { name: "Alex's tasks" });
  await list.waitFor();
  assert.equal(await list.getByRole("button", { name: /QUINN PRIVATE TASK/ }).count(), 0);
  assert.equal(await list.locator(".ow-agent-task").count(), 2);
  assert.equal(await page.evaluate(() => window.taskCalls.length), 0);
  await page.screenshot({ animations: "disabled", path: path.join(output, "agent-task-list.png") });

  await list.getByRole("button", { name: /Draft the arrival chapter/ }).click();
  const chat = page.getByRole("region", { name: "Task conversation", exact: true });
  const plan = page.getByRole("region", { name: "Task plan", exact: true });
  const input = page.getByRole("textbox", { name: "Message about this task" });
  await input.waitFor();
  assert.equal(await page.evaluate(() => window.taskCalls.length), 0, "Selecting a task must not start work");
  const left = await chat.boundingBox(), right = await plan.boundingBox();
  assert.ok(left.x + left.width <= right.x);
  assert.equal(await chat.getByText("Should the arrival feel hopeful or unsettling?", { exact: true }).count(), 1);
  assert.equal(await chat.getByText("The archive chapter is ready for your verification.", { exact: true }).count(), 0);
  assert.equal(await plan.getByText("Review character motivation and continuity.", { exact: true }).count(), 1);
  await page.screenshot({ animations: "disabled", path: path.join(output, "task-conversation-desktop.png") });

  await input.fill("Hopeful");
  await input.press("Shift+Enter");
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  assert.equal(await page.evaluate(() => window.taskCalls.length), 0);
  await input.fill("Hopeful, with a hint of uncertainty.");
  await page.evaluate(() => { window.failNext = true; });
  await input.press("Enter");
  await chat.getByRole("alert").waitFor();
  assert.equal(await input.inputValue(), "Hopeful, with a hint of uncertainty.");
  await input.press("Enter");
  await chat.getByText("Hopeful, with a hint of uncertainty.", { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.taskCalls.at(-1))).args.taskId, "chapter");
  await chat.getByText("Task controls", { exact: true }).click();
  await chat.getByRole("button", { name: "Pause", exact: true }).click();
  await plan.getByText("Paused", { exact: true }).waitFor();
  await chat.getByRole("button", { name: "Resume", exact: true }).click();
  await plan.getByText("Queued", { exact: true }).waitFor();

  await page.getByRole("button", { name: "Back to Alex’s tasks", exact: false }).click();
  await list.waitFor();
  await list.getByRole("button", { name: /Review the archive chapter/ }).click();
  assert.equal(await chat.getByText("Hopeful, with a hint of uncertainty.", { exact: true }).count(), 0);
  const verify = page.getByRole("button", { name: "Verify and complete" });
  assert.equal(await verify.isDisabled(), true);
  await page.getByRole("textbox", { name: "Verification evidence" }).fill("Read the chapter and checked continuity.");
  await page.evaluate(() => { window.failNext = true; });
  await verify.click();
  await plan.getByRole("alert").waitFor();
  await verify.click();
  await plan.getByText("Done", { exact: true }).waitFor();
  assert.equal(await input.count(), 0, "Closed tasks are read-only");
  await page.getByRole("button", { name: "Back to Alex’s tasks", exact: false }).click();
  await list.getByRole("button", { name: "Closed · 2", exact: true }).click();
  await list.getByRole("button", { name: /The opening chapter/ }).click();
  assert.equal(await plan.getByText("Founder reviewed the opening.", { exact: true }).count(), 1);
  await page.getByRole("button", { name: "Back to Alex’s tasks", exact: false }).click();
  await list.getByRole("button", { name: /Draft the arrival chapter/ }).click();
  assert.equal(await chat.getByText("Hopeful, with a hint of uncertainty.", { exact: true }).count(), 1);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Plan", exact: true }).click();
  assert.equal(await plan.isVisible(), true);
  assert.equal(await chat.isVisible(), false);
  await page.screenshot({ animations: "disabled", path: path.join(output, "task-plan-mobile.png") });
  await page.getByRole("button", { name: "Reply in conversation", exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.tagName === "TEXTAREA");
  await page.screenshot({ animations: "disabled", path: path.join(output, "task-conversation-mobile.png") });
  assert.ok(await page.evaluate(() => {
    const dialog = document.querySelector("dialog");
    return dialog.scrollHeight <= dialog.clientHeight && dialog.scrollWidth <= dialog.clientWidth;
  }), "Mobile task workspace must not overflow");
  await page.getByRole("button", { name: "Back to Alex’s tasks", exact: false }).click();
  await list.waitFor();
  await list.getByRole("button", { name: /Draft the arrival chapter/ }).click();
  await page.setViewportSize({ width: 320, height: 568 });
  assert.ok(await page.evaluate(() => document.querySelector('[aria-label="Task messages"]').clientHeight > 0));
  await page.getByRole("button", { name: "Back to Alex’s tasks", exact: false }).click();
  await page.getByRole("dialog", { name: "agent details", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("navigation", { name: "OctiqOS navigation" }).getByRole("button", { name: "Tasks", exact: false }).click();
  await page.locator(".ow-mobile-item").filter({ hasText: "Draft the arrival chapter" }).click();
  await page.getByRole("button", { name: "Back to tasks", exact: false }).click();
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(await page.locator(".ow-mobile-item").filter({ hasText: "Draft the arrival chapter" }).count(), 1, "Board entry returns to the task list");
  // Existing context-only projects can be linked to a workspace without recreation.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "setup", exact: true }).click();
  await page.getByRole("button", { name: "Edit project", exact: true }).click();
  const workspace = page.getByRole("textbox", { name: "Workspace folder", exact: true });
  assert.equal(await workspace.inputValue(), "/fixture/starfall");
  await workspace.fill("/fixture/starfall-linked");
  await page.evaluate(() => { window.failNext = true; });
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await page.getByRole("dialog").getByRole("alert").waitFor();
  assert.equal(await workspace.inputValue(), "/fixture/starfall-linked");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await page.locator(".ow-setup-row").getByText("/fixture/starfall-linked", { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.taskCalls.at(-1))).args.workspacePath, "/fixture/starfall-linked");
  assert.deepEqual(errors, []);
  console.log(`Agent/task browser checks passed. Screenshots: ${output}`);
} finally {
  await browser?.close();
  await server.close();
}
