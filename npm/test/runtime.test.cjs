const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { packageFor, resolveRuntime } = require('../lib/runtime.cjs');

test('maps every shipped platform to its optional runtime package', () => {
  assert.equal(packageFor('darwin', 'arm64'), 'octiqflow-darwin-arm64');
  assert.equal(packageFor('darwin', 'x64'), 'octiqflow-darwin-x64');
  assert.equal(packageFor('linux', 'x64'), 'octiqflow-linux-x64');
  assert.equal(packageFor('win32', 'x64'), 'octiqflow-win32-x64');
  assert.throws(() => packageFor('linux', 'arm64'), /unsupported platform linux-arm64/);
});

test('resolves a complete native package and rejects an incomplete one', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octiqflow-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'bin', 'v2'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.writeFileSync(path.join(root, 'bin', 'octiq-server'), 'binary');
  fs.writeFileSync(path.join(root, 'bin', 'v2', 'index.html'), 'client');
  const resolve = () => path.join(root, 'package.json');

  const runtime = resolveRuntime({ platform: 'darwin', arch: 'arm64', resolve });
  assert.equal(runtime.binary, path.join(root, 'bin', 'octiq-server'));
  fs.rmSync(path.join(root, 'bin', 'v2', 'index.html'));
  assert.throws(
    () => resolveRuntime({ platform: 'darwin', arch: 'arm64', resolve }),
    /is incomplete/,
  );
});

test('explains when optional dependencies were omitted', () => {
  assert.throws(
    () => resolveRuntime({ platform: 'linux', arch: 'x64', resolve: () => { throw new Error('missing'); } }),
    /reinstall without --omit=optional/,
  );
});
