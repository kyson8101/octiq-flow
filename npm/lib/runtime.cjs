const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PLATFORM_PACKAGES = Object.freeze({
  'darwin-arm64': 'octiqflow-darwin-arm64',
  'darwin-x64': 'octiqflow-darwin-x64',
  'linux-x64': 'octiqflow-linux-x64',
  'win32-x64': 'octiqflow-win32-x64',
});

function packageFor(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  const packageName = PLATFORM_PACKAGES[key];
  if (!packageName) {
    const supported = Object.keys(PLATFORM_PACKAGES).join(', ');
    throw new Error(`unsupported platform ${key}; supported platforms: ${supported}`);
  }
  return packageName;
}

function resolveRuntime(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const resolve = options.resolve || require.resolve;
  const exists = options.exists || fs.existsSync;
  const packageName = packageFor(platform, arch);
  let manifest;
  try {
    manifest = resolve(`${packageName}/package.json`);
  } catch (_error) {
    throw new Error(
      `the runtime package ${packageName} is missing; reinstall without --omit=optional`,
    );
  }

  const root = path.dirname(manifest);
  const binaryName = platform === 'win32' ? 'octiq-server.exe' : 'octiq-server';
  const binary = path.join(root, 'bin', binaryName);
  const client = path.join(root, 'bin', 'v2');
  if (!exists(binary) || !exists(path.join(client, 'index.html'))) {
    throw new Error(`${packageName} is incomplete; reinstall octiqflow`);
  }
  return { packageName, root, binary, client, platform, arch };
}

function runForeground(runtime, args = [], options = {}) {
  const spawnImpl = options.spawn || spawn;
  return new Promise((resolve, reject) => {
    const child = spawnImpl(runtime.binary, args, {
      cwd: process.cwd(),
      env: { ...process.env, OCTIQ_WEB: '1', ...(options.env || {}) },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code == null ? 1 : code);
    });
  });
}

module.exports = { PLATFORM_PACKAGES, packageFor, resolveRuntime, runForeground };
