// Capture Codex's own approval payload. Only a local stub model and MCP run;
// no account, model service, OctiqFlow server or paid calls are used.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
const tool = 'orchestration_worker_report';
const approved = process.argv.includes('--approve');
if (process.argv.includes('--mcp')) {
  createInterface({ input: process.stdin }).on('line', line => {
    const r = JSON.parse(line);
    if (r.id === undefined) return;
    const result = r.method === 'initialize'
      ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1' } }
      : r.method === 'tools/list'
        ? { tools: [{ name: tool, description: 'Report this attempt', inputSchema: { type: 'object', properties: { outcome: { type: 'string' } } } }] }
        : { content: [{ type: 'text', text: 'stub only' }] };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result }) + '\n');
  });
} else {
  const home = mkdtempSync(join(tmpdir(), 'octiq-codex-capture-'));
  console.log('Evidence:', home);
  mkdirSync(join(home, 'codex'));
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    writeFileSync(join(home, 'model-request.json'), JSON.stringify(body, null, 2));
    const offered = (body.tools ?? []).flatMap(t => t.type === 'namespace' ? t.tools.map(x => ({ ...x, namespace: t.name })) : [t]);
    const selected = offered.find(t => t.name?.includes(tool));
    if (!selected) { res.writeHead(500); res.end(); return; }
    const item = { type: 'function_call', id: 'fc_stub', call_id: 'call_stub', name: selected.name, ...(selected.namespace ? { namespace: selected.namespace } : {}), arguments: '{"outcome":"completed"}' };
    const response = { id: 'resp_stub', object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments },
      { type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: item.arguments },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const overrides = {
    model_provider: 'stub', model: 'stub',
    'model_providers.stub.name': 'Local stub',
    'model_providers.stub.base_url': `http://127.0.0.1:${server.address().port}/v1`,
    'model_providers.stub.wire_api': 'responses',
    'mcp_servers.octiq.command': process.execPath,
    'mcp_servers.octiq.args': [script, '--mcp'],
    ...(approved ? { [`mcp_servers.octiq.tools.${tool}.approval_mode`]: 'approve' } : {}),
  };
  const child = spawn('codex', ['app-server', ...Object.entries(overrides).flatMap(([k,v]) => ['-c', `${k}=${JSON.stringify(v)}`])], {
    cwd: home, env: { ...process.env, HOME: home, CODEX_HOME: join(home, 'codex') }, stdio: ['pipe','pipe','pipe'],
  });
  child.stderr.on('data', d => process.stderr.write(d));
  const send = r => child.stdin.write(JSON.stringify(r) + '\n');
  const timeout = setTimeout(() => { child.kill(); server.close(); throw new Error('No elicitation within 25s'); }, 25000);
  createInterface({ input: child.stdout }).on('line', line => {
    appendFileSync(join(home, 'app-server.jsonl'), line + '\n');
    const r = JSON.parse(line);
    if (r.id === 1) {
      send({ method: 'initialized' });
      send({ id: 2, method: 'thread/start', params: { cwd: home, model: 'stub', approvalPolicy: 'on-request', sandbox: 'read-only', ephemeral: true } });
    } else if (r.id === 2 && r.result) {
      send({ id: 3, method: 'turn/start', params: { threadId: r.result.thread.id, input: [{ type: 'text', text: 'Report the attempt now.' }] } });
    } else if (r.method === 'item/completed' && approved && r.params.item.type === 'mcpToolCall') {
      if (r.params.item.error) throw new Error(JSON.stringify(r.params.item.error));
      console.log('PASS: explicit bookkeeping approval executes the real MCP call without elicitation');
      clearTimeout(timeout); child.kill(); server.close();
    } else if (r.method?.includes('elicitation') && r.id !== undefined) {
      if (approved) throw new Error('Preapproved bookkeeping tool unexpectedly requested elicitation');
      const target = resolve(process.argv[2] ?? 'src-tauri/src/fixtures/codex-0.163.0-elicitation.json');
      writeFileSync(target, JSON.stringify(r, null, 2) + '\n');
      console.log(`Captured real Codex payload: ${target}`);
      send({ id: r.id, result: { action: 'cancel', content: null } });
      clearTimeout(timeout); child.kill(); server.close();
    } else if (r.error) console.error(JSON.stringify(r));
  });
  send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'octiq-fixture', version: '1' }, capabilities: { experimentalApi: true } } });
}
