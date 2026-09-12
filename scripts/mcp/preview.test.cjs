"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { previewImage } = require("./preview.cjs");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
const setup = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-image-test-")); const source = path.join(root, "source.png"); fs.writeFileSync(source, PNG); return { root, source }; };

function mcp(root, key, method, params) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "octiq-ask.cjs")], { env: { ...process.env, OCTIQ_ROOT: root, OCTIQ_CHAT_KEY: key }, stdio: ["pipe", "pipe", "pipe"] });
    let out = ""; let errors = "";
    child.stdout.on("data", chunk => { out += chunk; if (out.includes("\n")) { resolve(JSON.parse(out.split("\n")[0])); child.stdin.end(); } });
    child.stderr.on("data", chunk => errors += chunk);
    child.on("error", reject);
    child.on("exit", code => { if (!out) reject(Error(`MCP exited ${code}: ${errors}`)); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n");
  });
}

test("snapshots preserve overwritten sources and isolate conversation slots", () => {
  const { root, source } = setup();
  const first = previewImage({ path: source, slot: "hero" }, root, "chat:one");
  fs.writeFileSync(source, Buffer.concat([PNG, Buffer.from("revision")]));
  const next = previewImage({ path: source, slot: "hero", title: "Revision" }, root, "chat:one");
  const other = previewImage({ path: source, slot: "hero" }, root, "chat:two");
  assert.deepEqual(fs.readFileSync(first.path), PNG);
  assert.notDeepEqual(fs.readFileSync(next.path), PNG);
  assert.equal(first.slot, next.slot);
  assert.notEqual(first.id, next.id);
  assert.notEqual(path.dirname(first.path), path.dirname(other.path));
  assert.equal(fs.statSync(first.path).mode & 0o777, 0o600);
});

test("rejects invalid paths, formats, oversized files and redirected stores", () => {
  const { root, source } = setup();
  assert.throws(() => previewImage({ path: source }, root, "chat:../two"));
  assert.throws(() => previewImage({ path: "relative.png" }, root, "chat:one"));
  assert.throws(() => previewImage({ path: root }, root, "chat:one"));
  assert.throws(() => previewImage({ path: source, slot: " " }, root, "chat:one"));
  fs.writeFileSync(source, "<html>not an image</html>");
  assert.throws(() => previewImage({ path: source }, root, "chat:one"), /PNG/);
  fs.truncateSync(source, 21 * 1024 * 1024);
  assert.throws(() => previewImage({ path: source }, root, "chat:one"), /20 MB/);
  fs.writeFileSync(source, PNG);
  fs.mkdirSync(path.join(root, "previews"));
  fs.symlinkSync(root, path.join(root, "previews/one"));
  assert.throws(() => previewImage({ path: source }, root, "chat:one"), /symlink/);
});

test("stdio MCP discovery and concurrent publishing preserve every image", async () => {
  const { root, source } = setup();
  const standalone = await mcp(root, "", "tools/list");
  assert.ok(!standalone.result.tools.some(tool => tool.name === "preview_image"));
  const bound = await mcp(root, "chat:one", "tools/list");
  assert.ok(bound.result.tools.some(tool => tool.name === "preview_image"));
  const denied = await mcp(root, "", "tools/call", { name: "preview_image", arguments: { path: source } });
  assert.equal(denied.result.isError, true);
  const results = await Promise.all(Array.from({ length: 8 }, () => mcp(root, "chat:one", "tools/call", { name: "preview_image", arguments: { path: source, slot: "shared" } })));
  for (const result of results) assert.ok(!result.result.isError);
  assert.equal(fs.readdirSync(path.join(root, "previews/one")).filter(file => file.endsWith(".json")).length, 8);
});

test("HTML accepts file or inline source and snapshots revisions without altering the document", async () => {
  const { previewHtml } = require("./preview.cjs");
  const { root } = setup();
  const html = '<!doctype html><html><body><h1>Review 中文</h1><script>window.ready = true;</script></body></html>';
  const source = path.join(root, "review.html");
  fs.writeFileSync(source, html);
  const first = previewHtml({ path: source, slot: "review", title: "Review" }, root, "chat:one");
  const next = previewHtml({ html: "<h1>Revision two</h1>", slot: "review" }, root, "chat:one");
  fs.writeFileSync(source, "replaced");
  assert.equal(first.kind, "html");
  assert.equal(fs.readFileSync(first.path, "utf8"), html);
  assert.equal(fs.readFileSync(next.path, "utf8"), "<h1>Revision two</h1>");
  assert.equal(first.slot, next.slot);
  const list = await mcp(root, "chat:one", "tools/list");
  assert.ok(list.result.tools.some(tool => tool.name === "preview_html"));
  const standalone = await mcp(root, "", "tools/list");
  assert.ok(!standalone.result.tools.some(tool => tool.name === "preview_html"));
  const result = await mcp(root, "chat:one", "tools/call", { name: "preview_html", arguments: { html, title: "MCP document" } });
  assert.ok(!result.result.isError);
  const entry = JSON.parse(result.result.content[0].text);
  assert.equal(entry.kind, "html");
  assert.equal(fs.readFileSync(entry.path, "utf8"), html);
  const denied = await mcp(root, "", "tools/call", { name: "preview_html", arguments: { html } });
  assert.equal(denied.result.isError, true);
});

test("HTML rejects ambiguous, empty, oversized and non-UTF-8 inputs", () => {
  const { previewHtml } = require("./preview.cjs");
  const { root, source } = setup();
  for (const args of [{}, { html: " " }, { html: "a\0b" }, { html: false }, { path: source }, { path: "relative.html" }, { path: source, html: "<p>Both</p>" }, { html: "中".repeat(700_000) }]) {
    assert.throws(() => previewHtml(args, root, "chat:one"));
  }
  const invalid = path.join(root, "invalid.html");
  fs.writeFileSync(invalid, Buffer.from([0xff, 0xfe]));
  assert.throws(() => previewHtml({ path: invalid }, root, "chat:one"), /UTF-8/);
  fs.truncateSync(invalid, 3 * 1024 * 1024);
  assert.throws(() => previewHtml({ path: invalid }, root, "chat:one"), /2 MB/);
});
