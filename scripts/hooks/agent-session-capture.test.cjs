"use strict";
// Runnable check for the nested-agent guard. No framework: `node <this file>`.
const assert = require("node:assert");
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

console.log("ok");
