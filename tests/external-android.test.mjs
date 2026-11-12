import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('invalid external Android mapping stops before the Web and API steps', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'ai-app-external-android-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const map = join(temp, 'android.json');
  const output = join(temp, 'report');
  writeFileSync(map, JSON.stringify({ app_package: 'example.app', instrumentation: 'invalid' }));
  const result = spawnSync(process.execPath, [
    'workflow/run.mjs', '--backend-url', 'http://127.0.0.1:1',
    '--backend-map', 'fixtures/alternate-backend.map.json',
    '--web-url', 'http://127.0.0.1:1/form', '--web-map', 'fixtures/alternate-web.map.json',
    '--android-map', map, '--fixtures', 'fixtures/custom-tickets.example.json', '--output', output,
  ], { encoding: 'utf8', timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Android map.*instrumentation/);
  const report = JSON.parse(readFileSync(join(output, 'report.json'), 'utf8'));
  assert.equal(report.scope, 'external-android');
  assert.equal(report.ticketId, null);
  assert.deepEqual(report.steps.map(({ name }) => name), ['Workflow']);
});
