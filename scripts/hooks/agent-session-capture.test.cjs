"use strict";
// Runnable check for the nested-agent guard + the stdin capture path. No
// framework: `node <this file>`.
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { hostAgent, shouldSkipNestedWrite } = require("./agent-session-capture.cjs");

// Codex nested inside Claude (rescue subagent / plugin): Claude exported
// CLAUDECODE, Codex inherited it. The Codex hook must NOT record — else the tab
// resumes as Codex instead of Claude.
assert.strictEqual(hostAgent({ CLAUDECODE: "1" }), "claude");
assert.strictEqual(shouldSkipNestedWrite("codex", { CLAUDECODE: "1" }), true);

// Claude's own hook also sees CLAUDECODE, but host === agent, so it still records.
assert.strictEqual(shouldSkipNestedWrite("claude", { CLAUDECODE: "1" }), false);

// Top-level Codex in a plain tab shell: no host marker, records normally.
assert.strictEqual(hostAgent({}), "");
assert.strictEqual(shouldSkipNestedWrite("codex", {}), false);

// A blank marker is treated as absent.
assert.strictEqual(shouldSkipNestedWrite("codex", { CLAUDECODE: "" }), false);

// End-to-end: a SessionStart payload piped on stdin must land in the store. This
// is the check that fails on Windows without readStdin's EOF handling, because
// there fs.readFileSync(0) throws on a piped stdin (nodejs/node#35997) and the
// hook silently records nothing — so the tab never resumes its agent session.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-hook-test-"));
execFileSync(process.execPath, [path.join(__dirname, "agent-session-capture.cjs"), "claude"], {
  input: JSON.stringify({
    hook_event_name: "SessionStart",
    session_id: "sess-abc-123",
    cwd: "/w",
    transcript_path: "/t.jsonl",
  }),
  env: { ...process.env, OCTIQ_ROOT: root, OCTIQ_TERM_KEY: "tab-1", CLAUDECODE: "1" },
});
const store = JSON.parse(fs.readFileSync(path.join(root, "agent-sessions.json"), "utf8"));
assert.strictEqual(store["tab-1"].sessionId, "sess-abc-123");
assert.strictEqual(store["tab-1"].agent, "claude");
fs.rmSync(root, { recursive: true, force: true });

console.log("ok");
