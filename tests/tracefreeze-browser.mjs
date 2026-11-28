import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createLibraryBackend } from '../examples/library/backend.mjs';

const root = new URL('../', import.meta.url);
const source = JSON.parse(readFileSync(new URL('../examples/library/tracefreeze.json', import.meta.url), 'utf8'));
const exec = promisify(execFile);

test('freeze and replay execute fresh browser/API reservations without any model settings', async (t) => {
  const server = createLibraryBackend();
  const requests = [];
  let fault;
  let upgrades = 0;
  server.on('upgrade', (_req, socket) => { upgrades++; socket.destroy(); });
  server.prependListener('request', (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const writeHead = res.writeHead.bind(res);
    res.writeHead = (status, headers) => (fault === 'redirect' && req.url.startsWith('/v1/receipts/')) ||
      (fault === 'page-redirect' && req.url === '/reserve') ||
      (fault === 'create-redirect' && req.url === '/v1/reservations')
      ? writeHead(302, { ...headers, Location: '/v1/chat/completions' }) : writeHead(status, headers);
    const end = res.end.bind(res);
    res.end = (body) => {
      if (fault === 'model-http' && req.url === '/reserve') {
        body = body.toString() + "<script>fetch('/v1/chat/completions')</script>";
      }
      if (fault === 'model-external' && req.url === '/reserve') {
        body = body.toString() + `<script>fetch('http://localhost:${server.address().port}/v1/chat/completions')</script>`;
      }
      if (fault === 'model-ws' && req.url === '/reserve') {
        body = body.toString() + `<script>new WebSocket('ws://127.0.0.1:${server.address().port}/model')</script>`;
      }
      if (fault === 'lookup' && req.url.startsWith('/v1/receipts/')) {
        const changed = JSON.parse(body); changed.receipt.state = 'rejected'; body = JSON.stringify(changed);
      }
      return end(body);
    };
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const evidenceRoot = process.env.TRACEFREEZE_EVIDENCE_ROOT;
  if (evidenceRoot) mkdirSync(evidenceRoot, { recursive: true });
  const temp = mkdtempSync(join(evidenceRoot ?? tmpdir(), 'tracefreeze-'));
  if (!evidenceRoot) t.after(() => rmSync(temp, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const key of ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'OPENAI_API_KEY']) delete env[key];
  const run = async (mode, file, name, base = `http://127.0.0.1:${server.address().port}`) => {
    const output = join(temp, name);
    let code = 0;
    try {
      await exec(process.execPath, ['workflow/tracefreeze.mjs', mode, '--contract', file,
        '--base-url', base, '--output', output], { cwd: root, timeout: 30_000,
        env });
    } catch (error) { code = error.code; }
    const report = JSON.parse(readFileSync(join(output, 'report.json'), 'utf8'));
    assert.equal(code, report.status === 'passed' ? 0 : 1);
    return { ...report, output };
  };
  const frozen = await run('freeze', 'examples/library/tracefreeze.json', 'freeze');
  assert.equal(frozen.status, 'passed');
  assert.equal(frozen.modelCalls, 0);
  const replay = await run('replay', join(frozen.output, 'contract.json'), 'replay');
  assert.equal(replay.status, 'passed');
  assert.equal(replay.modelCalls, 0);
  assert.notEqual(replay.ticketId, frozen.ticketId);
  assert.deepEqual(replay.bindings, { createdId: replay.ticketId, lookupId: replay.ticketId });
  assert.match(readFileSync(join(replay.output, 'report.html'), 'utf8'), /Android not tested/);
  assert.ok(readFileSync(join(replay.output, 'web.png')).length > 0);
  assert.deepEqual(requests, [
    'GET /reserve', 'POST /v1/reservations', `GET /v1/receipts/${frozen.ticketId}`,
    'GET /reserve', 'POST /v1/reservations', `GET /v1/receipts/${replay.ticketId}`,
  ]);

  const badFile = join(temp, 'bad.json');
  writeFileSync(badFile, JSON.stringify({ ...source, expected: { ...source.expected, device: 'branch-3' } }));
  const bad = await run('replay', badFile, 'wrong-label');
  assert.equal(bad.status, 'failed');
  assert.match(bad.steps.find(({ status }) => status === 'failed').summary, /expected labels/);

  for (const injected of ['lookup', 'redirect', 'page-redirect', 'create-redirect', 'model-http', 'model-external', 'model-ws']) {
    fault = injected;
    const failed = await run('replay', join(frozen.output, 'contract.json'), injected);
    assert.equal(failed.status, 'failed', injected);
    assert.equal(failed.modelCalls, 0);
    assert.equal(requests.filter((r) => r.includes('/chat/completions')).length, 0, injected);
    if (injected.startsWith('model-')) {
      assert.ok(failed.network.some(({ allowed }) => !allowed), injected);
      assert.equal(requests.filter((r) => r.includes('/chat/completions')).length, 0);
      assert.equal(upgrades, 0);
    }
  }
  fault = undefined;

  writeFileSync(badFile, JSON.stringify({ ...source, web: { ...source.web, ticket_id_selector: '#reserve-space' } }));
  const badFreeze = await run('freeze', badFile, 'failed-freeze');
  assert.equal(badFreeze.status, 'failed');
  assert.throws(() => readFileSync(join(badFreeze.output, 'contract.json')), { code: 'ENOENT' });

  for (const [name, patch] of [
    ['version', { version: 2 }], ['file', { web: '../private.json' }],
    ['traversal', { page_path: '/../reserve' }], ['encoded', { page_path: '/%2e%2e/reserve' }],
    ['model', { backend: { ...source.backend, create_path: '/v1/chat/completions' } }],
    ['unknown', { shell: 'echo unsafe' }],
  ]) {
    const before = requests.length;
    writeFileSync(badFile, JSON.stringify({ ...source, ...patch }));
    const report = await run('replay', badFile, name);
    assert.equal(report.status, 'failed', name);
    assert.equal(requests.length, before, name);
    assert.equal(report.steps.length, 1);
  }
  const before = requests.length;
  const remote = await run('replay', join(frozen.output, 'contract.json'), 'remote', 'https://example.com');
  assert.equal(remote.status, 'failed');
  assert.equal(requests.length, before);
  if (evidenceRoot) writeFileSync(join(temp, 'request-audit.json'), JSON.stringify({
    modelEnvironment: 'LLM_API_KEY, LLM_BASE_URL, LLM_MODEL and OPENAI_API_KEY removed from child environment',
    requests, websocketUpgrades: upgrades, modelEndpointHits: requests.filter((r) => r.includes('/chat/completions')).length,
  }, null, 2) + '\n');
});
