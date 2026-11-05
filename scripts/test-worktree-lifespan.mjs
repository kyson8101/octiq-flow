// Real host sweep in a throwaway HOME/profile, no real worktrees or model calls.
// Usage: node scripts/test-worktree-lifespan.mjs <exact-sha octiq-server> <evidence-dir>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const binary = path.resolve(process.argv[2]);
const evidence = path.resolve(process.argv[3]);
fs.mkdirSync(evidence, { recursive: true });
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'octiq-lifespan-host-')));
const taskHome = path.join(fixture, 'home');
const profile = path.join(taskHome, '.octiqflow/profiles/default');
const repo = path.join(fixture, 'repo');
const old = new Date(Date.now() - 30 * 86400000);
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z' } }).trim();
const write = (root, name, text) => { const p = path.join(root, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
fs.mkdirSync(repo);
git(repo, ['init', '-q', '-b', 'develop']);
git(repo, ['config', 'user.name', 'Lifespan fixture']);
git(repo, ['config', 'user.email', 'lifespan@example.invalid']);
write(repo, '.gitignore', 'source/\nworks/\nanime/\ntarget/\nnode_modules/\npnpm-workspace.yaml\n');
write(repo, 'Cargo.toml', '[package]\nname="fixture"\nversion="0.0.0"\n');
write(repo, 'web/package.json', '{}\n');
write(repo, 'tracked', 'original');
git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'fixture']);
const works = {};
for (const name of ['originals', 'nested', 'custom-pnpm', 'pnpm', 'abandoned', 'large-archive']) {
  const dir = path.join(fixture, '.worktrees/repo/octiq', name);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(repo, ['worktree', 'add', '-q', '-b', `octiq/${name}`, dir]); works[name] = dir;
}
write(works.originals, 'source/Cargo.toml', '[package]');
write(works.originals, 'source/target/ONLY-ORIGINAL.bin', 'only original');
const nested = path.join(works.nested, 'web/node_modules/local-tool');
write(nested, 'original', 'unpublished');
git(nested, ['init', '-q', '-b', 'main']);
git(nested, ['add', '.']);
git(nested, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'unpublished']);
const nestedHead = git(nested, ['rev-parse', 'HEAD']);
write(works['custom-pnpm'], 'web/pnpm-workspace.yaml', 'packages:\n  - packages/*\nonlyBuiltDependencies:\n  - esbuild\n');
write(works.pnpm, 'web/pnpm-workspace.yaml', 'allowBuilds:\n  esbuild: true\n');
for (let n = 0; n < 10000; n++) write(works.pnpm, `web/node_modules/.pnpm/file-${n}`, 'rebuildable');
const sentinel = path.join(fixture, 'external-sentinel'); fs.writeFileSync(sentinel, 'target survives');
for (let n = 0; n < 783; n++) fs.symlinkSync(sentinel, path.join(works.pnpm, `web/node_modules/${n === 0 ? "pnpm-workspace.yaml" : `link-${n}`}`));
write(works.abandoned, 'dirty', 'uncommitted');
write(works.abandoned, 'target/cache', 'rebuildable');
const large = path.join(works['large-archive'], 'untracked-64mib.bin');
const fd = fs.openSync(large, 'w'); fs.ftruncateSync(fd, 64 * 1024 * 1024); fs.closeSync(fd);
function age(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (name.toLowerCase() === '.git') continue;
    const p = path.join(dir, name), m = fs.lstatSync(p);
    if (m.isSymbolicLink()) continue;
    if (m.isDirectory()) age(p); else fs.utimesSync(p, old, old);
  }
  fs.utimesSync(dir, old, old);
}
for (const dir of Object.values(works)) age(dir);
write(profile, 'workspaces.json', JSON.stringify({ workspaces: [{ id: 'lifespan-fixture', name: 'Lifespan fixture', primary_path: repo, paths: [repo] }] }));
write(profile, 'chats/index.json', JSON.stringify({ chats: Object.entries(works).map(([name, cwd]) => ({ id: `lifespan-${name}`, projectId: 'lifespan-fixture', title: name, cwd, createdAt: +old, updatedAt: +old })) }));
const port = 22000 + Math.floor(Math.random() * 5000), token = 'isolated-lifespan-fixture';
const env = { ...process.env, HOME: taskHome, OCTIQ_WEB_BIND: '127.0.0.1', OCTIQ_WEB_PORT: String(port), OCTIQ_WEB_TOKEN: token, OCTIQ_CHAT_IDLE_MINS: '0' };
// Do not inherit job/agent hook capabilities into an unrelated fixture host.
for (const name of Object.keys(env)) if (/^OCTIQ_(CHAT|ORCHESTRATION|HOOK|MCP|JOB)/.test(name) && name !== 'OCTIQ_CHAT_IDLE_MINS') delete env[name];
const server = spawn(binary, [], { env, cwd: fixture, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '', ws, seq = 0; const replies = new Map(), events = [];
server.stdout.on('data', b => serverLog += b); server.stderr.on('data', b => serverLog += b);
const wait = async (name, test, timeout = 240000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const v = await test(); if (v) return v; await new Promise(r => setTimeout(r, 200)); }
  throw new Error(`Timed out: ${name}`);
};
const invoke = (cmd, args = {}) => new Promise((resolve, reject) => { const id = ++seq; replies.set(id, { resolve, reject }); ws.send(JSON.stringify({ t: 'invoke', id, cmd, args })); });
try {
  await wait('server', async () => { try { return (await fetch(`http://127.0.0.1:${port}/healthz`)).status === 200; } catch { return false; } }, 30000);
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ({ data }) => {
    const frame = JSON.parse(data);
    if (frame.t === 'event') events.push(frame);
    else if (frame.t === 'reply') { const p = replies.get(frame.id); if (p) { replies.delete(frame.id); frame.ok ? p.resolve(frame.result) : p.reject(new Error(frame.error)); } }
  };
  const inventory = await wait('first automatic sweep', async () => { const x = await invoke('worktree_lifespan_list'); return x.lastSweepAt && !x.scanning ? x : null; });
  fs.writeFileSync(path.join(evidence, 'host-inventory.json'), JSON.stringify(inventory, null, 2));
  assert.equal(fs.readFileSync(path.join(works.originals, 'source/target/ONLY-ORIGINAL.bin'), 'utf8'), 'only original');
  assert.equal(git(nested, ['rev-parse', 'HEAD']), nestedHead);
  assert(fs.existsSync(path.join(works['custom-pnpm'], 'web/pnpm-workspace.yaml')));
  assert(!fs.existsSync(works.pnpm), JSON.stringify(inventory.history[0]));
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'target survives');
  assert(fs.existsSync(path.join(works.abandoned, 'dirty')));
  assert(!fs.existsSync(path.join(works.abandoned, 'target')));
  const preview = inventory.items.find(i => i.path === works['large-archive']);
  assert(preview?.statusHash);
  const archive = await invoke('worktree_lifespan_archive', { key: preview.key, expectedHead: preview.head, expectedStatusHash: preview.statusHash });
  assert(!fs.existsSync(works['large-archive']));
  assert.equal(git(repo, ['cat-file', '-s', `${archive.ref}:untracked-64mib.bin`]), String(64 * 1024 * 1024));
  fs.writeFileSync(path.join(evidence, 'host-result.json'), JSON.stringify({ passed: true, fixture, isolatedHome: taskHome, port, sweep: inventory.history[0], archive, events: events.filter(e => e.event === 'worktree-swept'), sentinel: fs.readFileSync(sentinel, 'utf8') }, null, 2));
  console.log('Real isolated host sweep passed: H1/H2/H4, pnpm 10,783 entries/783 links, Abandoned safe strip, 64 MiB Archive/removal.');
} finally {
  ws?.close(); server.kill('SIGTERM');
  await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', resolve); });
  fs.writeFileSync(path.join(evidence, 'host-server.log'), serverLog);
  fs.rmSync(fixture, { recursive: true, force: true });
}
