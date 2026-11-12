import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../workflow/run.mjs', import.meta.url));

test('model-only evaluates custom cases with no work-order or device stages', async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), 'ai-app-model-only-'));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const requests = [];
  const actual = { device: 'pump-1', category: 'leak' };
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/health') {
      response.end(JSON.stringify({ status: 'ok', os: 'Linux', mode: 'live' }));
    } else if (request.url === '/predict' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks).toString()).text);
      response.end(JSON.stringify(actual));
    } else {
      response.writeHead(404).end();
    }
  });
  server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await once(server, 'listening');

  for (const [category, code, status] of [['leak', 0, 'passed'], ['noise', 1, 'failed']]) {
    const fixtures = join(tempDir, `${category}.json`);
    const output = join(tempDir, category);
    const text = 'Pump 1 has a leak';
    const variant = 'Leak at pump 1';
    writeFileSync(fixtures, JSON.stringify([{
      id: 'custom', text, expected: { ...actual, category }, variants: [variant],
    }]));
    requests.length = 0;
    const args = [runner, '--model-only', '--live', '--fixtures', fixtures, '--output', output,
      '--model-url', `http://127.0.0.1:${server.address().port}`];
    const result = await new Promise((resolve) => {
      execFile(process.execPath, args, {
        timeout: 10_000, env: { ...process.env, PYTHON: join(tempDir, 'no-python') },
      }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
    });
    assert.equal(result.code, code, result.stderr || result.stdout);
    assert.deepEqual(requests, [text, variant]);
    const report = JSON.parse(readFileSync(join(output, 'report.json'), 'utf8'));
    assert.equal(report.scope, 'model-only');
    assert.equal(report.status, status);
    assert.equal(report.ticketId, null);
    assert.deepEqual(report.steps.map(({ name }) => name), ['Linux model service', 'Model accuracy and robustness']);
    assert.deepEqual(report.evaluation.rows.map(({ passed }) => passed), [code === 0, code === 0]);
    assert.deepEqual(readdirSync(output).sort(), ['report.html', 'report.json']);
    assert.match(readFileSync(join(output, 'report.html'), 'utf8'), /Model only/);
  }
});
