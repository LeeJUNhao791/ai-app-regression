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
import { createLibraryBackend } from '../examples/library/backend.mjs';

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

test('external Web reuses the field maps for a library reservation', async (t) => {
  const server = createLibraryBackend();
  const requests = [];
  server.prependListener('request', (req) => requests.push(`${req.method} ${req.url}`));
  server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const temp = mkdtempSync(join(tmpdir(), 'ai-app-library-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const example = 'examples/library';
  const run = (fixture, output) => promisify(execFile)(process.execPath, [
    'workflow/run.mjs', '--backend-url', url, '--backend-map', `${example}/backend.map.json`,
    '--web-url', url + '/reserve', '--web-map', `${example}/web.map.json`,
    '--profile', `${example}/profile.json`, '--fixtures', fixture, '--output', output,
  ], { cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 60_000 });
  const fixture = `${example}/reservations.json`;
  const output = join(temp, 'report');
  await run(fixture, output);
  const report = JSON.parse(readFileSync(join(output, 'report.json'), 'utf8'));
  assert.equal(report.status, 'passed');
  assert.equal(report.scope, 'external-web');
  assert.equal(report.evaluation, null);
  assert.match(report.ticketId, /^RES-/);
  assert.deepEqual(requests.filter((request) => !request.endsWith('/favicon.ico')), [
    'GET /reserve', 'POST /v1/reservations', `GET /v1/receipts/${report.ticketId}`,
  ]);
  assert.deepEqual(report.steps.map(({ name, status }) => [name, status]), [
    ['External Web create', 'passed'], ['External backend lookup', 'passed'],
  ]);
  assert.match(report.steps[1].summary, /accepted and expected labels branch-2 \/ study-room/);
  assert.ok(readFileSync(join(output, 'web.png')).length > 0);

  const wrongFixture = join(temp, 'wrong-label.json');
  const wrongOutput = join(temp, 'wrong-label-report');
  const samples = JSON.parse(readFileSync(new URL('../examples/library/reservations.json', import.meta.url), 'utf8'));
  samples[0].expected.category = 'event-space';
  writeFileSync(wrongFixture, JSON.stringify(samples));
  await assert.rejects(run(wrongFixture, wrongOutput), { code: 1 });
  const failed = JSON.parse(readFileSync(join(wrongOutput, 'report.json'), 'utf8'));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.steps[0].status, 'passed');
  assert.equal(failed.steps[1].status, 'failed');
  assert.match(failed.steps[1].summary, /labels differed from the expected labels/);
});
