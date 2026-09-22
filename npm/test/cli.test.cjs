const assert = require('node:assert/strict');
const test = require('node:test');

const { main, parseOptions, waitForUrl } = require('../lib/cli.cjs');

test('parses service options and validates the port', () => {
  assert.deepEqual(parseOptions(['--port', '1555', '--bind', '127.0.0.1', '--no-open']), {
    options: { port: 1555, bind: '127.0.0.1', open: false },
    rest: [],
  });
  assert.throws(() => parseOptions(['--port', '0']), /1 to 65535/);
  assert.throws(() => parseOptions(['--port']), /needs a value/);
});

test('install copies the selected runtime, waits for readiness, and can skip opening', async () => {
  const calls = [];
  const output = [];
  const code = await main(['install', '--port', '1555', '--no-open'], {
    resolveRuntime: () => ({ binary: '/runtime/octiq-server' }),
    installMacService: (runtime, options) => {
      calls.push(['install', runtime, options]);
      return { logs: '/logs' };
    },
    waitForUrl: async (port) => {
      calls.push(['wait', port]);
      return 'http://127.0.0.1:1555/?token=test';
    },
    openBrowser: () => calls.push(['open']),
    output: { log: (line) => output.push(line) },
  });

  assert.equal(code, 0);
  assert.equal(calls[0][0], 'install');
  assert.equal(calls[0][2].port, 1555);
  assert.deepEqual(calls[1], ['wait', 1555]);
  assert.equal(calls.some(([name]) => name === 'open'), false);
  assert.match(output.join('\n'), /running as a background service/);
});

test('foreground run forwards bind and port to the native server', async () => {
  let invocation;
  const code = await main(['run', '--port', '1666', '--bind', '127.0.0.2'], {
    resolveRuntime: () => ({ binary: '/runtime/octiq-server' }),
    runForeground: async (...args) => {
      invocation = args;
      return 7;
    },
  });
  assert.equal(code, 7);
  assert.equal(invocation[0].binary, '/runtime/octiq-server');
  assert.deepEqual(invocation[2].env, {
    OCTIQ_WEB_BIND: '127.0.0.2',
    OCTIQ_WEB_PORT: '1666',
  });
});

test('status distinguishes launchd ownership from endpoint health', async () => {
  const output = [];
  const code = await main(['status'], {
    serviceStatus: () => true,
    localUrl: async () => { throw new Error('down'); },
    output: { log: (line) => output.push(line) },
  });
  assert.equal(code, 1);
  assert.deepEqual(output, ['Service: installed', 'Endpoint: not responding']);
});

test('readiness uses the public health endpoint before asking for the local token', async () => {
  const requests = [];
  const fetch = async (url) => {
    requests.push(url);
    return {
      ok: true,
      text: async () => 'token with spaces',
    };
  };
  const url = await waitForUrl(1777, { attempts: 1, fetch });
  assert.deepEqual(requests, [
    'http://127.0.0.1:1777/healthz',
    'http://127.0.0.1:1777/token',
  ]);
  assert.equal(url, 'http://127.0.0.1:1777/?token=token%20with%20spaces');
});
