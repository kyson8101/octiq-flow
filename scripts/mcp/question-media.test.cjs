"use strict";
// ask_user media, the MCP's half: each file is read here, as the agent, and
// streamed to the host; a file that cannot be shown refuses the whole call
// before anything is asked.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { attachMedia, MediaRefusal } = require("./question-media.cjs");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-question-media-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = (name, bytes = PNG) => {
    const at = path.join(dir, name);
    fs.writeFileSync(at, bytes);
    return at;
  };
  return { dir, file };
}

const never = () => {
  throw new Error("nothing may be uploaded for a call that is refused");
};

async function refused(list, pattern) {
  await assert.rejects(attachMedia(list, never), (error) => {
    assert.ok(error instanceof MediaRefusal, `${error}`);
    assert.match(error.message, pattern);
    return true;
  });
}

/** A stand-in host: keeps what each upload sent and answers the next of
 *  `answers` (a snapshot, or `{ status, error }`). */
async function host(t, answers = []) {
  const heard = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      const body = Buffer.concat(chunks);
      heard.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
      const next = answers.shift() ?? { result: { id: `snap${heard.length}`.padEnd(32, "0"), name: url.searchParams.get("name") } };
      if (typeof next === "function") return next(res);
      res.writeHead(next.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(next.status ? { error: next.error, outcome: { origin: "octiqflow", reasonClass: "validation", severity: "error" } } : next));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  return { heard, port: server.address().port };
}

function asHost(t, port) {
  const before = { ...process.env };
  Object.assign(process.env, { OCTIQ_HOOK_PORT: String(port), OCTIQ_CHAT_KEY: "chat:media", OCTIQ_SESSION_KEY: "", OCTIQ_CHAT_CAPABILITY: "cap-1", OCTIQ_LAUNCH_ID: "launch-1" });
  t.after(() => {
    for (const key of ["OCTIQ_HOOK_PORT", "OCTIQ_CHAT_KEY", "OCTIQ_SESSION_KEY", "OCTIQ_CHAT_CAPABILITY", "OCTIQ_LAUNCH_ID"]) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  });
}

test("a call with no media is passed on as it was, and nothing is uploaded", async () => {
  const list = [{ question: "Which?", options: ["a", { label: "b" }] }];
  assert.equal(await attachMedia(list, never), list);
});

test("every file is checked before any is uploaded, and each refusal names it", async (t) => {
  const { dir, file } = scratch(t);
  const png = file("ok.png");
  await refused([{ question: "Q", media: [{ path: "relative.png" }] }], /relative\.png is not an absolute path/);
  await refused([{ question: "Q", media: [{ path: path.join(dir, "gone.png") }] }], /gone\.png does not exist/);
  await refused([{ question: "Q", media: [{ path: dir }] }], /is not a regular file/);
  await refused([{ question: "Q", media: [{ path: file("empty.png", Buffer.alloc(0)) }] }], /empty\.png is empty/);
  await refused([{ question: "Q", media: [png, png, png, png, png] }], /has 5 media files; at most 4/);
  await refused([{ question: "Q", media: [{ path: png, caption: "x".repeat(161) }] }], /caption of .*ok\.png is over 160/);
  await refused([{ question: "Q", media: [{ caption: "no path" }] }], /needs a path/);
  await refused([{ question: "Q", media: "not a list" }], /media must be a list/);
  await refused([{ question: "Q", options: [{ label: "A", image: 7 }] }], /image of option "A" must be the absolute path/);
  // A file that is fine, after one that is not: still nothing is uploaded.
  await refused([{ question: "Q", media: [png] }, { question: "R", media: [{ path: "nope" }] }], /nope is not an absolute/);
});

test("an option's image is held to an image's 20 MB, and a call to 300 MB in all", async (t) => {
  const { dir } = scratch(t);
  const sized = (name, bytes) => {
    const at = path.join(dir, name);
    fs.writeFileSync(at, PNG);
    fs.truncateSync(at, bytes);
    return at;
  };
  await refused([{ question: "Q", options: [{ label: "A", image: sized("big.png", 20 * 1024 * 1024 + 1) }] }], /big\.png is 20\.0 MB, over the 20 MB/);
  await refused([{ question: "Q", media: [sized("v1.mp4", 201 * 1024 * 1024)] }], /v1\.mp4 is 201\.0 MB, over the 200 MB/);
  const half = sized("half.mp4", 160 * 1024 * 1024);
  await refused([{ question: "Q", media: [half, half] }], /come to 320 MB, over the 300 MB one ask_user call/);
});

test("a FIFO handed over as a picture is refused without hanging the call", { skip: process.platform === "win32" }, async (t) => {
  const { dir } = scratch(t);
  const fifo = path.join(dir, "pipe.png");
  execFileSync("mkfifo", [fifo]);
  await refused([{ question: "Q", media: [{ path: fifo }] }], /pipe\.png is not a regular file/);
});

test("each file is streamed whole to the host as this chat, and named by its snapshot after", async (t) => {
  const { file } = scratch(t);
  const clip = file("clip.mp4", Buffer.concat([Buffer.from("\0\0\0\x18ftypisom"), Buffer.alloc(5000, 7)]));
  const face = file("face.png");
  const { heard, port } = await host(t);
  asHost(t, port);
  const list = [
    { question: "Which take?", media: [{ path: clip, caption: "  Take two  " }], options: ["Keep", { label: "Face", image: face, description: "d" }] },
    { question: "Free text?" },
  ];
  const out = await attachMedia(list);
  assert.equal(heard.length, 2);
  assert.equal(heard[0].path, "/hook/question-media");
  assert.deepEqual(heard[0].query, { chatKey: "chat:media", sessionKey: "chat:media", name: "clip.mp4", bytes: "5012", launchId: "launch-1" });
  assert.equal(heard[0].headers["x-octiq-chat-capability"], "cap-1");
  assert.deepEqual(heard[0].body, fs.readFileSync(clip));
  assert.equal(heard[1].query.option, "true");
  assert.deepEqual(heard[1].body, PNG);
  assert.deepEqual(out[0].media, [{ id: "snap1".padEnd(32, "0"), name: "clip.mp4", caption: "Take two" }]);
  assert.deepEqual(out[0].options, ["Keep", { label: "Face", description: "d", image: { id: "snap2".padEnd(32, "0"), name: "face.png" } }]);
  assert.deepEqual(out[1], { question: "Free text?" });
  // What the agent sent is not changed under it.
  assert.equal(list[0].options[1].image, face);
});

test("the host's refusal is the call's, in the host's words", async (t) => {
  const { file } = scratch(t);
  const { port } = await host(t, [{ status: 400, error: "fake.png is named .png but holds a JPEG image. Name it for what it is." }]);
  asHost(t, port);
  await assert.rejects(attachMedia([{ question: "Q", media: [file("fake.png")] }]), (error) => {
    assert.ok(error instanceof MediaRefusal);
    assert.match(error.message, /fake\.png is named \.png but holds a JPEG image/);
    return true;
  });
});

test("a later upload refusal rolls back earlier snapshots without asking", async (t) => {
  const { file } = scratch(t);
  const id = "a".repeat(32);
  const { port, heard } = await host(t, [
    { result: { id, name: "one.png" } },
    { status: 400, error: "two.png was refused" },
    { result: true },
  ]);
  asHost(t, port);
  await assert.rejects(attachMedia([{ question: "Q", media: [file("one.png"), file("two.png")] }]), /two.png was refused/);
  assert.deepEqual(heard.map((h) => h.path), ["/hook/question-media", "/hook/question-media", "/hook/question-media/discard"]);
  assert.deepEqual(JSON.parse(heard[2].body), { chatKey: "chat:media", sessionKey: "chat:media", launchId: "launch-1", ids: [id] });
  assert.equal(heard[2].headers["x-octiq-chat-capability"], "cap-1");
});

/** One tools/call through the real MCP server, against the stand-in host. */
function call(port, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "octiq-ask.cjs")], {
      env: { ...process.env, OCTIQ_HOOK_PORT: String(port), OCTIQ_CHAT_KEY: "chat:media", OCTIQ_SESSION_KEY: "", OCTIQ_CHAT_CAPABILITY: "cap-1", OCTIQ_LAUNCH_ID: "", OCTIQ_ORCHESTRATION_ATTEMPT: "", OCTIQ_FRONT_DESK: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("MCP timed out")); }, 10000);
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.includes("\n")) { clearTimeout(timer); resolve(JSON.parse(out.split("\n")[0]).result); child.stdin.end(); }
    });
    child.on("error", reject);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask_user", arguments: args } }) + "\n");
  });
}

test("ask_user sends the snapshots' ids with the question, and its answer is the labels alone", async (t) => {
  const { file } = scratch(t);
  const shot = file("shot.png");
  const { heard, port } = await host(t, [
    { result: { id: "a".repeat(32), name: "shot.png" } },
    { answer: "Keep" },
  ]);
  const result = await call(port, { question: "Keep this layout?", media: [{ path: shot, caption: "Home" }], options: ["Keep", "Change"] });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(result.content[0].text, "Keep");
  assert.deepEqual(heard.map((h) => h.path), ["/hook/question-media", "/hook/ask"]);
  const asked = JSON.parse(heard[1].body);
  assert.deepEqual(asked.questions[0].media, [{ id: "a".repeat(32), name: "shot.png", caption: "Home" }]);
});

test("ask_user asks nothing when a file cannot be shown, and says which", async (t) => {
  const { port, heard } = await host(t, [{ status: 400, error: "The caption of shot.png is 200 characters; at most 160." }]);
  const missing = await call(port, { question: "Q", media: [{ path: path.join(os.tmpdir(), "octiq-no-such-file.png") }] });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /^Nothing was asked: .*octiq-no-such-file\.png does not exist/);
  assert.equal(missing._meta["octiq/outcome"].reasonClass, "validation");
  assert.equal(heard.length, 0, "nothing reached the host");
  // A refusal of the ask itself, too.
  const { port: askPort, heard: refusedHeard } = await host(t, [{ result: { id: "b".repeat(32), name: "x.png" } }, { status: 400, error: "x.png is not among this conversation's question media: attach it again." }, { result: true }]);
  const { file } = scratch(t);
  const refusedAsk = await call(askPort, { question: "Q", media: [file("x.png")] });
  assert.equal(refusedAsk.isError, true);
  assert.match(refusedAsk.content[0].text, /^Nothing was asked: x\.png is not among/);
  assert.equal(refusedHeard[2].path, "/hook/question-media/discard");
  assert.deepEqual(JSON.parse(refusedHeard[2].body).ids, ["b".repeat(32)]);
});

for (const [failure, respond, answer] of [
  ["reset before response", (res) => res.destroy(), "OctiqFlow could not be reached."],
  ["reset during response", (res) => {
    res.writeHead(200, { "content-type": "application/json", "content-length": 100 });
    res.write('{"answer":');
    // Flush headers first so this exercises IncomingMessage's aborted path.
    setImmediate(() => res.destroy());
  }, "OctiqFlow could not be reached."],
  ["empty response", (res) => res.end(), "OctiqFlow gave no answer."],
  ["missing answer", (res) => res.end("{}"), "OctiqFlow gave no answer."],
]) {
  test(`ask_user discards its uploaded snapshots after ${failure}`, async (t) => {
    const { file } = scratch(t);
    const id = "c".repeat(32);
    const optionId = "d".repeat(32);
    const { port, heard } = await host(t, [
      { result: { id, name: "shot.png" } },
      { result: { id: optionId, name: "option.png" } },
      respond,
      { result: true },
    ]);
    const result = await call(port, { question: "Q", media: [file("shot.png")], options: [{ label: "A", image: file("option.png") }] });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(result.content[0].text, answer);
    assert.deepEqual(heard.map((h) => h.path), ["/hook/question-media", "/hook/question-media", "/hook/ask", "/hook/question-media/discard"]);
    assert.deepEqual(JSON.parse(heard[3].body), { chatKey: "chat:media", sessionKey: "chat:media", ids: [id, optionId] });
    assert.equal(heard[3].headers["x-octiq-chat-capability"], "cap-1");
  });
}
