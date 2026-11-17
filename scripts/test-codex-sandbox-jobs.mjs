// Real Codex app-server + OS sandbox; the model and job hook are local stubs.
// Usage: node scripts/test-codex-sandbox-jobs.mjs /absolute/path/to/octiq-job
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const binary = resolve(process.argv[2] ?? 'src-tauri/target/debug/octiq-job');
const root = await mkdtemp(join(tmpdir(), 'octiq-codex-sandbox-jobs-'));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const results = [];
try {
  for (const mode of ['auto', 'edits', 'full', 'auto-no-spool']) {
    const scene = join(root, mode), workspace = join(scene, 'work'), spool = join(scene, 'spool');
    const codexHome = join(scene, 'codex');
    for (const path of [workspace, spool, codexHome]) await mkdir(path, { recursive: true });
    const hookCalls = [], events = [];
    let modelCalls = 0, modelError;
    const server = createServer(async (req, res) => {
      try {
        let raw = '';
        for await (const part of req) raw += part;
        const body = JSON.parse(raw);
        if (req.url === '/hook/job') {
          hookCalls.push(body);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ result: { id: 'fixture-job', token: 'fixture-token' } }));
          return;
        }
        assert.equal(req.url, '/v1/responses');
        modelCalls++;
        let item;
        if (modelCalls === 1) {
          const offered = (body.tools ?? []).flatMap(tool => tool.type === 'namespace'
            ? tool.tools.map(t => ({ ...t, namespace: tool.name })) : [tool]);
          const tool = offered.find(t => t.name === 'exec_command');
          assert(tool, 'real Codex must advertise exec_command');
          const cmd = `${quote(binary)} --label fixture -- /bin/sh -c ${quote('printf "fixture-output\\n"; exit 7')}`;
          item = { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: tool.name,
            ...(tool.namespace ? { namespace: tool.namespace } : {}),
            arguments: JSON.stringify({ cmd, workdir: workspace, yield_time_ms: 10000 }) };
        } else {
          assert(modelCalls <= 2, 'fixture must end after one command');
          item = { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: 'Fixture finished.', annotations: [] }] };
        }
        const response = { id: `resp_${modelCalls}`, object: 'response', status: 'completed', output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
        const stream = [
          { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
          { type: 'response.output_item.added', output_index: 0, item: { ...item, ...(item.arguments ? { arguments: '' } : {}) } },
          ...(item.arguments ? [
            { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments },
            { type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: item.arguments },
          ] : []),
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response },
        ];
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const event of stream) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        res.end();
      } catch (error) { modelError = error; res.writeHead(500); res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const overrides = {
      model_provider: 'stub', model: 'stub',
      'model_providers.stub.name': 'Local fixture',
      'model_providers.stub.base_url': `http://127.0.0.1:${port}/v1`,
      'model_providers.stub.wire_api': 'responses',
      'model_providers.stub.requires_openai_auth': false,
      'model_providers.stub.request_max_retries': 0,
      'model_providers.stub.stream_max_retries': 0,
      'shell_environment_policy.inherit': 'all',
    };
    const env = { ...process.env, HOME: scene, CODEX_HOME: codexHome,
      OCTIQ_HOOK_PORT: String(port), OCTIQ_CHAT_CAPABILITY: 'fixture-capability', OCTIQ_JOB_SESSION: 'chat:fixture' };
    for (const name of ['CODEX_SANDBOX_NETWORK_DISABLED', 'OCTIQ_JOB_SPOOL', 'OCTIQ_JOB_SPOOL_CAPABILITY', 'OCTIQ_JOB_SUPERVISE']) delete env[name];
    if (mode !== 'auto-no-spool') Object.assign(env, { OCTIQ_JOB_SPOOL: spool, OCTIQ_JOB_SPOOL_CAPABILITY: 'fixture-spool' });
    const child = spawn('codex', ['app-server', ...Object.entries(overrides).flatMap(([k, v]) => ['-c', `${k}=${JSON.stringify(v)}`])],
      { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    const send = value => child.stdin.write(JSON.stringify(value) + '\n');
    const sandbox = mode === 'full' ? { type: 'dangerFullAccess' } : {
      type: 'workspaceWrite', writableRoots: [workspace, spool], networkAccess: false,
      excludeTmpdirEnvVar: true, excludeSlashTmp: true,
    };
    let timeout;
    try {
      await new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Codex fixture timed out: ${mode}; ${stderr.slice(-1500)}`)), 45000);
        child.on('error', reject);
        child.on('exit', () => reject(new Error(`Codex exited before fixture completed: ${stderr.slice(-1500)}`)));
        createInterface({ input: child.stdout }).on('line', line => {
          try {
            const event = JSON.parse(line); events.push(event);
            if (event.error) throw new Error(JSON.stringify(event.error));
            if (event.id === 1) {
              send({ method: 'initialized' });
              send({ id: 2, method: 'thread/start', params: { cwd: workspace, model: 'stub', approvalPolicy: 'never',
                sandbox: mode === 'full' ? 'danger-full-access' : 'workspace-write', ephemeral: true } });
            } else if (event.id === 2 && event.result) {
              send({ id: 3, method: 'turn/start', params: { threadId: event.result.thread.id, cwd: workspace,
                approvalPolicy: 'never', sandboxPolicy: sandbox, input: [{ type: 'text', text: 'Run the fixture once.' }] } });
            } else if (event.method === 'turn/completed') resolve();
          } catch (error) { reject(error); }
        });
        send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'octiq-sandbox-fixture', version: '1' }, capabilities: { experimentalApi: true } } });
      });
      if (modelError) throw modelError;
      const command = events.find(e => e.method === 'item/completed' && e.params.item.type === 'commandExecution')?.params.item;
      assert(command, 'real sandbox must execute the command: ' + JSON.stringify(events.filter(e => e.method === 'item/completed')));
      assert.equal(command.exitCode, 7, JSON.stringify(command));
      assert.match(command.aggregatedOutput, /fixture-output/);
      const files = (await readdir(spool)).filter(name => name.endsWith('.ndjson'));
      if (mode === 'full') {
        assert.equal(files.length, 0, 'Full keeps reporting over the hook');
        assert.deepEqual(hookCalls.filter(c => c.action !== 'progress').map(c => c.action), ['start', 'end']);
        assert.equal(hookCalls.find(c => c.action === 'end').args.exitCode, 7);
        assert.doesNotMatch(command.aggregatedOutput, /host could not be reached|chat was not told/);
      } else if (mode === 'auto-no-spool') {
        assert.equal(files.length, 0);
        assert.match(command.aggregatedOutput, /the chat was not told/);
        assert.equal(hookCalls.length, 0);
      } else {
        assert.equal(hookCalls.length, 0, 'known disabled network must never attempt the hook');
        assert.equal(files.length, 1);
        const records = (await readFile(join(spool, files[0]), 'utf8')).trim().split('\n').map(JSON.parse);
        assert.equal(records[0].type, 'start');
        assert.equal(records.at(-1).type, 'end');
        assert.equal(records.at(-1).exitCode, 7);
        assert(records.every(r => r.key === 'fixture-spool'));
        assert.doesNotMatch(command.aggregatedOutput, /host could not be reached|Operation not permitted|chat was not told/);
      }
      results.push({ mode, pass: true, exitCode: command.exitCode, hookCalls: hookCalls.length, spoolFiles: files.length, model: 'local stub' });
      console.log(`PASS ${mode}: real Codex sandbox, exit 7 preserved, ${files.length} spool file(s), ${hookCalls.length} hook call(s)`);
    } finally {
      clearTimeout(timeout);
      child.kill('SIGTERM');
      await exited;
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
  console.log(JSON.stringify({ pass: true, results }));
} finally { await rm(root, { recursive: true, force: true }); }
