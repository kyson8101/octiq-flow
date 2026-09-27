// Live check of how a browser signs in, now that `/token` hands the token only
// to a Cloudflare Access sign-in.
//
// Evidence class: REAL SERVER, REAL CLIENT. This checkout's DEBUG octiq-server
// runs in a throwaway HOME whose web.json is written the way older servers
// wrote it — `"local_token": true` included — and serves this checkout's
// web/dist. Chromium drives the real page. Nothing is mocked.
//
//   pnpm --dir web build
//   (cd src-tauri && cargo build --bin octiq-server)
//   OUT=/absolute/evidence/dir \
//   PLAYWRIGHT_MODULE=~/.npm/_npx/<hash>/node_modules/playwright/index.mjs \
//   node scripts/test-browser-signin.mjs
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const REPO = process.env.REPO ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.OUT;
if (!OUT) throw new Error("Set OUT to the directory the evidence goes in.");
const HOME = join(OUT, "home");
const PORT = Number(process.env.PORT ?? 14795);
const TOKEN = "signin-check-token";
const base = `http://127.0.0.1:${PORT}`;
const profile = join(HOME, ".octiqflow", "profiles", "default");
await rm(HOME, { recursive: true, force: true });
await mkdir(join(profile, "chats"), { recursive: true });
// As an older server left it: the flag it wrote into every file.
await writeFile(join(profile, "web.json"), JSON.stringify({ port: PORT, bind: "127.0.0.1", token: TOKEN, local_token: true }, null, 2));

let server;
let log = "";
async function startServer() {
  const env = { ...process.env, HOME, OCTIQ_WEB_PORT: String(PORT), OCTIQ_CHAT_IDLE_MINS: "0" };
  delete env.OCTIQ_WEB_TOKEN;
  server = spawn(join(REPO, "src-tauri/target/debug/octiq-server"), [], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });
  for (let i = 0; i < 150; i += 1) {
    try { if ((await fetch(`${base}/healthz`)).ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not start");
}
async function stopServer() {
  const exited = new Promise((r) => server.once("exit", r));
  server.kill();
  await exited;
}
process.on("exit", () => server?.kill());
await startServer();

const results = {};
// A request from this machine, spelled every loopback way: no token.
for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`]) {
  const response = await fetch(`${base}/token`, { headers: { host } });
  const body = await response.text();
  results[`token ${host}`] = response.status;
  assert.equal(response.status, 403, host);
  assert.ok(!body.includes(TOKEN));
}

const browser = await chromium.launch();
const shots = [];
async function page({ width = 1280, height = 800, stored } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  await context.addInitScript(({ stored }) => {
    if (location.protocol === "about:") return;
    localStorage.setItem("octiq.theme", "dark");
    if (stored !== undefined && !sessionStorage.getItem("seeded")) {
      localStorage.setItem("octiq.web.token", stored);
      sessionStorage.setItem("seeded", "1");
    }
  }, { stored });
  const p = await context.newPage();
  const sockets = [];
  p.on("websocket", (ws) => sockets.push(ws.url()));
  const errors = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  return { p, context, sockets, errors };
}
async function shot(p, name) {
  const file = join(OUT, `${name}.png`);
  await p.screenshot({ path: file });
  shots.push(file);
}
const connectPage = (p) => p.getByRole("heading", { name: "Connect to OctiqFlow" });
// The app shell, which only renders once the socket is authorised.
const inApp = (p) => p.getByRole("button", { name: /^New (task|conversation)$/ }).first();
const storedToken = (p) => p.evaluate(() => localStorage.getItem("octiq.web.token"));

// 1. A new browser profile on this machine: Connect, and no socket at all.
{
  const { p, context, sockets, errors } = await page();
  await p.goto(`${base}/`);
  await connectPage(p).waitFor();
  await p.waitForTimeout(3000);
  assert.equal(await connectPage(p).count(), 1, "still asking after 3 s");
  results.newProfileSockets = sockets.length;
  assert.equal(sockets.length, 0, "no socket without a token");
  await shot(p, "01-new-profile-connect");

  // Paste the token: in, and remembered.
  await p.getByPlaceholder("Paste the token").fill(TOKEN);
  await p.getByRole("button", { name: "Connect" }).click();
  await inApp(p).waitFor();
  assert.equal(await storedToken(p), TOKEN);
  await shot(p, "02-pasted-token-in-app");

  // A reload uses what was remembered.
  await p.reload();
  await inApp(p).waitFor();
  assert.equal(await connectPage(p).count(), 0);

  // The server restarts under the open page: it reconnects on its own.
  const before = sockets.length;
  await stopServer();
  await startServer();
  for (let i = 0; i < 60 && sockets.length <= before; i += 1) await p.waitForTimeout(250);
  await p.waitForTimeout(1500);
  assert.ok(sockets.length > before, "a new socket after the restart");
  assert.equal(await connectPage(p).count(), 0, "a stored token survives a server restart");
  await inApp(p).waitFor();
  await shot(p, "03-reconnected-after-restart");
  assert.deepEqual(errors, []);
  await context.close();
}

// 2. A stale stored token: Connect once, then quiet.
{
  const { p, context, sockets, errors } = await page({ stored: "stale-token" });
  await p.goto(`${base}/`);
  await connectPage(p).waitFor();
  const seen = sockets.length;
  await p.waitForTimeout(8000);
  results.staleSockets = { atConnect: seen, after8s: sockets.length };
  assert.equal(sockets.length, seen, "no retry loop behind the Connect page");
  assert.ok(seen <= 1);
  await shot(p, "04-stale-token-connect");
  assert.deepEqual(errors, []);
  await context.close();
}

// 3. The link the server prints: in, remembered, and gone from the address bar.
{
  const printed = /OctiqFlow: (http:\/\/\S+)/.exec(log)?.[1];
  assert.ok(printed?.includes(`token=${TOKEN}`), "the server printed its link");
  const { p, context, errors } = await page();
  await p.goto(printed.replace(/^http:\/\/[^/]+/, base));
  await inApp(p).waitFor();
  assert.equal(await storedToken(p), TOKEN);
  assert.ok(!p.url().includes("token="), "the token is taken out of the address bar");
  await shot(p, "05-printed-link-in-app");
  assert.deepEqual(errors, []);
  await context.close();
}

// 4. A phone, new profile.
{
  const { p, context } = await page({ width: 390, height: 844 });
  await p.goto(`${base}/`);
  await connectPage(p).waitFor();
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `no sideways scroll (${overflow}px)`);
  await shot(p, "06-phone-connect");
  await context.close();
}

await browser.close();
await stopServer();
await writeFile(join(OUT, "server.log"), log.replaceAll(TOKEN, "<token>"));
console.log(JSON.stringify(results, null, 2));
console.log("browser sign-in live check passed");
console.log(shots.join("\n"));
