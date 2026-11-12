import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluate, requestPrediction } from '../workflow/evaluate.mjs';
import { renderReport, runStatus } from '../workflow/report.mjs';

test('robustness requires the correct label even when wrong predictions agree', async () => {
  const expected = { device: 'pump-3', category: 'noise' };
  const cases = [{ id: 'noise', text: 'Pump 3 is noisy', variants: ['Noise from pump 3'], expected }];
  const result = await evaluate(cases, async () => ({ ...expected, device: 'pump-2' }));
  assert.deepEqual(result.accuracy, { passed: 0, total: 1 });
  assert.deepEqual(result.robustness, { passed: 0, total: 1 });
  assert.equal(result.rows[1].id, 'noise.1');
  assert.match(result.rows[1].failureReason, /Labels differ/);
});

test('a robustness family requires its original input to pass', async () => {
  const expected = { device: 'pump-3', category: 'noise' };
  const cases = [{ id: 'noise', text: 'Original', variants: ['Rewrite'], expected }];
  const result = await evaluate(cases, async (text) => ({
    ...expected, device: text === 'Original' ? 'pump-2' : 'pump-3',
  }));
  assert.deepEqual(result.robustness, { passed: 0, total: 1 });
  assert.match(result.rows[1].failureReason, /Original case failed/);
});

test('a malformed or failed prediction is reported without persisting provider details', async () => {
  const expected = { device: null, category: 'unknown' };
  const cases = [{ id: 'unknown', text: 'A', variants: ['B', 'C'], expected }];
  const result = await evaluate(cases, async (text) => {
    if (text === 'B') throw new Error('private provider diagnostic');
    return text === 'C' ? { ...expected, diagnostic: 'private field' } : expected;
  });
  assert.deepEqual(result.accuracy, { passed: 1, total: 1 });
  assert.deepEqual(result.robustness, { passed: 0, total: 2 });
  assert.equal(result.rows[1].actual, null);
  assert.equal(result.rows[2].actual, null);
  assert.match(result.rows[1].failureReason, /could not be completed/);
  assert.match(result.rows[2].failureReason, /fields failed validation/);
  assert.ok(result.rows.every(({ durationMs }) => Number.isInteger(durationMs) && durationMs >= 0));
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test('evaluation reports provider HTTP errors and timeouts without copying diagnostics', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (JSON.parse(options.body).text === 'timeout') throw new DOMException('private URL', 'TimeoutError');
    return Response.json({ error: 'provider_http_error', provider_status: 429, diagnostic: 'private body' },
      { status: 502 });
  });
  const expected = { device: null, category: 'unknown' };
  const cases = [{ id: 'unknown', text: 'rate-limit', variants: ['timeout'], expected }];
  const result = await evaluate(cases, (text) => requestPrediction('http://fixture.invalid', text));
  assert.match(result.rows[0].failureReason, /HTTP 429/);
  assert.match(result.rows[1].failureReason, /timed out/);
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test('report escapes model data and keeps skipped checks visible', () => {
  const run = {
    mode: 'mock', ticketId: '<script>unsafe</script>', startedAt: '2026-01-01',
    steps: [{ name: 'Android', status: 'skipped', summary: 'No device', evidence: [] }],
    evaluation: { rows: [{ id: 'timeout', kind: 'Accuracy', text: 'Sample', expected: null,
      actual: null, durationMs: 125, failureReason: 'Provider timed out', passed: false }] },
  };
  const html = renderReport(run);
  assert.equal(runStatus(run.steps), 'partial');
  assert.match(html, /&lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>unsafe/);
  assert.match(html, /No device/);
  assert.match(html, /125 ms/);
  assert.match(html, /Provider timed out/);
  assert.equal(runStatus([...run.steps, { status: 'failed' }]), 'failed');
});
