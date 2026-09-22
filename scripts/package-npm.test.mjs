import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { cargoVersion, stageCli, stageRuntime } from './package-npm.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Cargo remains the release version source of truth', () => {
  assert.match(cargoVersion(root), /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
});

test('CLI staging stamps every optional runtime with the Cargo version', (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octiqflow-cli-package-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const manifest = stageCli({ root, out: path.join(temporary, 'cli'), version: '9.8.7' });
  assert.equal(manifest.version, '9.8.7');
  assert.deepEqual(new Set(Object.values(manifest.optionalDependencies)), new Set(['9.8.7']));
  assert.equal(fs.statSync(path.join(temporary, 'cli', 'bin', 'octiqflow.cjs')).mode & 0o111, 0o111);
});

test('runtime staging puts the browser client beside the native binary', (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octiqflow-runtime-package-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const binary = path.join(temporary, 'octiq-server');
  const client = path.join(temporary, 'client');
  fs.mkdirSync(client);
  fs.writeFileSync(binary, 'binary');
  fs.writeFileSync(path.join(client, 'index.html'), 'client');
  const out = path.join(temporary, 'package');
  const manifest = stageRuntime({ out, platform: 'darwin-arm64', version: '1.2.3', binary, client });
  assert.equal(manifest.name, 'octiqflow-darwin-arm64');
  assert.equal(fs.readFileSync(path.join(out, 'bin', 'octiq-server'), 'utf8'), 'binary');
  assert.equal(fs.readFileSync(path.join(out, 'bin', 'v2', 'index.html'), 'utf8'), 'client');
});
