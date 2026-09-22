const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  installMacService,
  plist,
  servicePaths,
  uninstallMacService,
  xml,
} = require('../lib/service.cjs');

test('service paths are versioned and stay under the selected home', () => {
  const paths = servicePaths('/Users/a person', '0.1.51');
  assert.equal(paths.runtime, path.join('/Users/a person', '.octiqflow', 'runtimes', '0.1.51'));
  assert.equal(
    paths.plist,
    path.join('/Users/a person', 'Library', 'LaunchAgents', 'com.kyson.octiqflow.server.plist'),
  );
});

test('launchd plist escapes user-controlled paths and settings', () => {
  const body = plist({
    binary: '/tmp/A&B/<server>',
    bind: '127.0.0.1&bad',
    port: 1421,
    home: '/Users/A&B',
    shell: '/bin/zsh',
  });
  assert.match(body, /\/tmp\/A&amp;B\/&lt;server&gt;/);
  assert.match(body, /127\.0\.0\.1&amp;bad/);
  assert.doesNotMatch(body, /A&B/);
  assert.equal(xml('"<&'), '&quot;&lt;&amp;');
});

test('service install copies an immutable runtime and bootstraps its plist', (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octiqflow-service-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'source');
  const client = path.join(source, 'v2');
  const binary = path.join(source, 'octiq-server');
  fs.mkdirSync(client, { recursive: true });
  fs.writeFileSync(binary, 'binary');
  fs.writeFileSync(path.join(client, 'index.html'), 'client');
  const calls = [];
  const run = (_command, args) => {
    calls.push(args);
    return { status: args[0] === 'print' ? 1 : 0, stdout: '', stderr: '' };
  };

  const details = installMacService(
    { binary, client },
    { platform: 'darwin', home: temporary, version: '1.2.3', uid: 501, run },
  );
  assert.equal(fs.readFileSync(details.binary, 'utf8'), 'binary');
  assert.equal(
    fs.readFileSync(path.join(path.dirname(details.binary), 'v2', 'index.html'), 'utf8'),
    'client',
  );
  assert.match(fs.readFileSync(details.plist, 'utf8'), /\.octiqflow\/runtimes\/1\.2\.3/);
  assert.deepEqual(calls.at(-1), ['bootstrap', 'gui/501', details.plist]);

  const profile = path.join(temporary, '.octiqflow', 'profiles', 'default', 'transcript.jsonl');
  fs.mkdirSync(path.dirname(profile), { recursive: true });
  fs.writeFileSync(profile, 'keep me');
  uninstallMacService({ platform: 'darwin', home: temporary, uid: 501, run });
  assert.equal(fs.existsSync(details.plist), false);
  assert.equal(fs.readFileSync(profile, 'utf8'), 'keep me');
});
