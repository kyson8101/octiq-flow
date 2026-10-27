"use strict";
// The media block paragraph, its limits and restrained use, as a chat agent
// reads it over MCP. Rust and web tests hold the same words to the reader in
// web/src/lib/mediaBlock.ts. Front desks get no paragraph of this kind.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

/** The `instructions` a fresh MCP process answers `initialize` with. */
function instructions(env = {}, flags = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-media-mcp-"));
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

test("chat agents get one media paragraph inside the 4096 limit", async () => {
  for (const flags of [[], ["--disable-ask-user"]]) {
    const said = await instructions({}, flags);
    assert.ok(said.length <= 4096, `instructions: ${said.length}`);
    assert.match(said, /info string octiq-media/);
    assert.match(said, /One local absolute path to an image, video or audio file/);
    assert.match(said, /Limits: title 80 characters, text 1200, caption 120\./);
    assert.match(said, /never by default, and at most a few per reply\./);
  }
});

test("front desks get no media block paragraph", async () => {
  assert.doesNotMatch(await instructions({ OCTIQ_FRONT_DESK: "1" }), /octiq-media/);
});

test("the single ASCII paragraph is identical to the Rust host prompt", () => {
  const source = fs.readFileSync(path.join(__dirname, "octiq-ask.cjs"), "utf8").replace(/\r\n?/g, "\n");
  const host = fs.readFileSync(path.join(__dirname, "../../src-tauri/src/agent_provider.rs"), "utf8").replace(/\r\n?/g, "\n");
  const mcp = /^const MEDIA_INSTRUCTIONS = '([^'\\\n]+)';$/m.exec(source)?.[1];
  const rust = /const MEDIA_PROMPT: &str = r#"([^\n]+)"#;/.exec(host)?.[1];
  assert.ok(mcp);
  assert.equal(mcp, rust);
  assert.ok(mcp.length <= 560);
  assert.match(mcp, /^[\x20-\x7e]+$/);
});
