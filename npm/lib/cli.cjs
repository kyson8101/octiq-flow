const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveRuntime, runForeground } = require('./runtime.cjs');
const {
  installMacService,
  restartMacService,
  serviceStatus,
  uninstallMacService,
} = require('./service.cjs');

const HELP = `OctiqFlow — agent workflow orchestration in your browser

Usage:
  octiqflow                     Run in the foreground and open the client
  octiqflow install [options]   Install and start the macOS background service
  octiqflow uninstall           Remove the macOS background service
  octiqflow status [options]    Check the service and HTTP endpoint
  octiqflow restart             Restart the macOS background service
  octiqflow open [options]      Open the local browser client

Options:
  --port <number>               HTTP port (default: 1421)
  --bind <address>              Bind address (default: 127.0.0.1)
  --no-open                     Do not open a browser
  -h, --help                    Show this help
  -v, --version                 Show the package version

Node.js 18 or newer is required. Claude Code, Codex, and pi.dev are detected
separately; install whichever agent CLIs you want OctiqFlow to drive.
`;

function packageVersion() {
  const manifest = path.join(__dirname, '..', 'package.json');
  return JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
}

function parseOptions(args) {
  const options = {
    port: Number(process.env.OCTIQ_WEB_PORT || 1421),
    bind: process.env.OCTIQ_WEB_BIND || '127.0.0.1',
    open: true,
  };
  const rest = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--port') {
      const raw = args[++index];
      if (raw == null) throw new Error('--port needs a value');
      options.port = Number(raw);
    } else if (value === '--bind') {
      const raw = args[++index];
      if (raw == null) throw new Error('--bind needs a value');
      options.bind = raw;
    } else if (value === '--no-open') {
      options.open = false;
    } else {
      rest.push(value);
    }
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error('--port must be an integer from 1 to 65535');
  }
  return { options, rest };
}

/** The active profile's data root, resolved as the server does (profile.rs):
 *  `~/.octiqflow/config.json` names the base and the active profile. */
function profileRoot(home = os.homedir()) {
  try {
    const pointer = JSON.parse(fs.readFileSync(path.join(home, '.octiqflow', 'config.json'), 'utf8'));
    const base = String(pointer.base || '').trim();
    const active = String(pointer.active || '').trim();
    if (base && active) return path.join(base, active);
  } catch (_error) {
    // No pointer yet: the server uses the default profile too.
  }
  return path.join(home, '.octiqflow', 'profiles', 'default');
}

/** The browser token, read where the server keeps it.
 *
 *  The server hands it out over HTTP (`/token`) only to a Cloudflare Access
 *  sign-in: a request from this machine alone could be any local process,
 *  agents included. This CLI is the person's own command, run as them, so it
 *  reads their profile's `web.json` the way the Connect page tells a person
 *  to. `OCTIQ_WEB_TOKEN` wins, as it does for the server. */
function readToken({ env = process.env, home = os.homedir() } = {}) {
  const fromEnv = String(env.OCTIQ_WEB_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  const file = path.join(profileRoot(home), 'web.json');
  let token = '';
  try {
    token = String(JSON.parse(fs.readFileSync(file, 'utf8')).token || '').trim();
  } catch (_error) {
    // Reported below with the path, which is what the person needs.
  }
  if (!token) throw new Error(`no token in ${file}`);
  return token;
}

/** The link that signs a browser in, once the server answers. */
async function localUrl(port, fetchImpl = fetch, readTokenImpl = readToken) {
  const origin = `http://127.0.0.1:${port}`;
  const health = await fetchImpl(`${origin}/healthz`);
  if (!health.ok) throw new Error(`server answered ${health.status} at /healthz`);
  return `${origin}/?token=${encodeURIComponent(readTokenImpl())}`;
}

async function waitForUrl(port, options = {}) {
  const attempts = options.attempts || 30;
  const delay = options.delay || 250;
  const fetchImpl = options.fetch || fetch;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return localUrl(port, fetchImpl, options.readToken);
    } catch (_error) {
      // launchd has accepted the job but the socket is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error(`the service started but did not listen on port ${port}`);
}

function openBrowser(url, platform = process.platform) {
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.once('error', () => {});
  child.unref();
}

async function main(args, dependencies = {}) {
  const output = dependencies.output || console;
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    output.log(HELP.trimEnd());
    return 0;
  }
  if (args.includes('--version') || args.includes('-v') || args[0] === 'version') {
    output.log(packageVersion());
    return 0;
  }

  const command = args[0] && !args[0].startsWith('-') ? args[0] : 'run';
  const commandArgs = command === 'run' && args[0] !== 'run' ? args : args.slice(1);
  const { options, rest } = parseOptions(commandArgs);
  if (rest.length) throw new Error(`unknown argument: ${rest[0]}`);

  if (command === 'run') {
    const runtime = (dependencies.resolveRuntime || resolveRuntime)();
    // Open the page as soon as the server answers. The URL carries a token
    // that only exists once the server has written its config, so it has to be
    // read AFTER startup rather than guessed before it — and printing it for
    // the user to copy by hand is the thing this saves them.
    //
    // Nothing here may affect the server: a non-loopback bind, a machine with
    // no browser, or a server that never comes up are all reasons to skip the
    // page, never reasons to fail the run.
    const opened = options.open
      ? (async () => {
          const url = await (dependencies.waitForUrl || waitForUrl)(options.port);
          (dependencies.openBrowser || openBrowser)(url);
        })().catch(() => {})
      : Promise.resolve();
    const code = await (dependencies.runForeground || runForeground)(runtime, [], {
      env: {
        OCTIQ_WEB_BIND: options.bind,
        OCTIQ_WEB_PORT: String(options.port),
      },
    });
    // Settle the opener so a caller (and a test) never races it. Ctrl+C does
    // not come through here: `runForeground` re-raises the signal on itself.
    await opened;
    return code;
  }
  if (command === 'install') {
    const runtime = (dependencies.resolveRuntime || resolveRuntime)();
    const details = (dependencies.installMacService || installMacService)(runtime, {
      version: packageVersion(),
      bind: options.bind,
      port: options.port,
    });
    const url = await (dependencies.waitForUrl || waitForUrl)(options.port);
    output.log(`OctiqFlow ${packageVersion()} is running as a background service.`);
    output.log(url);
    output.log(`Logs: ${details.logs}`);
    if (options.open) (dependencies.openBrowser || openBrowser)(url);
    return 0;
  }
  if (command === 'uninstall') {
    (dependencies.uninstallMacService || uninstallMacService)();
    output.log('OctiqFlow background service removed. Your profiles and transcripts were kept.');
    return 0;
  }
  if (command === 'restart') {
    (dependencies.restartMacService || restartMacService)();
    const url = await (dependencies.waitForUrl || waitForUrl)(options.port);
    output.log(`OctiqFlow restarted: ${url}`);
    return 0;
  }
  if (command === 'status') {
    const installed = (dependencies.serviceStatus || serviceStatus)();
    let url = null;
    try {
      url = await (dependencies.localUrl || localUrl)(options.port);
    } catch (_error) {
      // Status reports both facts instead of turning an unavailable endpoint
      // into an exception that hides whether launchd owns the service.
    }
    output.log(`Service: ${installed ? 'installed' : 'not installed'}`);
    output.log(`Endpoint: ${url || 'not responding'}`);
    return installed && url ? 0 : 1;
  }
  if (command === 'open') {
    const url = await (dependencies.localUrl || localUrl)(options.port);
    (dependencies.openBrowser || openBrowser)(url);
    output.log(url);
    return 0;
  }
  throw new Error(`unknown command: ${command}; run octiqflow --help`);
}

module.exports = {
  HELP,
  localUrl,
  main,
  openBrowser,
  packageVersion,
  parseOptions,
  profileRoot,
  readToken,
  waitForUrl,
};
