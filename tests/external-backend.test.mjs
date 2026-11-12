import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createAlternateBackend } from '../examples/alternate-backend.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);

async function runAgainst(t, server, mapping) {
  const output = mkdtempSync(join(tmpdir(), 'ai-app-backend-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const reportDir = join(output, 'report');
  server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await once(server, 'listening');
  const mapPath = join(output, 'map.json');
  writeFileSync(mapPath, mapping ?? readFileSync(join(root, 'fixtures/alternate-backend.map.json')));
  const args = ['workflow/run.mjs', '--backend-url', `http://127.0.0.1:${server.address().port}`,
    '--backend-map', mapPath, '--fixtures', 'fixtures/custom-tickets.example.json', '--output', reportDir];
  const code = await exec(process.execPath, args, {
    cwd: root, timeout: 15_000, env: { ...process.env, PYTHON: join(output, 'no-python') },
  }).then(() => 0, (error) => error.code);
  const report = JSON.parse(readFileSync(join(reportDir, 'report.json'), 'utf8'));
  assert.deepEqual(readdirSync(reportDir).sort(), ['report.html', 'report.json']);
  return { code, report, html: readFileSync(join(reportDir, 'report.html'), 'utf8') };
}

test('external backend creates and reads the same work order using mapped paths and fields', async (t) => {
  const server = createAlternateBackend();
  const requests = [];
  server.prependListener('request', (req) => requests.push(`${req.method} ${req.url}`));
  const { code, report, html } = await runAgainst(t, server);
  assert.equal(code, 0);
  assert.equal(report.status, 'passed');
  assert.equal(report.scope, 'external-backend');
  assert.match(report.ticketId, /^WO-/);
  assert.deepEqual(requests, ['POST /v2/orders', `GET /v2/orders/${report.ticketId}`]);
  assert.deepEqual(report.steps.map(({ name, status }) => [name, status]), [
    ['External backend create', 'passed'], ['External backend lookup', 'passed'],
  ]);
  assert.match(html, /External backend/);
  assert.match(html, /pump-1 \/ leak/);
});

test('external backend fails when lookup returns a different ID', async (t) => {
  const record = (id) => ({
    order: { reference: id, description: 'fixture', state: 'resolved' },
    classification: { asset: 'pump-1', issue: 'leak' },
  });
  const server = createServer(async (req, res) => {
    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const created = record('WO/1');
      created.order.description = JSON.parse(Buffer.concat(chunks)).description;
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(created));
    } else {
      res.writeHead(req.url === '/v2/orders/WO%2F1' ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(record('WO-2')));
    }
  });
  const { code, report } = await runAgainst(t, server);
  assert.equal(code, 1);
  assert.equal(report.ticketId, 'WO/1');
  assert.equal(report.steps[1].status, 'failed');
  assert.match(report.steps[1].summary, /different work-order ID/i);
});

test('external backend validates the mapping before sending requests', async (t) => {
  let calls = 0;
  const server = createServer((_req, res) => {
    calls++;
    res.writeHead(500).end();
  });
  const map = JSON.parse(readFileSync(join(root, 'fixtures/alternate-backend.map.json'), 'utf8'));
  map.lookup_path = '/v2/orders';
  const { code, report } = await runAgainst(t, server, JSON.stringify(map));
  assert.equal(code, 1);
  assert.equal(calls, 0);
  assert.match(report.steps[0].summary, /lookup_path.*\{id\}/);
});
