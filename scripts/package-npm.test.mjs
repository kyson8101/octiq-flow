import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
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

test('staged CLI resolves its scoped Windows dependency to the executable and client', (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octiqflow-windows-package-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const binary = path.join(temporary, 'octiq-server.exe');
  const client = path.join(temporary, 'client');
  fs.mkdirSync(client);
  fs.writeFileSync(binary, 'windows binary');
  fs.writeFileSync(path.join(client, 'index.html'), 'client');

  const cli = path.join(temporary, 'cli');
  const cliManifest = stageCli({ root, out: cli, version: '9.8.7' });
  const packageName = '@kyson8101/octiqflow-win32-x64';
  const out = path.join(cli, 'node_modules', packageName);
  const manifest = stageRuntime({ out, platform: 'win32-x64', version: '9.8.7', binary, client });
  assert.equal(manifest.name, packageName);
  assert.equal(cliManifest.optionalDependencies[manifest.name], manifest.version);
  assert.deepEqual(manifest.os, ['win32']);
  assert.deepEqual(manifest.cpu, ['x64']);
  assert.equal(manifest.publishConfig.access, 'public');

  const require = createRequire(path.join(cli, 'package.json'));
  const { resolveRuntime } = require('./lib/runtime.cjs');
  const runtime = resolveRuntime({ platform: 'win32', arch: 'x64' });
  assert.equal(runtime.packageName, packageName);
  assert.equal(fs.readFileSync(runtime.binary, 'utf8'), 'windows binary');
  assert.equal(fs.readFileSync(path.join(runtime.client, 'index.html'), 'utf8'), 'client');
});
