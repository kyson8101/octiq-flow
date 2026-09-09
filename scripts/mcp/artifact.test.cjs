"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { validateArtifact, renderArtifact, createArtifact } = require("./artifact.cjs");
const sample = () => ({ artifactId: "review", revision: 1, title: "Review", items: [{ id: "a", title: "First", body: "Read this" }] });

test("review defaults, custom options, comments-only and read mode", () => {
  assert.deepEqual(validateArtifact(sample()).items[0].options.map(v => v.id), ["accept", "modify", "defer"]);
  const input = sample();
  input.items[0].options = [{ id: "choice-a", label: "A" }];
  assert.equal(validateArtifact(input).items[0].options[0].id, "choice-a");
  assert.deepEqual(validateArtifact({ ...input, mode: "read" }).items[0].options, []);
  input.items[0].options = [];
  assert.deepEqual(validateArtifact(input).items[0].options, []);
  assert.equal(validateArtifact({ ...sample(), language: "zh-CN" }).items[0].options[0].label, "接受");
});

test("rejects ambiguous IDs, invalid modes, revisions and oversized content", () => {
  for (const patch of [{ artifactId: "../escape" }, { revision: 0 }, { revision: 1.1 }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { mode: "oops" }, { items: [] }, { title: " " }, { language: "oops" }]) assert.throws(() => validateArtifact({ ...sample(), ...patch }));
  const input = sample();
  input.items.push({ ...input.items[0] });
  assert.throws(() => validateArtifact(input), /Duplicate item/);
  input.items.pop();
  input.items[0].options = [{ id: "same", label: "a" }, { id: "same", label: "b" }];
  assert.throws(() => validateArtifact(input), /Duplicate option/);
  input.items[0].options = null;
  input.items[0].body = "x".repeat(50001);
  assert.throws(() => validateArtifact(input), /item.body/);
});

test("script-like content stays inert and generated runtime parses", () => {
  const input = sample();
  input.title = '</script><script>throw new Error("injected")</script>';
  input.items[0].body = '<img src=x onerror=alert(1)> & 中文 \u2028';
  const html = renderArtifact(input);
  const scripts = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 3);
  assert.equal(JSON.parse(scripts[0][1]).title, input.title);
  assert.equal(JSON.parse(scripts[0][1]).items[0].body, input.items[0].body);
  assert.doesNotThrow(() => new vm.Script(scripts[2][1]));
  assert.ok(!html.includes(input.title));
  assert.ok(html.includes("connect-src 'none'"));
});

test("writes exclusive private HTML files without replacing prior revisions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-artifact-test-"));
  const input = { ...sample(), outputDir: dir };
  const first = createArtifact(input);
  const second = createArtifact(input);
  assert.notEqual(first.filePath, second.filePath);
  assert.equal(path.dirname(first.filePath), dir);
  assert.equal(fs.statSync(first.filePath).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(first.filePath, "utf8"), renderArtifact(input));
  assert.throws(() => createArtifact({ ...input, artifactId: "../bad" }));
  assert.throws(() => createArtifact({ ...input, outputDir: first.filePath }));
  assert.throws(() => createArtifact({ ...input, outputDir: "" }));
});

test("MCP lists and calls artifact tool both standalone and chat-bound; errors stay in protocol", () => {
  for (const chat of ["", "test-chat"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-artifact-mcp-"));
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create_artifact", arguments: { ...sample(), outputDir: dir } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "create_artifact", arguments: {} } },
    ];
    const proc = spawnSync(process.execPath, [path.join(__dirname, "octiq-ask.cjs")], { env: { ...process.env, OCTIQ_CHAT_KEY: chat }, input: requests.map(v => JSON.stringify(v)).join("\n") + "\n", encoding: "utf8", timeout: 5000 });
    assert.equal(proc.status, 0, proc.stderr);
    const replies = proc.stdout.trim().split("\n").map(v => JSON.parse(v));
    assert.ok(replies.find(v => v.id === 1).result.tools.some(t => t.name === "create_artifact"));
    const result = JSON.parse(replies.find(v => v.id === 2).result.content[0].text);
    assert.ok(fs.existsSync(result.filePath));
    assert.equal(result.artifactId, "review");
    assert.equal(replies.find(v => v.id === 3).result.isError, true);
  }
});

test("feedback round-trip keeps pending items, validates revisions and option IDs", () => {
  const { normalizeFeedback } = require("./artifact.cjs");
  const data = validateArtifact({ ...sample(), items: [...sample().items, { id: "b", title: "Second", body: "", options: [] }] });
  const feedback = { schemaVersion: 1, artifactId: "review", revision: 1, items: [
    { id: "a", decision: "modify", comment: '中文\n</script><script>alert(1)</script>', status: "decided" },
    { id: "b", decision: null, comment: "", status: "pending" },
  ], overallComment: "Overall" };
  const normalized = normalizeFeedback(data, feedback);
  assert.equal(normalized.items[0].comment, feedback.items[0].comment);
  assert.equal(normalized.items[1].decision, null);
  const embedded = JSON.stringify(normalized).replace(/</g, "\\u003c");
  assert.ok(!embedded.includes("</script>"));
  assert.deepEqual(normalizeFeedback(data, JSON.parse(embedded)), normalized);
  for (const patch of [{ revision: 2 }, { artifactId: "other" }, { schemaVersion: 2 }, { items: feedback.items.slice(0, 1) }, { overallComment: null }]) assert.throws(() => normalizeFeedback(data, { ...feedback, ...patch }));
  assert.throws(() => normalizeFeedback(data, { ...feedback, items: [feedback.items[0], feedback.items[0]] }));
  assert.throws(() => normalizeFeedback(data, { ...feedback, items: [{ ...feedback.items[0], decision: "unknown" }, feedback.items[1]] }));
  assert.throws(() => normalizeFeedback(data, { ...feedback, items: [feedback.items[0], { ...feedback.items[1], decision: "accept" }] }));
  assert.deepEqual(normalizeFeedback(data, { ...feedback, items: [...feedback.items].reverse() }), normalized);
});
