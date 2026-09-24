// Browser integration using mock RPCs; never changes the person's inbox/chats.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const artifacts = await mkdtemp(join(tmpdir(), "octiq-feedback-ui-"));
const base = process.env.OCTIQ_TEST_URL || "http://127.0.0.1:5273/";
const browser = await chromium.launch({ channel: process.env.OCTIQ_TEST_BROWSER || "chrome", headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", permissions: ["clipboard-read", "clipboard-write"] });
  const calls = [], errors = [];
  let rejectSave = false;
  const reports = [{
    id: "feedback-one", requestId: "retry-one", title: "Queued turn stays idle after Stop", kind: "bug", severity: "high",
    description: "A queued follow-up stays idle after the active turn is stopped.", steps: "Start a task. Queue a follow-up. Press Stop.",
    expected: "The next turn starts.", actual: "The queue stays idle.", workaround: "Send the queued turn manually.",
    source: { chatId: "c", chatTitle: "Queue investigation", projectId: "p", projectName: "OctiqFlow", modelId: "codex:gpt-6-astra", appVersion: "0.2.0" },
    status: "new", note: "", createdAt: 1790226000000, updatedAt: 1790226000000, revision: 1,
  }];
  await context.route("**/token", route => route.fulfill({ body: "test-token" }));
  await context.route("**/auth", route => route.fulfill({ body: "ok" }));
  let socket;
  await context.routeWebSocket(/.*/, ws => {
    socket = ws;
    ws.onMessage(raw => {
      const call = JSON.parse(String(raw)); if (call.t !== "invoke") return; calls.push(call);
      let result = [], error;
      if (call.cmd === "list_workspaces") result = [{ id: "p", name: "OctiqFlow", primary_path: "/test/project" }];
      if (call.cmd === "chat_index_list") result = [{ id: "c", projectId: "p", title: "Queue investigation", createdAt: 1, updatedAt: 2 }];
      if (call.cmd === "chat_page") result = { events: [], context: [], before: null };
      if (call.cmd === "chat_queue_state") result = { live: false, queuedTurnIds: [] };
      if (call.cmd === "orchestration_snapshot") result = { runs: [], tasks: [], attempts: [], gates: [], messages: [], reports: [] };
      if (call.cmd === "feedback_list") {
        const filtered = reports.filter(r => (!call.args.status || r.status === call.args.status) && (!call.args.query || r.title.toLowerCase().includes(call.args.query.toLowerCase())));
        const end = call.args.offset + call.args.limit;
        result = { items: filtered.slice(call.args.offset, end), total: filtered.length, newCount: reports.filter(r => r.status === "new").length, nextOffset: end < filtered.length ? end : null };
      }
      if (call.cmd === "feedback_get") result = reports.find(r => r.id === call.args.id);
      if (call.cmd === "feedback_update") {
        const report = reports.find(r => r.id === call.args.id);
        if (rejectSave || report.revision !== call.args.expectedRevision) error = "This report changed in another window. Reload the report before saving again.";
        else {
          Object.assign(report, { status: call.args.status, note: call.args.note, revision: report.revision + 1 }); result = report;
          ws.send(JSON.stringify({ t: "event", event: "feedback-changed", payload: { id: report.id } }));
        }
      }
      ws.send(JSON.stringify({ t: "reply", id: call.id, ok: !error, result, error }));
    });
  });
  const page = await context.newPage(); page.on("pageerror", error => errors.push(String(error)));
  await page.goto(base + "#/p/octiqflow/c/c");
  await page.getByRole("button", { name: "Feedback inbox", exact: true }).click();
  await page.getByRole("button", { name: /Queued turn stays idle/ }).click();
  await page.getByRole("heading", { name: "Queued turn stays idle after Stop", exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, "desktop-dark.png"), fullPage: true });
  await page.getByRole("button", { name: "Copy fix brief", exact: true }).click();
  const brief = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(brief, /Feedback ID: feedback-one/); assert.match(brief, /The next turn starts/); assert.ok(!brief.includes("test-token"));
  await page.evaluate(async () => {
    await navigator.clipboard.writeText("fallback pending");
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  });
  await page.getByRole("button", { name: "Brief copied", exact: true }).click();
  await page.evaluate(() => { delete navigator.clipboard; });
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), brief, "clipboard fallback works inside a modal dialog");
  await page.getByLabel("Status", { exact: true }).selectOption("in_progress");
  await page.getByLabel("Triage note", { exact: true }).fill("Investigating the Stop handoff.");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".feedback-row-meta")?.textContent.includes("In progress"));
  assert.equal(reports[0].note, "Investigating the Stop handoff.");
  rejectSave = true;
  await page.getByLabel("Triage note", { exact: true }).fill("Keep this draft on conflict");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "another window" }).waitFor();
  assert.equal(await page.getByLabel("Triage note", { exact: true }).inputValue(), "Keep this draft on conflict");
  rejectSave = false;
  await page.getByRole("button", { name: "Discard changes and reload" }).click();
  // Reload must restore persisted fields even if the server revision is unchanged.
  await page.waitForFunction(() => document.querySelector(".feedback-triage textarea")?.value === "Investigating the Stop handoff.");
  await page.getByLabel("Search feedback", { exact: true }).fill("No matching title");
  await page.getByRole("heading", { name: "No matching reports" }).waitFor();
  await page.getByLabel("Search feedback", { exact: true }).fill("");
  await page.getByRole("button", { name: /Queued turn stays idle/ }).waitFor();
  for (let i = 0; i < 30; i++) reports.push({ ...reports[0], id: `more-${i}`, title: `Another issue ${i}` });
  socket.send(JSON.stringify({ t: "event", event: "feedback-changed", payload: { id: "more-29" } }));
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: /Another issue 29/ }).waitFor();
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await page.getByLabel("Filter feedback status").selectOption("resolved");
  await page.getByRole("heading", { name: "No matching reports" }).waitFor();
  await page.getByLabel("Filter feedback status").selectOption("");
  await page.getByRole("button", { name: "Open source chat", exact: true }).click();
  assert.equal(await page.getByRole("dialog", { name: "Feedback inbox" }).count(), 0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: /^Appearance/ }).click();
  await page.getByRole("radio", { name: "Light", exact: true }).click();
  await page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Feedback inbox", exact: true }).click();
  await page.getByRole("button", { name: /Queued turn stays idle/ }).click();
  await page.screenshot({ path: join(artifacts, "desktop-light.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(artifacts, "mobile-detail.png"), fullPage: true });
  await page.getByRole("button", { name: "Back to reports", exact: true }).click();
  await page.getByRole("button", { name: /Queued turn stays idle/ }).waitFor();
  await page.screenshot({ path: join(artifacts, "mobile-list.png"), fullPage: true });
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog", { name: "Feedback inbox" }).count(), 0);
  assert.deepEqual(errors, []);
  assert.ok(calls.some(call => call.cmd === "feedback_update" && call.args.expectedRevision === 1));
  console.log(JSON.stringify({ passed: true, artifacts, checked: ["list", "search", "status-filter", "pagination", "live-events", "source-chat", "copy-brief", "triage", "conflict-and-reload", "light-dark", "mobile", "escape"] }));
} finally { await browser.close(); }
