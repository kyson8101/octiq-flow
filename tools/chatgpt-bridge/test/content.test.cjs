"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

async function simulate({ renderAt = 45000, failFirstResult = false } = {}) {
  let now = 0;
  let claimed = false;
  let clicks = 0;
  let resultAttempts = 0;
  let result;
  const timers = [];
  const job = { job_id: "delayed-render-job", prompt: "test question", deadline: 90000 };
  const context = vm.createContext({
    document: {}, Date: { now: () => now },
    setTimeout: (fn, ms) => { timers.push({ fn, at: now + ms }); },
    chrome: { runtime: { sendMessage: async message => {
      if (message.type === "poll") {
        const offered = !claimed ? job : null;
        claimed = true;
        return { ok: true, data: { job: offered, active_job_id: job.job_id } };
      }
      resultAttempts++;
      if (failFirstResult && resultAttempts === 1) throw new Error("Transient result delivery failure");
      result = message;
      return { ok: true, data: { accepted: true } };
    } } },
    ChatGPTBridgeAdapter: {
      state: () => ({ ready: true, busy: false, detail: "Ready." }),
      snapshot: () => ({ sent: false }), insert: () => {},
      composer: () => ({}), value: () => job.prompt, normalize: value => value,
      sendButton: () => ({ disabled: false, click: () => { clicks++; } }),
      inspect: (doc, before) => {
        const available = now >= renderAt;
        before.sent ||= available;
        return { sent: available, complete: available, text: available ? "delayed answer" : "" };
      },
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../extension/content.js"), "utf8"), context);
  await new Promise(setImmediate);
  while (!result && timers.length && now <= 95000) {
    timers.sort((a, b) => a.at - b.at);
    const timer = timers.shift();
    now = timer.at;
    timer.fn();
    await new Promise(setImmediate);
  }
  return { result, clicks, now, resultAttempts };
}
test("a response rendered after the old 20-second window still returns without resending", async () => {
  const run = await simulate();
  assert.equal(run.result.status, "completed");
  assert.equal(run.result.answer, "delayed answer");
  assert.equal(run.clicks, 1);
  assert.ok(run.now >= 48000);
});
test("retrying answer delivery never resubmits the question", async () => {
  const run = await simulate({ renderAt: 1000, failFirstResult: true });
  assert.equal(run.result.status, "completed");
  assert.equal(run.resultAttempts, 2);
  assert.equal(run.clicks, 1);
});
test("an unrecognized submission only fails at the task deadline and never retries", async () => {
  const run = await simulate({ renderAt: Infinity });
  assert.equal(run.result.status, "failed");
  assert.match(run.result.error, /task deadline/);
  assert.equal(run.clicks, 1);
  assert.ok(run.now >= 90000);
});
