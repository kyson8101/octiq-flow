"use strict";
// The MCP server's instructions, as each kind of chat is given them.
//
// Claude Code keeps only the first 4,096 characters of a server's
// instructions and drops the rest without a word (seen in a live chat on
// 2026-10-13, cut mid-word). Before this test the text was 5,658 characters:
// the end of read_conversation, the orchestration and peer sentences,
// task_status and the ask_user sentence never reached a Claude chat.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");

/** What Claude Code keeps. */
const KEPT = 4096;

function instructions(env = {}, flags = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "octiq-ask.cjs"), ...flags], {
      env: { ...process.env, OCTIQ_CHAT_KEY: "chat:lead", OCTIQ_SESSION_KEY: "", OCTIQ_CHAT_CAPABILITY: "", OCTIQ_ORCHESTRATION_ATTEMPT: "", OCTIQ_FRONT_DESK: "", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error("MCP timed out")); }, 5000);
    let out = "";
    child.on("error", reject);
    child.on("exit", () => { clearTimeout(timer); if (!out) reject(new Error("No MCP response")); });
    child.stdout.on("data", chunk => {
      out += chunk;
      if (out.includes("\n")) { clearTimeout(timer); resolve(JSON.parse(out.split("\n")[0]).result.instructions); child.stdin.end(); }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  });
}

const KINDS = [
  ["a chat with ask_user (Claude)", {}, []],
  ["a chat without ask_user (Codex)", {}, ["--disable-ask-user"]],
  ["a worker", { OCTIQ_ORCHESTRATION_ATTEMPT: "attempt_1" }, []],
  ["a worker without ask_user", { OCTIQ_ORCHESTRATION_ATTEMPT: "attempt_1" }, ["--disable-ask-user"]],
  ["a front desk", { OCTIQ_FRONT_DESK: "1" }, []],
];

test("every kind of chat gets instructions Claude Code keeps whole", async () => {
  for (const [kind, env, flags] of KINDS) {
    const said = await instructions(env, flags);
    assert.ok(
      said.length <= KEPT,
      `${kind}: the instructions are ${said.length} characters, and Claude Code keeps only the first ${KEPT}. ` +
        `The last ${said.length - KEPT} would never reach the agent: ${JSON.stringify(said.slice(KEPT - 40))}. ` +
        "Move what belongs to one tool into that tool's description, which is never cut.",
    );
  }
});

test("what used to be cut off now reaches a Claude chat", async () => {
  const said = await instructions();
  for (const kept of [
    /call read_conversation with that URL before any other action/,
    /Use orchestration tools only when the person explicitly asks/,
    /reads orchestration_snapshot as truth/,
    /Fable and Astra coordinate and never run as workers/,
    /settles its exact attempt with orchestration_worker_report/,
    /orchestration_peer_ask/,
    /orchestration_peer_request, which the person approves on the plan card/,
    /Use task_status when a task has more than a couple of steps/,
    /Ask the person a decision question with ask_user, every question in one call/,
    /Permission for an action with side effects is asked in the chat instead, never on a card\.$/,
  ]) assert.match(said, kept);
});

test("every tool the instructions used to name is still named", async () => {
  const said = await instructions();
  for (const tool of [
    "feedback_list", "feedback_submit", "feedback_update",
    "vault_info", "vault_list", "vault_search", "vault_read",
    "set_chat_title",
    "agent_list", "agent_register", "agent_update", "agent_delete", "agent_policy_update",
    "team_create", "team_update",
    "request_access",
    "handover", "handover_ask", "handover_outcome",
    "preview_html", "preview_image", "create_artifact",
    "search_conversations", "read_conversation",
    "orchestration_snapshot", "orchestration_worker_report", "orchestration_peer_ask", "orchestration_peer_request",
    "task_status", "ask_user",
  ]) assert.ok(said.includes(tool), tool);
});

test("a chat agent is told when to keep a plan, in one sentence right after the diagram", async () => {
  const sentence = "When the person says several things are coming before work starts, or asks for a plan, keep one with plan_update, ask scoping questions as they come, and start no work until they press Start: the plan_update description says how.";
  for (const flags of [[], ["--disable-ask-user"]]) {
    const said = await instructions({}, flags);
    const at = said.indexOf(sentence);
    assert.ok(at > 0, "the sentence is there");
    assert.ok(said.startsWith("A reply can hold one card diagram"), "the diagram comes first");
    assert.equal(said.slice(0, at).trimEnd().endsWith("at most one per reply."), true, "and the plan sentence second");
    assert.ok(at + sentence.length <= 1024, `it ends at ${at + sentence.length}`);
  }
  // One line, and nothing a POSIX or a JavaScript quote has to escape: the
  // host says it word for word to Codex's app-server and to Antigravity.
  assert.doesNotMatch(sentence, /[\n'"\\]/);
});

test("a worker and a front desk keep no plan and are not told to", async () => {
  assert.doesNotMatch(await instructions({ OCTIQ_ORCHESTRATION_ATTEMPT: "attempt_1" }), /plan_update|plan_read/);
  assert.doesNotMatch(await instructions({ OCTIQ_FRONT_DESK: "1" }), /plan_update|plan_read/);
  // A worker is still told the rest.
  assert.match(await instructions({ OCTIQ_ORCHESTRATION_ATTEMPT: "attempt_1" }), /orchestration_worker_report/);
});
