const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LABEL = 'com.kyson.octiqflow.server';

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function servicePaths(home = os.homedir(), version = 'development') {
  const base = path.join(home, '.octiqflow');
  return {
    base,
    logs: path.join(base, 'logs'),
    runtime: path.join(base, 'runtimes', version),
    plist: path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
  };
}

function plist({ binary, bind, port, home, shell }) {
  const logs = path.join(home, '.octiqflow', 'logs');
  const searchPath = [
    path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].join(':');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(binary)}</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OCTIQ_WEB</key><string>1</string>
    <key>OCTIQ_WEB_BIND</key><string>${xml(bind)}</string>
    <key>OCTIQ_WEB_PORT</key><string>${xml(port)}</string>
    <key>PATH</key><string>${xml(searchPath)}</string>
    <key>SHELL</key><string>${xml(shell)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(path.join(logs, 'server.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logs, 'server.err.log'))}</string>
</dict>
</plist>
`;
}

function runLaunchctl(args, options = {}) {
  const run = options.run || spawnSync;
  return run('launchctl', args, { encoding: 'utf8', stdio: options.stdio || 'pipe' });
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function replaceDirectory(source, destination) {
  const parent = path.dirname(destination);
  const temporary = `${destination}.install-${process.pid}-${Date.now()}`;
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  fs.cpSync(source, temporary, { recursive: true });
  fs.rmSync(destination, { recursive: true, force: true });
  fs.renameSync(temporary, destination);
}

function installMacService(runtime, options = {}) {
  if ((options.platform || process.platform) !== 'darwin') {
    throw new Error('background service installation is currently supported on macOS only');
  }
  const home = options.home || os.homedir();
  const version = options.version || 'development';
  const bind = options.bind || '127.0.0.1';
  const port = Number(options.port || 1421);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('port must be an integer from 1 to 65535');
  }

  const paths = servicePaths(home, version);
  const binDir = path.join(paths.runtime, 'bin');
  fs.mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const installedBinary = path.join(binDir, 'octiq-server');
  fs.copyFileSync(runtime.binary, installedBinary);
  fs.chmodSync(installedBinary, 0o755);
  replaceDirectory(runtime.client, path.join(binDir, 'v2'));

  fs.mkdirSync(path.dirname(paths.plist), { recursive: true });
  const body = plist({
    binary: installedBinary,
    bind,
    port,
    home,
    shell: process.env.SHELL || '/bin/zsh',
  });
  const temporaryPlist = `${paths.plist}.install-${process.pid}`;
  fs.writeFileSync(temporaryPlist, body, { mode: 0o600 });
  fs.renameSync(temporaryPlist, paths.plist);

  const domain = `gui/${options.uid == null ? process.getuid() : options.uid}`;
  runLaunchctl(['bootout', `${domain}/${LABEL}`], options);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (runLaunchctl(['print', `${domain}/${LABEL}`], options).status !== 0) break;
    sleep(250);
  }
  let started = false;
  let lastError = '';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = runLaunchctl(['bootstrap', domain, paths.plist], options);
    if (result.status === 0) {
      started = true;
      break;
    }
    lastError = (result.stderr || result.stdout || '').trim();
    sleep(500);
  }
  if (!started) {
    throw new Error(`launchd could not start OctiqFlow${lastError ? `: ${lastError}` : ''}`);
  }
  return { ...paths, binary: installedBinary, bind, port };
}

function uninstallMacService(options = {}) {
  if ((options.platform || process.platform) !== 'darwin') {
    throw new Error('background service installation is currently supported on macOS only');
  }
  const home = options.home || os.homedir();
  const paths = servicePaths(home);
  const domain = `gui/${options.uid == null ? process.getuid() : options.uid}`;
  runLaunchctl(['bootout', `${domain}/${LABEL}`], options);
  fs.rmSync(paths.plist, { force: true });
  return paths.plist;
}

function serviceStatus(options = {}) {
  if ((options.platform || process.platform) !== 'darwin') return false;
  const domain = `gui/${options.uid == null ? process.getuid() : options.uid}`;
  return runLaunchctl(['print', `${domain}/${LABEL}`], options).status === 0;
}

function restartMacService(options = {}) {
  if ((options.platform || process.platform) !== 'darwin') {
    throw new Error('background service installation is currently supported on macOS only');
  }
  const domain = `gui/${options.uid == null ? process.getuid() : options.uid}`;
  const result = runLaunchctl(['kickstart', '-k', `${domain}/${LABEL}`], options);
  if (result.status !== 0) {
    throw new Error('OctiqFlow service is not installed');
  }
}

module.exports = {
  LABEL,
  installMacService,
  plist,
  restartMacService,
  servicePaths,
  serviceStatus,
  uninstallMacService,
  xml,
};
