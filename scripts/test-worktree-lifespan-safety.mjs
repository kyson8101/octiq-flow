// Real host sweep in a throwaway HOME/profile, no real worktrees or model calls.
// Usage: node scripts/test-worktree-lifespan-safety.mjs <exact-sha octiq-server> <evidence-dir>
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
git(repo, ['config', 'filter.review.clean', 'sed s/SECRET/REDACTED/g']);
git(repo, ['config', 'filter.review.smudge', 'cat']);
write(repo, '.gitattributes', '*.raw filter=review\n');
write(repo, 'original.raw', 'REDACTED unique original\n');
git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'fixture']);
const works = {};
for (const name of ['originals', 'nested', 'custom-pnpm', 'pnpm', 'abandoned', 'large-archive', 'filter-auto', 'filter-archive', 'hidden-assume', 'hidden-skip', 'late-pnpm', 'partial-strip']) {
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
write(works.pnpm, 'web/pnpm-workspace.yaml', 'allowBuilds:\n  esbuild: set this to true or false\n');
for (let n = 0; n < 10000; n++) write(works.pnpm, `web/node_modules/.pnpm/file-${n}`, 'rebuildable');
const sentinel = path.join(fixture, 'external-sentinel'); fs.writeFileSync(sentinel, 'target survives');
for (let n = 0; n < 783; n++) fs.symlinkSync(sentinel, path.join(works.pnpm, `web/node_modules/${n === 0 ? "pnpm-workspace.yaml" : `link-${n}`}`));
write(works.abandoned, 'dirty', 'uncommitted');
write(works.abandoned, 'target/cache', 'rebuildable');
const large = path.join(works['large-archive'], 'untracked-64mib.bin');
const fd = fs.openSync(large, 'w'); fs.ftruncateSync(fd, 64 * 1024 * 1024); fs.closeSync(fd);
// H5: an apparently clean checkout still holds bytes the kept ref cannot restore.
write(works['filter-auto'], 'original.raw', 'SECRET unique original\n');
git(works['filter-auto'], ['add', 'original.raw']);
assert.equal(git(works['filter-auto'], ['status', '--porcelain']), '');
// H5 Archive: untracked attributes and an untracked raw original.
write(works['filter-archive'], 'new/.gitattributes', '*.raw filter=review\n');
write(works['filter-archive'], 'new/original.raw', 'SECRET new original\n');
for (const [name, flag] of [['hidden-assume', '--assume-unchanged'], ['hidden-skip', '--skip-worktree']]) {
  git(works[name], ['update-index', flag, 'tracked']);
  write(works[name], 'tracked', `unique hidden bytes: ${name}\n`);
  assert.equal(git(works[name], ['status', '--porcelain']), '');
}
write(works['late-pnpm'], 'dirty', 'archive this');
write(works['late-pnpm'], 'web/pnpm-workspace.yaml', 'allowBuilds:\n  esbuild: set this to true or false\n');
for (const n of ['a', 'z']) {
  write(works['partial-strip'], `${n}/Cargo.toml`, '[package]');
  write(works['partial-strip'], `${n}/target/cache`, 'safe cache');
}
write(works['partial-strip'], 'z/target/source/ONLY-ORIGINAL', 'keep original');
// Gate only the final fresh-index comparison of the requested worktree.
const bin = path.join(fixture, 'bin'); fs.mkdirSync(bin);
const wrapper = path.join(bin, 'git');
fs.writeFileSync(wrapper, `#!/usr/bin/python3
import os,sys,time,pathlib
root=pathlib.Path(os.environ['LIFESPAN_FIXTURE'])
a=sys.argv[1:]
if '.verify-archive-' in os.environ.get('GIT_INDEX_FILE','') and 'diff' in a and os.environ['LIFESPAN_LATE_WORK'] in a:
 (root/'held').write_text('comparison held')
 end=time.time()+60
 while not (root/'release').exists():
  if time.time()>end: sys.exit(99)
  time.sleep(.01)
os.execv('/usr/bin/git', ['/usr/bin/git', *a])
`);
fs.chmodSync(wrapper, 0o755);
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
const env = { ...process.env, HOME: taskHome, USERPROFILE: taskHome, PATH: `${bin}:${process.env.PATH}`, LIFESPAN_FIXTURE: fixture, LIFESPAN_LATE_WORK: works['late-pnpm'], OCTIQ_WEB_BIND: '127.0.0.1', OCTIQ_WEB_PORT: String(port), OCTIQ_WEB_TOKEN: token, OCTIQ_CHAT_IDLE_MINS: '0' };
// Do not inherit job/agent hook capabilities into an unrelated fixture host.
for (const name of Object.keys(env)) if (/^OCTIQ_(CHAT|ORCHESTRATION|HOOK|MCP|JOB)/.test(name) && name !== 'OCTIQ_CHAT_IDLE_MINS') delete env[name];
const server = spawn(binary, [], { env, cwd: fixture, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '', ws, seq = 0; const replies = new Map(), events = [];
server.stdout.on('data', b => serverLog += b); server.stderr.on('data', b => serverLog += b);
const wait = async (name, test, timeout = 600000) => {
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
  const item = name => inventory.items.find(i => i.path === works[name]);
  const archiveWork = name => { const p = item(name); assert(p?.statusHash, name); return invoke('worktree_lifespan_archive', { key:p.key, expectedHead:p.head, expectedStatusHash:p.statusHash }); };
  assert.equal(item('filter-auto').state, 'abandoned');
  assert.match(item('filter-auto').why, /1 tracked files cannot be restored byte for byte/);
  assert.equal(fs.readFileSync(path.join(works['filter-auto'], 'original.raw'), 'utf8'), 'SECRET unique original\n');
  await assert.rejects(archiveWork('filter-archive'), /1 files cannot be restored byte for byte.*archive ref.*folder are kept/);
  assert.equal(fs.readFileSync(path.join(works['filter-archive'], 'new/original.raw'), 'utf8'), 'SECRET new original\n');
  const hiddenArchives = [];
  for (const name of ['hidden-assume','hidden-skip']) {
    assert.equal(item(name).state, 'abandoned');
    assert.match(item(name).why, /1 edited assume-unchanged\/skip-worktree files/);
    const archived = await archiveWork(name);
    assert(!fs.existsSync(works[name]));
    const restored = await invoke('worktree_lifespan_restore', { key:archived.key });
    assert.equal(fs.readFileSync(path.join(restored.path, 'tracked'), 'utf8'), `unique hidden bytes: ${name}\n`);
    hiddenArchives.push({archived, restored});
  }
  const pendingArchive = archiveWork('late-pnpm').then(value => ({value}), error => ({error:error.message}));
  await wait('H6 held diff', () => fs.existsSync(path.join(fixture, 'held')), 30000);
  write(works['late-pnpm'], 'web/pnpm-workspace.yaml', 'packages:\n  - only-original/*\n');
  fs.writeFileSync(path.join(fixture, 'release'), 'go');
  const late = await pendingArchive;
  assert.match(late.error, /Ignored files changed/);
  assert(fs.existsSync(works['late-pnpm']));
  for (const n of ['a','z']) assert(fs.existsSync(path.join(works['partial-strip'], `${n}/target/cache`)));
  assert(inventory.history[0].failed.some(f => f.path === works['partial-strip'] && /all build folders were kept/.test(f.why)));
  fs.writeFileSync(path.join(evidence, 'round2-host-result.json'), JSON.stringify({passed:true, h5Automatic:item('filter-auto'), h7:hiddenArchives, h6:late, m5:inventory.history[0].failed.filter(f=>f.path===works['partial-strip']), placeholderBytes:50}, null, 2));
  const preview = inventory.items.find(i => i.path === works['large-archive']);
  assert(preview?.statusHash);
  const archive = await invoke('worktree_lifespan_archive', { key: preview.key, expectedHead: preview.head, expectedStatusHash: preview.statusHash });
  assert(!fs.existsSync(works['large-archive']));
  assert.equal(git(repo, ['cat-file', '-s', `${archive.ref}:untracked-64mib.bin`]), String(64 * 1024 * 1024));
  fs.writeFileSync(path.join(evidence, 'host-result.json'), JSON.stringify({ passed: true, fixture, isolatedHome: taskHome, port, sweep: inventory.history[0], archive, events: events.filter(e => e.event === 'worktree-swept'), sentinel: fs.readFileSync(sentinel, 'utf8') }, null, 2));
  console.log('Real isolated host sweep passed: H1-H7, exact 50-byte pnpm, M5 preflight, hidden-byte Archive/Restore, 64 MiB Archive/removal.');
} finally {
  ws?.close(); server.kill('SIGTERM');
  await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', resolve); });
  fs.writeFileSync(path.join(evidence, 'host-server.log'), serverLog);
  fs.rmSync(fixture, { recursive: true, force: true });
}
