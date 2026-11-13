#!/usr/bin/env node
// A worker's first turn waits for its browser server WITHOUT holding anything
// (review round 1 of 05202d74, H2/H3). Real octiq-server, stub `codex`
// app-server on PATH, no model call.
//
//   node scripts/test-worker-first-turn.mjs <path to octiq-server>
//
// Proves, against the real process:
//   A. chat_start returns at once while the server is still starting (the
//      caller, which holds the orchestration workspace lock, is never held),
//      and a chat_interrupt during the wait cuts nothing, fails nothing, and
//      leaves the first prompt first and a queued message second.
//   B. chat_stop during the wait returns at once and the first prompt is never
//      written.
//   C. An ordinary chat and a worker with no browser definition have no gate.
//   D. No env VALUE of the browser definition is on any command line, and the
//      value reaches the process environment; the server is named
//      octiq_playwright; `~/alt-config` is resolved like the launch does.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const binary = process.argv[2];
if (!binary) {
  console.error('usage: node scripts/test-worker-first-turn.mjs <octiq-server>');
  process.exit(2);
}
const SECRET = 'marker-secret-value';
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'octiq-first-turn-'));
const home = path.join(fixture, 'home');
const bin = path.join(fixture, 'bin');
const cwd = path.join(fixture, 'project');
for (const dir of [home, bin, cwd]) fs.mkdirSync(dir);
const definition = { mcpServers: { playwright: { command: 'fake-browser', env: { TOKEN: SECRET } } } };
fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(definition));
fs.mkdirSync(path.join(home, 'alt-config'));
fs.writeFileSync(path.join(home, 'alt-config', '.claude.json'), JSON.stringify(definition));
const calls = path.join(fixture, 'calls.jsonl');
fs.writeFileSync(calls, '');

// The stub: `codex mcp list` answers with the person's servers; `codex
// app-server` speaks just enough of the protocol. PROBE_READY_MS is when it
// says the browser server is ready (never, with -1).
function stub() {
  const fs = require('node:fs');
  const readline = require('node:readline');
  const out = (x) => process.stdout.write(JSON.stringify(x) + '\n');
  const log = (x) =>
    fs.appendFileSync(process.env.PROBE_CALLS, JSON.stringify({ time: Date.now(), pid: process.pid, ...x }) + '\n');
  const argv = process.argv.slice(2);
  if (argv.includes('--version')) return console.log('stub 1.0');
  if (argv.includes('models') || argv.includes('list')) return console.log('[]');
  log({ argv, token: process.env.TOKEN ?? null });
  const readyMs = Number(process.env.PROBE_READY_MS ?? '1200');
  let turns = 0;
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    log({ method: m.method, text: (m.params?.input ?? []).map((i) => i.text ?? '').join('') });
    if (m.method === 'initialize') out({ id: m.id, result: { userAgent: 'stub' } });
    if (m.method === 'thread/start' || m.method === 'thread/resume') {
      const id = 'thread-' + process.pid;
      out({ id: m.id, result: { thread: { id } } });
      if (readyMs >= 0)
        setTimeout(
          () =>
            out({
              method: 'mcpServer/startupStatus/updated',
              params: { name: 'octiq_playwright', status: 'ready', error: null },
            }),
          readyMs,
        );
    }
    if (m.method === 'turn/start') {
      const id = 'turn-' + ++turns;
      out({ id: m.id, result: { turn: { id } } });
      out({ method: 'turn/started', params: { turn: { id }, threadId: 'thread-' + process.pid } });
      setTimeout(
        () => out({ method: 'turn/completed', params: { threadId: 'thread-' + process.pid, turn: { id, status: 'completed' } } }),
        300,
      );
    }
    if (m.method === 'turn/interrupt') out({ id: m.id, result: {} });
  });
}
fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}\n(${stub.toString()})();\n`, { mode: 0o755 });
const shell = path.join(bin, 'shell');
fs.writeFileSync(shell, '#!/bin/sh\nif [ "$1" = "-l" ]; then shift; fi\nexec /bin/sh "$@"\n', { mode: 0o755 });
execFileSync('git', ['init', '-q', '-b', 'develop'], { cwd });
execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd });

const port = 24000 + Math.floor(Math.random() * 3000);
const token = 'first-turn-test';
const server = spawn(binary, [], {
  env: {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: home,
    CODEX_HOME: path.join(home, '.codex'),
    SHELL: shell,
    PATH: bin + path.delimiter + process.env.PATH,
    PROBE_CALLS: calls,
    OCTIQ_WEB_PORT: String(port),
    OCTIQ_WEB_TOKEN: token,
    OCTIQ_CHAT_IDLE_MINS: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (label, fn, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(40);
  }
  throw new Error('timeout waiting for ' + label);
};
const logged = () =>
  fs
    .readFileSync(calls, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
let ws;
let seq = 0;
const replies = new Map();
const invoke = (cmd, args = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    replies.set(id, { resolve, reject });
    ws.send(JSON.stringify({ t: 'invoke', id, cmd, args }));
  });
const worker = (key, readyMs, extra = {}) =>
  invoke('chat_start', {
    key: 'chat:' + key,
    cwd,
    agent: 'codex',
    model: 'gpt-6.1-sol',
    access: 'full',
    prompt: 'FIRST ' + key,
    turnId: 'first-' + key,
    env: { OCTIQ_ORCHESTRATION_ATTEMPT: 'fixture', PROBE_READY_MS: String(readyMs) },
    ...extra,
  });
const starts = (pid) => logged().filter((c) => c.pid === pid && c.method === 'turn/start');

const results = {};
try {
  await wait('server', async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok;
    } catch {
      return false;
    }
  });
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.t === 'reply') {
      const p = replies.get(m.id);
      if (p) {
        replies.delete(m.id);
        m.ok ? p.resolve(m.result) : p.reject(new Error(m.error));
      }
    }
  };

  // ---- A. the caller is not held, an interrupt is harmless, order is kept
  let t = Date.now();
  await worker('a', 4000);
  results.startReturnedMs = Date.now() - t;
  assert(results.startReturnedMs < 2500, `chat_start waited for the browser server (${results.startReturnedMs} ms)`);
  const launch = logged().find((c) => c.argv?.some((a) => String(a).startsWith('mcp_servers.octiq_playwright=')));
  assert(launch, 'the worker launch carries the octiq_playwright server');
  const pid = launch.pid;
  assert(!launch.argv.join(' ').includes(SECRET), 'no env value on the command line');
  assert.equal(launch.token, SECRET, 'the value reaches the process environment');
  const psArgs = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' });
  assert(!psArgs.includes(SECRET), 'ps shows no env value');
  assert(!launch.argv.some((a) => String(a).startsWith('mcp_servers.playwright={command="fake-browser"')), 'not under the person\'s name');
  assert.equal(starts(pid).length, 0, 'the first prompt is held while the server starts');

  const interrupted = await invoke('chat_interrupt', { key: 'chat:a' });
  assert.equal(interrupted.stopped, true);
  await invoke('chat_send', { key: 'chat:a', text: 'FOLLOWUP a', turnId: 'follow-a' });
  assert.equal(logged().filter((c) => c.pid === pid && c.method === 'turn/interrupt').length, 0, 'nothing was interrupted');
  await wait('both turns', () => starts(pid).length === 2, 20000);
  results.order = starts(pid).map((c) => c.text);
  assert(results.order[0].includes('FIRST a') && results.order[1].includes('FOLLOWUP a'), 'FIRST then the queued message');
  assert.equal(logged().filter((c) => c.pid === pid && c.method === 'turn/interrupt').length, 0, 'still no interrupt');
  await invoke('chat_stop', { key: 'chat:a' });

  // ---- B. Stop during the wait: at once, and the first prompt never goes
  await worker('b', 6000);
  const bPid = logged().filter((c) => c.argv).at(-1).pid;
  t = Date.now();
  await invoke('chat_stop', { key: 'chat:b' });
  results.stopMs = Date.now() - t;
  assert(results.stopMs < 1500, `Stop waited (${results.stopMs} ms)`);
  await sleep(7500); // past the moment the server would have said ready
  assert.equal(starts(bPid).length, 0, 'the first prompt was never written to a stopped worker');

  // ---- C. no gate for an ordinary chat, or a worker with no definition
  t = Date.now();
  await worker('ordinary', 4000, { env: { PROBE_READY_MS: '4000' } });
  const ordinary = logged().filter((c) => c.argv).at(-1);
  assert(!ordinary.argv.some((a) => String(a).includes('octiq_playwright')), 'an ordinary chat gets no browser');
  await wait('ordinary first turn', () => starts(ordinary.pid).length === 1, 3000);
  results.ordinaryFirstTurnMs = Date.now() - t;
  await invoke('chat_stop', { key: 'chat:ordinary' });

  fs.renameSync(path.join(home, '.claude.json'), path.join(home, '.claude.json.saved'));
  await worker('nodef', 4000);
  const nodef = logged().filter((c) => c.argv).at(-1);
  assert(!nodef.argv.some((a) => String(a).includes('octiq_playwright')), 'no definition, no browser');
  await wait('no-definition first turn', () => starts(nodef.pid).length === 1, 3000);
  await invoke('chat_stop', { key: 'chat:nodef' });

  // ---- D. a leading ~ in CLAUDE_CONFIG_DIR is resolved like the launch does
  await worker('tilde', -1, { env: { OCTIQ_ORCHESTRATION_ATTEMPT: 'fixture', PROBE_READY_MS: '-1', CLAUDE_CONFIG_DIR: '~/alt-config' } });
  const tilde = logged().filter((c) => c.argv).at(-1);
  assert(
    tilde.argv.some((a) => String(a).startsWith('mcp_servers.octiq_playwright=')),
    '~/alt-config was read',
  );
  await invoke('chat_stop', { key: 'chat:tilde' });

  console.log(JSON.stringify({ ok: true, ...results }, null, 2));
} catch (error) {
  console.error('FAILED:', error.message);
  console.error(serverLog.split('\n').slice(-25).join('\n'));
  process.exitCode = 1;
} finally {
  server.kill();
  ws?.close();
  fs.rmSync(fixture, { recursive: true, force: true });
}
