import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { checkAndroid } from './android.mjs';
import { evaluate, labelsMatch } from './evaluate.mjs';
import { renderReport, runStatus } from './report.mjs';
import { checkWeb } from './web.mjs';

const root = resolve(import.meta.dirname, '..');
const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const providerKey = process.env.LLM_API_KEY;
delete process.env.LLM_API_KEY;
const usage = 'npm run check -- [--live] [--model-url URL] [--android auto|required|off] ' +
  '[--serial SERIAL] [--output DIR] [--fault wrong-device]';
const { values: options } = parseArgs({ options: {
  live: { type: 'boolean' },
  'model-url': { type: 'string' },
  android: { type: 'string', default: 'auto' },
  serial: { type: 'string' },
  output: { type: 'string' },
  fault: { type: 'string' },
  help: { type: 'boolean' },
} });
if (options.help) {
  console.log(usage);
  process.exit(0);
}
if (!['auto', 'required', 'off'].includes(options.android) ||
    (options.fault && (options.fault !== 'wrong-device' || options.live || options['model-url']))) {
  throw new Error(usage);
}

const run = { startedAt: new Date().toISOString(), mode: options.live ? 'live' : 'mock',
  ticketId: null, steps: [], evaluation: null };
const outputDir = resolve(options.output ?? join(root, 'artifacts', `run-${randomUUID().slice(0, 8)}`));
mkdirSync(dirname(outputDir), { recursive: true });
mkdirSync(outputDir);

const children = [];
const abort = new AbortController();
let interruptCode;
let container;
function stopServices() {
  if (container) {
    spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore', timeout: 10000 });
    container = undefined;
  }
  for (const { child } of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(signal, () => {
    interruptCode ??= code;
    abort.abort();
  });
}

const requestSignal = (timeout) => AbortSignal.any([abort.signal, AbortSignal.timeout(timeout)]);

function launch(command, args, env, log) {
  const fd = openSync(join(outputDir, log), 'w');
  try {
    const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', fd, fd], windowsHide: true });
    const state = { child, error: null };
    child.on('error', (error) => { state.error = error.code ?? 'spawn failed'; });
    children.push(state);
    return state;
  } finally {
    closeSync(fd);
  }
}

async function freePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForHealth(url, processState, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    abort.signal.throwIfAborted();
    if (processState?.error) throw new Error(`Service could not start (${processState.error}).`);
    if (processState && processState.child.exitCode !== null) {
      throw new Error(`Service exited with code ${processState.child.exitCode}. See the service log.`);
    }
    try {
      const response = await fetch(`${url}/health`, { signal: requestSignal(1000) });
      if (response.ok) {
        const health = await response.json();
        if (health.status === 'ok') return health;
      }
    } catch {
      // A process can be alive before its HTTP listener is ready.
    }
    await wait(250);
  }
  throw new Error('Service did not become ready before the deadline.');
}

async function stage(name, callback, logs = []) {
  if (abort.signal.aborted) return skipped(name, 'The workflow was interrupted.');
  try {
    const result = await callback();
    run.steps.push({ name, status: result.status ?? 'passed', summary: result.summary,
      evidence: result.evidence ?? logs });
    return result.value;
  } catch (error) {
    run.steps.push({ name, status: 'failed', summary: error.message,
      evidence: [...logs, ...(error.evidence ?? [])].filter((file) => existsSync(join(outputDir, file))) });
    return undefined;
  }
}

function skipped(name, summary) {
  run.steps.push({ name, status: 'skipped', summary, evidence: [] });
}

async function startModel() {
  let url = options['model-url'];
  let service;
  if (!url) {
    const port = await freePort();
    url = `http://127.0.0.1:${port}`;
    const env = { ...process.env, MODEL_MODE: run.mode, MOCK_FAULT: options.fault ?? '',
      PYTHONUNBUFFERED: '1' };
    if (run.mode === 'live' && providerKey) env.LLM_API_KEY = providerKey;
    if (process.platform === 'linux') {
      service = launch(python, ['services/model.py', '--port', String(port)], env, 'model.log');
    } else {
      const engine = spawnSync('docker', ['info', '--format', '{{.OSType}}'],
        { encoding: 'utf8', windowsHide: true, timeout: 10000 });
      if (engine.status !== 0 || engine.stdout.trim() !== 'linux') {
        throw new Error('Start Docker Desktop with Linux containers, or supply --model-url for a Linux model service.');
      }
      container = `ai-app-regression-${randomUUID().slice(0, 12)}`;
      const settings = ['MODEL_MODE', 'MOCK_FAULT', 'PYTHONUNBUFFERED'];
      if (run.mode === 'live') settings.push('LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY');
      service = launch('docker', ['run', '--rm', '--name', container,
        '--mount', `type=bind,source=${join(root, 'services')},target=/app/services,readonly`,
        '-p', `127.0.0.1:${port}:8001`, ...settings.flatMap((key) => ['--env', key]),
        'python:3.12-slim', 'python', '/app/services/model.py', '--host', '0.0.0.0', '--port', '8001'],
      env, 'model.log');
    }
  }
  url = url.replace(/\/+$/, '');
  const health = await waitForHealth(url, service, service && process.platform !== 'linux' ? 120000 : 20000);
  assert.equal(health.os, 'Linux', 'Model health did not report Linux.');
  assert.equal(health.mode, run.mode, `Expected model service mode ${run.mode}.`);
  return { value: url, summary: `Linux service responded in ${health.mode} mode.`,
    evidence: service ? ['model.log'] : [] };
}

async function startBackend(modelUrl) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const backend = launch(python, ['services/backend.py', '--port', String(port)],
    { ...process.env, MODEL_URL: modelUrl, PYTHONUNBUFFERED: '1' }, 'backend.log');
  await waitForHealth(url, backend);
  return { value: { url, port }, summary: 'Work-order API is ready.', evidence: ['backend.log'] };
}

async function runChecks() {
  const cases = JSON.parse(readFileSync(join(root, 'fixtures', 'tickets.json'), 'utf8'));
  const first = cases[0];
  const modelUrl = await stage('Linux model service', startModel, ['model.log']);
  const backend = modelUrl
    ? await stage('Backend startup', () => startBackend(modelUrl), ['backend.log'])
    : undefined;
  if (!modelUrl) skipped('Backend startup', 'Linux model service was unavailable.');

  const web = backend ? await stage('Web frontend', async () => {
    const result = await checkWeb({ baseUrl: backend.url, text: first.text, outputDir });
    run.ticketId = result.ticket.id;
    return { value: result.ticket, summary: 'Chromium submitted the work order and displayed the API result.',
      evidence: result.evidence };
  }) : undefined;
  if (!backend) skipped('Web frontend', 'The backend was unavailable.');

  const ticket = web ? await stage('Backend API', async () => {
    const response = await fetch(`${backend.url}/api/tickets/${encodeURIComponent(web.id)}`,
      { signal: requestSignal(5000) });
    assert.equal(response.status, 200, 'Work-order lookup did not return HTTP 200.');
    const result = await response.json();
    assert.deepEqual(result, web, 'Work-order lookup differed from the result displayed on Web.');
    assert.equal(result.text, first.text, 'The submitted text was not preserved.');
    assert.equal(result.status, 'completed', 'The work order was not completed.');
    return { value: result, summary: 'The API returned the same completed work order and result.' };
  }) : undefined;
  if (!web) skipped('Backend API', 'There was no work order from the Web step.');

  if (modelUrl) {
    await stage('Model accuracy and robustness', async () => {
      run.evaluation = await evaluate(cases, async (text) => {
        const response = await fetch(`${modelUrl}/predict`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
          signal: requestSignal(30000),
        });
        assert.equal(response.status, 200, 'Model prediction failed.');
        return response.json();
      });
      const { accuracy, robustness } = run.evaluation;
      const caseSummary = `Accuracy ${accuracy.passed}/${accuracy.total}. Robustness ${robustness.passed}/${robustness.total}.`;
      const ticketCorrect = ticket && labelsMatch(ticket.result, first.expected);
      const summary = `${caseSummary} ${ticket ? (ticketCorrect ? 'Work-order labels match.' : 'Work-order labels differ from the reference.') : 'Work-order labels were unavailable.'}`;
      const passed = accuracy.passed === accuracy.total && robustness.passed === robustness.total && (!ticket || ticketCorrect);
      return { status: passed ? 'passed' : 'failed', summary };
    });
  } else skipped('Model accuracy and robustness', 'Linux model service was unavailable.');

  if (!ticket || options.android === 'off') {
    skipped('Android device', options.android === 'off' ? 'Disabled for this run.' : 'There was no verified work order.');
  } else {
    await stage('Android device', () => checkAndroid({
      backendPort: backend.port, ticket, serial: options.serial ?? process.env.ADB_SERIAL,
      outputDir, required: options.android === 'required',
    }));
  }
}

try {
  await runChecks();
} catch (error) {
  run.steps.push({ name: 'Workflow', status: 'failed', summary: error.message, evidence: [] });
} finally {
  stopServices();
  if (interruptCode) run.steps.push({ name: 'Workflow', status: 'failed', summary: 'Interrupted.', evidence: [] });
  const status = runStatus(run.steps);
  writeFileSync(join(outputDir, 'report.html'), renderReport(run));
  writeFileSync(join(outputDir, 'report.json'), `${JSON.stringify({ ...run, status }, null, 2)}\n`);
  for (const step of run.steps) console.log(`${step.status.toUpperCase()}  ${step.name} — ${step.summary}`);
  console.log(`Report: ${join(outputDir, 'report.html')}`);
  process.exitCode = interruptCode ?? (status === 'failed' ? 1 : 0);
}
