const fs = require('node:fs');
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
  octiqflow                     Run in the foreground
  octiqflow install [options]   Install and start the macOS background service
  octiqflow uninstall           Remove the macOS background service
  octiqflow status [options]    Check the service and HTTP endpoint
  octiqflow restart             Restart the macOS background service
  octiqflow open [options]      Open the local browser client

Options:
  --port <number>               HTTP port (default: 1421)
  --bind <address>              Bind address (default: 127.0.0.1)
  --no-open                     Do not open a browser after installation
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

async function localUrl(port, fetchImpl = fetch) {
  const origin = `http://127.0.0.1:${port}`;
  const tokenResponse = await fetchImpl(`${origin}/token`);
  if (!tokenResponse.ok) throw new Error(`server answered ${tokenResponse.status} at /token`);
  const token = (await tokenResponse.text()).trim();
  return `${origin}/?token=${encodeURIComponent(token)}`;
}

async function waitForUrl(port, options = {}) {
  const attempts = options.attempts || 30;
  const delay = options.delay || 250;
  const fetchImpl = options.fetch || fetch;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return localUrl(port, fetchImpl);
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
    return (dependencies.runForeground || runForeground)(runtime, [], {
      env: {
        OCTIQ_WEB_BIND: options.bind,
        OCTIQ_WEB_PORT: String(options.port),
      },
    });
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

module.exports = { HELP, localUrl, main, openBrowser, packageVersion, parseOptions, waitForUrl };
