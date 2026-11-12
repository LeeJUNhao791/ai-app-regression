import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createAlternateBackend } from '../examples/alternate-backend.mjs';

test('external Web submits the alternate form and API looks up the displayed ID', async (t) => {
  const server = createAlternateBackend();
  const requests = [];
  server.prependListener('request', (req) => requests.push(`${req.method} ${req.url}`));
  server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const temp = mkdtempSync(join(tmpdir(), 'ai-app-external-web-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const output = join(temp, 'report');
  const run = (map, destination) => promisify(execFile)(process.execPath, [
    'workflow/run.mjs', '--backend-url', url, '--backend-map', 'fixtures/alternate-backend.map.json',
    '--web-url', url + '/service-desk', '--web-map', map,
    '--fixtures', 'fixtures/custom-tickets.example.json', '--output', destination,
  ], { cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 60_000 });
  await run('fixtures/alternate-web.map.json', output);
  const report = JSON.parse(readFileSync(join(output, 'report.json'), 'utf8'));
  assert.equal(report.status, 'passed');
  assert.equal(report.scope, 'external-web');
  assert.match(report.ticketId, /^WO-/);
  assert.deepEqual(requests.filter((request) => !request.endsWith('/favicon.ico')), [
    'GET /service-desk', 'POST /v2/orders', `GET /v2/orders/${report.ticketId}`,
  ]);
  assert.deepEqual(report.steps.map(({ name }) => name), ['External Web create', 'External backend lookup']);
  assert.deepEqual(report.steps[0].evidence, ['web.png']);
  assert.ok(readFileSync(join(output, 'web.png')).length > 0);

  requests.length = 0;
  const badMap = join(temp, 'wrong-id.json');
  const badOutput = join(temp, 'wrong-id-report');
  writeFileSync(badMap, JSON.stringify({
    input_selector: '#maintenance-note',
    submit_selector: '#send-request',
    ticket_id_selector: '#send-request',
  }));
  await assert.rejects(run(badMap, badOutput), { code: 1 });
  const failed = JSON.parse(readFileSync(join(badOutput, 'report.json'), 'utf8'));
  assert.match(failed.steps[0].summary, /displayed work-order ID did not match/);
  assert.deepEqual(requests.filter((request) => !request.endsWith('/favicon.ico')), [
    'GET /service-desk', 'POST /v2/orders',
  ]);
});
