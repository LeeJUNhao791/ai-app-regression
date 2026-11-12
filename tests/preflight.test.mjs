import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../workflow/run.mjs', import.meta.url));

function runWithoutServices(t, args, settings = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), 'ai-app-preflight-'));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const output = join(tempDir, 'report');
  const result = spawnSync(process.execPath, [runner, '--live', ...args, '--output', output], {
    cwd: tempDir,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: tempDir, ANDROID_HOME: tempDir, ANDROID_SDK_ROOT: tempDir, LOCALAPPDATA: tempDir,
      PYTHON: join(tempDir, 'no-python'), ADB_SERIAL: '',
      LLM_BASE_URL: '', LLM_MODEL: '', LLM_API_KEY: '',
      ...settings,
    },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  return { stdout: result.stdout, report: JSON.parse(readFileSync(join(output, 'report.json'), 'utf8')) };
}

test('live preflight names all missing settings in the terminal before starting the model', (t) => {
  const { stdout, report } = runWithoutServices(t, ['--android', 'off']);
  assert.match(stdout, /FAILED  Live model configuration .*LLM_BASE_URL, LLM_MODEL/);
  assert.deepEqual(report.steps.map(({ name, status }) => [name, status]), [['Live model configuration', 'failed']]);
  assert.equal(report.evaluation, null);
});

test('live preflight names only the missing setting and keeps supplied values out of the report', (t) => {
  const { stdout, report } = runWithoutServices(t, ['--android', 'off'], { LLM_MODEL: 'private-model-id' });
  assert.match(stdout, /Missing required live model settings: LLM_BASE_URL\./);
  assert.doesNotMatch(stdout + JSON.stringify(report), /private-model-id/);
});

test('required Android authorization fails before model requests when ADB is unavailable', (t) => {
  const { stdout, report } = runWithoutServices(t, ['--android', 'required'], {
    LLM_BASE_URL: 'http://127.0.0.1:1/v1',
    LLM_MODEL: 'fixture',
  });
  assert.match(stdout, /FAILED  Android authorization .*ADB is unavailable/);
  assert.deepEqual(report.steps.map(({ name, status }) => [name, status]), [
    ['Live model configuration', 'passed'],
    ['Android authorization', 'failed'],
  ]);
  assert.equal(report.ticketId, null);
  assert.equal(report.evaluation, null);
});

test('an existing live model service does not require local provider settings', (t) => {
  const { report } = runWithoutServices(t, ['--android', 'required', '--model-url', 'http://127.0.0.1:1']);
  assert.deepEqual(report.steps.map(({ name, status }) => [name, status]), [['Android authorization', 'failed']]);
});
