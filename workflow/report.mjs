const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

export function runStatus(steps) {
  if (steps.some(({ status }) => status === 'failed')) return 'failed';
  if (steps.some(({ status }) => status === 'skipped')) return 'partial';
  return 'passed';
}

export const androidOffSummary = 'Android skipped by request (--android off).';

export function basicDemoSummary({ mode, steps }) {
  const android = steps.find(({ name }) => name === 'Android device');
  if (mode === 'mock' && android?.status === 'skipped' && android.summary === androidOffSummary &&
      steps.every((step) => step === android || step.status === 'passed')) {
    return `Basic demo passed. ${androidOffSummary}`;
  }
  return '';
}

const score = (metric) => metric ? `${metric.passed}/${metric.total}` : 'Not run';
const label = (result) => escape(result ? `${result.device ?? '—'} / ${result.category}` : '—');

export function renderReport(run) {
  const status = runStatus(run.steps);
  const summary = basicDemoSummary(run);
  const external = run.scope === 'external-backend';
  const ticket = `Ticket <code>${escape(run.ticketId ?? 'Not created')}</code>`;
  const scope = external ? `Scope <strong>External backend</strong> · ${ticket}`
    : `Model mode <strong>${escape(run.mode)}</strong> · ${run.scope === 'model-only' ? 'Scope <strong>Model only</strong>' : ticket}`;
  const steps = run.steps.map(({ name, status, summary, evidence }) => `
    <li><span class="badge ${escape(status)}">${escape(status)}</span><div>
      <strong>${escape(name)}</strong><p>${escape(summary)}</p>
      ${(evidence ?? []).map((file) => `<a href="${encodeURIComponent(file)}">${escape(file)}</a>`).join(' ')}
    </div></li>`).join('');

  const rows = (run.evaluation?.rows ?? []).map((row) => `
    <tr><td><code>${escape(row.id)}</code><small>${escape(row.kind)}</small></td>
    <td>${escape(row.text)}</td><td>${label(row.expected)}</td><td>${label(row.actual)}</td>
    <td>${Number.isFinite(row.durationMs) ? `${escape(row.durationMs)} ms` : '—'}</td>
    <td><span class="badge ${row.passed ? 'passed' : 'failed'}">${row.passed ? 'passed' : 'failed'}</span>
    ${row.failureReason ? `<small>${escape(row.failureReason)}</small>` : ''}</td></tr>`).join('');

  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI App Regression — Test Report</title>
<style>
  :root{color-scheme:light;--ink:#17232f;--muted:#4f5f68;--line:#cbd7d6;--paper:#eef3f1;--navy:#142b3b}
  *{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 "Instrument Sans",system-ui,sans-serif}
  header{background:var(--navy);color:#f4faf9;border-bottom:5px solid #54c4b0;padding:36px max(24px,calc((100% - 1040px)/2))}
  h1,h2,p{margin:0}h1{font-size:clamp(28px,5vw,45px);letter-spacing:-.035em;line-height:1.08}
  header p{margin-top:12px;color:#c4ddd9;overflow-wrap:anywhere}main{max-width:1088px;margin:0 auto;padding:24px}
  .demo-summary{margin:0 0 16px;padding:10px 14px;border-left:4px solid #0a5943;background:#e2f6eb;color:#0a5943;font-weight:700}
  dl{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin:0 0 26px;border:1px solid var(--line);background:#fff}
  dl div{padding:14px 18px}dl div+div{border-left:1px solid var(--line)}
  dt{color:var(--muted);font-size:13px}dd{margin:4px 0 0;font-size:20px;font-weight:700}
  h2{font-size:20px;margin-bottom:8px}section{margin-bottom:25px}section>p{margin-bottom:10px;color:var(--muted)}
  ul{list-style:none;padding:0;margin:0;border:1px solid var(--line);background:#fff}
  li{display:grid;grid-template-columns:92px 1fr;gap:10px;padding:12px 14px}li+li{border-top:1px solid var(--line)}
  li p{color:var(--muted);overflow-wrap:anywhere}li a{display:inline-block;margin:3px 8px 0 0;color:#0a526d;overflow-wrap:anywhere}
  .badge{display:inline-block;align-self:start;justify-self:start;border:1px solid currentColor;padding:1px 7px;font-size:11px;font-weight:750;text-transform:uppercase;white-space:nowrap}
  .passed{color:#0a5943;background:#e2f6eb}.failed{color:#9d2331;background:#fff0ee}.partial,.skipped{color:#734207;background:#fff3d8}
  .scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:760px;background:#fff}
  th,td{border:1px solid var(--line);text-align:left;vertical-align:top;padding:8px 10px}th{background:#dce9e6}
  small{display:block;color:var(--muted)}code{font-family:"IBM Plex Mono",Consolas,monospace;font-size:.9em}
  @media(max-width:560px){main{padding:16px}dl{grid-template-columns:1fr}dl div+div{border-left:0;border-top:1px solid var(--line)}}
</style>
<header><h1>AI App Regression</h1>
<p>${escape(run.startedAt)} · ${scope}</p></header>
<main>
  ${summary ? `<p class="demo-summary">${escape(summary)}</p>` : ''}
  <dl aria-label="Results">
    <div><dt>Workflow</dt><dd><span class="badge ${status}">${status}</span></dd></div>
    ${external ? '' : `<div><dt>Accuracy cases</dt><dd>${score(run.evaluation?.accuracy)}</dd></div>
    <div><dt>Robustness variants</dt><dd>${score(run.evaluation?.robustness)}</dd></div>`}
  </dl>
  <section><h2>Checks</h2><ul>${steps}</ul></section>
  ${external ? '' : `<section><h2>Labelled examples</h2>
  <p>${run.mode === 'mock' ? 'Fixed responses exercise the workflow.' : 'Scores describe this labelled sample.'} Robustness requires the original and the changed input to match the label.</p>
  ${rows ? `<div class="scroll"><table><thead><tr><th>Case</th><th>Input</th><th>Expected</th><th>Observed</th><th>Duration</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p>No example results were recorded.</p>'}
  </section>`}
</main>
</html>`;
}
