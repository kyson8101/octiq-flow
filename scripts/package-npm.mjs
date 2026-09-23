#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const RUNTIMES = Object.freeze({
  'darwin-arm64': { name: 'octiqflow-darwin-arm64', os: 'darwin', cpu: 'arm64', binary: 'octiq-server' },
  'darwin-x64': { name: 'octiqflow-darwin-x64', os: 'darwin', cpu: 'x64', binary: 'octiq-server' },
  'linux-x64': { name: 'octiqflow-linux-x64', os: 'linux', cpu: 'x64', binary: 'octiq-server' },
  'win32-x64': { name: '@kyson8101/octiqflow-win32-x64', os: 'win32', cpu: 'x64', binary: 'octiq-server.exe' },
});

export function cargoVersion(root) {
  const manifest = fs.readFileSync(path.join(root, 'src-tauri', 'Cargo.toml'), 'utf8');
  const packageBlock = manifest.match(/\[package\]([\s\S]*?)(?:\n\[|$)/);
  const match = packageBlock?.[1].match(/^version\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error('could not read the package version from src-tauri/Cargo.toml');
  return match[1];
}

function resetDirectory(directory) {
  const target = path.resolve(directory);
  const root = path.parse(target).root;
  if (target === root || target === path.resolve('.')) {
    throw new Error(`refusing to replace unsafe output directory ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
}

function writeManifest(directory, manifest) {
  fs.writeFileSync(path.join(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

export function stageCli({ root, out, version }) {
  const source = path.join(root, 'npm');
  resetDirectory(out);
  fs.cpSync(path.join(source, 'bin'), path.join(out, 'bin'), { recursive: true });
  fs.cpSync(path.join(source, 'lib'), path.join(out, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(source, 'README.md'), path.join(out, 'README.md'));
  fs.chmodSync(path.join(out, 'bin', 'octiqflow.cjs'), 0o755);

  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  manifest.version = version;
  for (const name of Object.keys(manifest.optionalDependencies || {})) {
    manifest.optionalDependencies[name] = version;
  }
  delete manifest.scripts;
  writeManifest(out, manifest);
  return manifest;
}

export function stageRuntime({ out, platform, version, binary, client }) {
  const target = RUNTIMES[platform];
  if (!target) throw new Error(`unknown runtime platform ${platform}`);
  if (!fs.statSync(binary, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`runtime binary does not exist: ${binary}`);
  }
  if (!fs.statSync(path.join(client, 'index.html'), { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`browser build does not contain index.html: ${client}`);
  }

  resetDirectory(out);
  const bin = path.join(out, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const installedBinary = path.join(bin, target.binary);
  fs.copyFileSync(binary, installedBinary);
  if (target.os !== 'win32') fs.chmodSync(installedBinary, 0o755);
  fs.cpSync(client, path.join(bin, 'v2'), { recursive: true });

  const manifest = {
    name: target.name,
    version,
    description: `Native OctiqFlow runtime for ${target.os} ${target.cpu}`,
    os: [target.os],
    cpu: [target.cpu],
    files: ['bin'],
    repository: {
      type: 'git',
      url: 'git+https://github.com/kyson8101/octiq-flow.git',
    },
    homepage: 'https://github.com/kyson8101/octiq-flow#readme',
    license: 'UNLICENSED',
    publishConfig: { access: 'public' },
  };
  writeManifest(out, manifest);
  fs.writeFileSync(
    path.join(out, 'README.md'),
    `# ${target.name}\n\nThis package is the ${target.os} ${target.cpu} runtime used by [octiqflow](https://www.npmjs.com/package/octiqflow). Install \`octiqflow\` instead of using this package directly.\n`,
  );
  return manifest;
}

function values(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error(`unexpected argument ${key}`);
    const value = argv[++index];
    if (value == null || value.startsWith('--')) throw new Error(`${key} needs a value`);
    parsed[key.slice(2)] = value;
  }
  return parsed;
}

export function run(argv, root) {
  if (argv.length === 1 && argv[0] === '--print-version') {
    process.stdout.write(`${cargoVersion(root)}\n`);
    return;
  }
  const options = values(argv);
  const version = cargoVersion(root);
  if (options.version && options.version !== version) {
    throw new Error(`requested version ${options.version} does not match Cargo version ${version}`);
  }
  if (!options.kind || !options.out) {
    throw new Error('--kind and --out are required');
  }
  if (options.kind === 'cli') {
    stageCli({ root, out: options.out, version });
  } else if (options.kind === 'runtime') {
    if (!options.platform || !options.binary || !options.client) {
      throw new Error('runtime packaging needs --platform, --binary, and --client');
    }
    stageRuntime({
      out: options.out,
      platform: options.platform,
      version,
      binary: options.binary,
      client: options.client,
    });
  } else {
    throw new Error(`unknown package kind ${options.kind}`);
  }
}

const script = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  const root = path.resolve(path.dirname(script), '..');
  try {
    run(process.argv.slice(2), root);
  } catch (error) {
    console.error(`package-npm: ${error.message}`);
    process.exitCode = 1;
  }
}
