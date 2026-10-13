"use strict";
// The card diagram, as the MCP server's instructions tell it to a chat agent:
// the format the page reads (web/src/lib/cardDiagram.ts), its limits, the icon
// names, and when to draw one. A front desk writes no reply of that kind and
// is told nothing about it.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

/** The `instructions` a fresh MCP process answers `initialize` with. */
function instructions(env = {}, flags = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-diagram-mcp-"));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "octiq-ask.cjs"), ...flags], {
      env: { ...process.env, OCTIQ_ROOT: root, OCTIQ_ORCHESTRATION_ATTEMPT: "", OCTIQ_FRONT_DESK: "", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let errors = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.includes("\n")) {
        resolve(JSON.parse(out.split("\n")[0]).result.instructions);
        child.stdin.end();
      }
    });
    child.stderr.on("data", (chunk) => (errors += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (!out) reject(Error(`MCP exited ${code}: ${errors}`));
    });
    child.on("close", () => fs.rmSync(root, { recursive: true, force: true }));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  });
}

test("a chat agent is told the format, the limits, the icons and when to draw one", async () => {
  const said = await instructions();
  assert.match(said, /fenced code block with the info string octiq-diagram/);
  assert.ok(said.includes('{"rows":[[{"title":"...","note":"...","icon":"...","plain":true}]]}'));
  assert.match(said, /Limits: 8 rows, 4 nodes a row, title 60 characters, note 120\./);
  assert.match(said, /Icons: moon, coffee, screen, .*, message, box\./);
  assert.match(said, /only when a relation or a flow is clearer as a picture than as a sentence, never by default, and at most one per reply\./);
});

test("the paragraph is inside what Claude Code keeps of a server's instructions", async () => {
  // Claude Code cuts a server's instructions at 4,096 characters, and these
  // are how Claude is told. At the end of them the paragraph was cut off.
  const said = await instructions();
  const end = said.indexOf("at most one per reply.") + "at most one per reply.".length;
  assert.ok(said.startsWith("A reply can hold one card diagram"), "the paragraph comes first");
  assert.ok(end > 0 && end <= 4096, `the paragraph ends at ${end}`);
});

test("an agent with no ask_user is told the same", async () => {
  assert.match(await instructions({}, ["--disable-ask-user"]), /info string octiq-diagram/);
});

test("a front desk is told nothing about diagrams", async () => {
  assert.doesNotMatch(await instructions({ OCTIQ_FRONT_DESK: "1" }), /octiq-diagram/);
});

test("the paragraph is one line the host's own prompt can be compared with", () => {
  // `agent_provider.rs` asserts its `DIAGRAM_PROMPT` is in this file word for
  // word, which only holds while the paragraph is one unbroken literal.
  const source = fs.readFileSync(path.join(__dirname, "octiq-ask.cjs"), "utf8");
  const line = /^const DIAGRAM_INSTRUCTIONS = '([^'\\\n]+)';$/m.exec(source);
  assert.ok(line, "DIAGRAM_INSTRUCTIONS is one single-quoted line");
  assert.ok(line[1].length <= 760, `the paragraph is ${line[1].length} characters`);
});
