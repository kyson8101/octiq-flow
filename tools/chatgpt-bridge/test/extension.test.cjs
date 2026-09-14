"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function worker() {
  const id = "a".repeat(32);
  const local = { config: { port: 43189, token: "b".repeat(64) } };
  const session = { attachment: { tabId: 42, client: "attached-client" } };
  const fetches = [];
  let listener;
  const storage = data => ({ setAccessLevel: async () => {}, get: async key => ({ [key]: data[key] }), set: async value => Object.assign(data, value), remove: async key => { delete data[key]; } });
  const context = vm.createContext({
    chrome: {
      runtime: { id, getURL: name => `chrome-extension://${id}/${name}`, onMessage: { addListener: fn => { listener = fn; } } },
      storage: { local: storage(local), session: storage(session) },
      tabs: { query: async () => [{ id: 42, url: "https://chatgpt.com/" }], get: async () => ({ id: 42, url: "https://chatgpt.com/c/current-route" }) },
      scripting: { executeScript: async () => {} },
    },
    fetch: async (url, options) => { fetches.push({ url, options }); return { ok: true, json: async () => ({ job: null, active_job_id: null }) }; },
    URL, AbortSignal, crypto: require("node:crypto").webcrypto,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../extension/background.js"), "utf8"), context);
  return {
    fetches,
    sender: { id, frameId: 0, tab: { id: 42 }, url: "https://chatgpt.com/c/test" },
    send: (message, sender) => new Promise(resolve => listener(message, sender, resolve)),
  };
}
test("only attached top-level ChatGPT content scripts may poll", async () => {
  const { send, sender, fetches } = worker();
  for (const bad of [{ ...sender, tab: { id: 99 } }, { ...sender, frameId: 1 }, { ...sender, url: "https://evil.invalid" }, { ...sender, id: "wrong-extension" }]) {
    assert.equal((await send({ type: "poll" }, bad)).ok, false);
  }
  assert.equal(fetches.length, 0);
  const response = await send({ type: "poll", ready: true, busy: false, url: "https://evil.invalid", client: "forged" }, sender);
  assert.equal(response.ok, true);
  const body = JSON.parse(fetches[0].options.body);
  assert.equal(body.url, "https://chatgpt.com/c/current-route");
  assert.equal(body.client, "attached-client");
  assert.equal(JSON.stringify(response).includes("b".repeat(64)), false);
  assert.equal(fetches[0].url, "http://127.0.0.1:43189/extension/poll");
});
test("content scripts cannot retrieve pairing secrets or change attachment", async () => {
  const { send, sender, fetches } = worker();
  for (const type of ["settings", "attach", "detach", "status", "fetch"]) assert.equal((await send({ type }, sender)).ok, false);
  assert.equal(fetches.length, 0);
});
