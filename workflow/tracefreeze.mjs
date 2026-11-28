import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { externalBackend } from './external-backend.mjs';
import { renderReport } from './report.mjs';
import { checkExternalWeb } from './web.mjs';

const usage = 'node workflow/tracefreeze.mjs freeze|replay --contract FILE --base-url http://127.0.0.1:PORT --output NEW_DIR';
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  contract: { type: 'string' }, 'base-url': { type: 'string' }, output: { type: 'string' },
} });
if (positionals.length !== 1 || !['freeze', 'replay'].includes(positionals[0]) ||
    !values.contract || !values['base-url'] || !values.output) throw new Error(usage);
const mode = positionals[0];
const output = resolve(values.output);
mkdirSync(dirname(output), { recursive: true });
mkdirSync(output);
const run = { startedAt: new Date().toISOString(), mode: `TraceFreeze ${mode}`, scope: 'external-web',
  status: 'failed', ticketId: null, bindings: {}, network: [], modelCalls: 0, evaluation: null,
  android: 'not tested', steps: [] };
let stage = 'Contract preflight';
const passed = (summary, evidence = []) => run.steps.push({ name: stage, status: 'passed', summary, evidence });
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function keys(value, fields) {
  assert.ok(object(value) && Object.keys(value).length === fields.length &&
    fields.every((key) => Object.hasOwn(value, key)), 'Contract fields must match the v1 schema.');
}
const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);

try {
  const contract = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(resolve(values.contract))));
  keys(contract, ['version', 'page_path', 'web', 'backend', 'text', 'expected']);
  assert.equal(contract.version, 1, 'Unsupported contract version.');
  // v1 freezes only the explicit library flow; expanding routes requires a new reviewed contract version.
  assert.equal(contract.page_path, '/reserve', 'Contract page_path must be /reserve.');
  keys(contract.web, ['input_selector', 'submit_selector', 'ticket_id_selector']);
  assert.ok(Object.values(contract.web).every((v) => typeof v === 'string' && v.trim() && v.length <= 256),
    'Contract Web selectors must be non-empty strings of at most 256 characters.');
  keys(contract.backend, ['create_path', 'lookup_path', 'request_text_field', 'completed_status', 'response']);
  assert.equal(contract.backend.create_path, '/v1/reservations', 'Contract create_path must be /v1/reservations.');
  assert.equal(contract.backend.lookup_path, '/v1/receipts/{id}', 'Contract lookup_path must be /v1/receipts/{id}.');
  keys(contract.backend.response, ['id', 'text', 'status', 'device', 'category']);
  assert.ok(Object.values(contract.backend.response).every((v) => typeof v === 'string' &&
    v.split('.').every((p) => identifier(p) && !['__proto__', 'prototype', 'constructor'].includes(p))),
  'Contract response fields must be safe dot-separated field paths.');
  assert.ok(identifier(contract.backend.request_text_field), 'Contract request field must be an identifier.');
  assert.ok(typeof contract.text === 'string' && contract.text.trim() && contract.text.length <= 4096,
    'Contract text must be a non-empty string of at most 4096 characters.');
  keys(contract.expected, ['status', 'device', 'category']);
  assert.ok(Object.values(contract.expected).every(identifier), 'Contract expected fields must be identifiers.');
  assert.equal(contract.expected.status, contract.backend.completed_status, 'Contract statuses must agree.');
  const base = new URL(values['base-url']);
  assert.ok(base.protocol === 'http:' && base.hostname === '127.0.0.1' && base.port &&
    base.pathname === '/' && !base.search && !base.hash && !base.username && !base.password,
  'TraceFreeze v1 requires an explicit http://127.0.0.1:PORT origin without credentials, path, query or fragment.');
  const profile = { device_id_pattern: '[A-Za-z0-9_-]+', categories: [contract.expected.category] };
  const client = externalBackend(base.origin, contract.backend, profile);
  const pageUrl = base.origin + contract.page_path;
  passed(`Validated v1 library Web/API contract for ${mode} before sending requests.`);

  stage = 'Web create and bind';
  const networkPolicy = async (context) => {
    await context.route('**/*', async (route) => {
      const request = route.request();
      const allowed = (request.method() === 'GET' && request.url() === pageUrl) ||
        (request.method() === 'POST' && request.url() === client.createUrl);
      run.network.push({ method: request.method(), url: request.url(), allowed });
      if (!allowed) return route.abort('blockedbyclient');
      // route.continue can follow redirects without routing the next hop.
      try {
        const response = await route.fetch({ maxRedirects: 0, timeout: 5000 });
        if (response.status() >= 300 && response.status() < 400) {
          run.network.push({ method: 'REDIRECT', url: request.url(), allowed: false });
          return route.abort('blockedbyclient');
        }
        await route.fulfill({ response });
      } catch {
        await route.abort('failed').catch(() => {});
      }
    });
    await context.routeWebSocket('**/*', (socket) => {
      run.network.push({ method: 'WEBSOCKET', url: socket.url(), allowed: false });
      socket.close();
    });
  };
  const { ticket, evidence } = await checkExternalWeb({ pageUrl, mapPath: contract.web,
    client, text: contract.text, outputDir: output, networkPolicy, responseTimeoutMs: 5000 });
  assert.ok(run.network.every(({ allowed }) => allowed), 'Browser attempted a forbidden network destination.');
  assert.ok(identifier(ticket.id), 'Created ID must be a safe single path segment.');
  assert.equal(ticket.text, contract.text, 'Created reservation changed the submitted text.');
  run.ticketId = ticket.id;
  run.bindings.createdId = ticket.id;
  passed(`Browser displayed created ID ${ticket.id}; bound it for API lookup.`, evidence);

  stage = 'API lookup and assertions';
  const lookupUrl = base.origin + contract.backend.lookup_path.replace('{id}', encodeURIComponent(ticket.id));
  run.network.push({ method: 'GET', url: lookupUrl, allowed: true });
  const lookup = await client.lookup(ticket.id, AbortSignal.timeout(5000));
  run.bindings.lookupId = lookup.id;
  assert.deepEqual(lookup, ticket, 'Lookup differed from the created reservation.');
  assert.equal(lookup.status, contract.expected.status, 'Lookup did not have the expected status.');
  assert.deepEqual(lookup.result, { device: contract.expected.device, category: contract.expected.category },
    'Lookup did not have the expected labels.');
  passed(`Lookup returned the bound ID ${lookup.id}, submitted text, expected status and labels.`);
  if (mode === 'freeze') writeFileSync(join(output, 'contract.json'), JSON.stringify(contract, null, 2) + '\n');
  run.status = 'passed';
} catch (error) {
  run.steps.push({ name: stage, status: 'failed', summary: error.message, evidence: error.evidence ?? [] });
} finally {
  if (run.steps.some((step) => step.name === 'Contract preflight' && step.status === 'passed')) run.steps.push({ name: 'Replay boundary', status: run.network.some(({ allowed }) => !allowed) ? 'failed' : 'passed',
    summary: 'Runner model calls: 0. No model client or model service is started. Browser requests are confined to page/create; Node only looks up the bound ID. Android not tested.', evidence: [] });
  if (run.steps.some(({ status }) => status === 'failed')) run.status = 'failed';
  writeFileSync(join(output, 'report.json'), JSON.stringify(run, null, 2) + '\n');
  writeFileSync(join(output, 'report.html'), renderReport(run));
  for (const step of run.steps) console.log(`${step.status.toUpperCase()}  ${step.name} - ${step.summary}`);
  console.log(`Report: ${join(output, 'report.html')}`);
  process.exitCode = run.status === 'passed' ? 0 : 1;
}
