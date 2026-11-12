import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../workflow/run.mjs', import.meta.url));
const sample = { id: 'pump-1-leak', text: 'Pump 1 is leaking', expected: { device: 'pump-1', category: 'leak' } };

test('the CLI rejects invalid fixture input before running any checks', async (t) => {
  const cases = [
    ['missing file', undefined, /root.*could not read/i],
    ['invalid JSON', '[{', /root.*invalid JSON/i],
    ['empty dataset', '[]', /root.*non-empty array/i],
    ['missing id', JSON.stringify([{ ...sample, id: undefined }]), /sample 1.*field id/i],
    ['blank text', JSON.stringify([{ ...sample, text: '  ' }]), /sample 1.*pump-1-leak.*field text/i],
    ['unsupported label', JSON.stringify([{ ...sample, expected: { ...sample.expected, category: 'vibration' } }]),
      /sample 1.*pump-1-leak.*field expected\.category/i],
    ['invalid variant', JSON.stringify([{ ...sample, variants: [false] }]),
      /sample 1.*pump-1-leak.*field variants\[0\]/i],
    ['duplicate id', JSON.stringify([sample, sample]), /sample 2.*pump-1-leak.*field id/i],
  ];
  for (const [name, contents, diagnostic] of cases) {
    await t.test(name, (subtest) => {
      const tempDir = mkdtempSync(join(tmpdir(), 'ai-app-fixtures-'));
      subtest.after(() => rmSync(tempDir, { recursive: true, force: true }));
      const file = 'my tickets.json';
      if (contents !== undefined) writeFileSync(join(tempDir, file), contents);
      const result = spawnSync(process.execPath, [
        runner, '--fixtures', file, '--live', '--android', 'required', '--output', 'report',
      ], { cwd: tempDir, encoding: 'utf8', timeout: 10_000 });
      assert.ifError(result.error);
      assert.equal(result.status, 1, result.stdout || result.stderr);
      assert.ok(result.stdout.includes(join(tempDir, file)), result.stdout || result.stderr);
      assert.match(result.stdout, diagnostic);
      const reportDir = join(tempDir, 'report');
      const report = JSON.parse(readFileSync(join(reportDir, 'report.json'), 'utf8'));
      assert.equal(report.status, 'failed');
      assert.equal(report.ticketId, null);
      assert.equal(report.evaluation, null);
      assert.equal(report.steps.length, 1);
      assert.deepEqual(readdirSync(reportDir).sort(), ['report.html', 'report.json']);
    });
  }
});
