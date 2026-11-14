// C13 T22 — ST13 log-scan (07-SECURITY §5 + §6 ST13; US-15.4, REQ-SEC-098). Static, independent of the code's own behaviour: every logging / metric call in the partners API module and the
// partners worker jobs is extracted from the source and must not mention a PHI / secret identifier. Allowed in logs: UUIDs, state names, error codes, counts, durations (§5).
// The run-time half (planted synthetic PHI through the handlers, logs captured) lives in the per-task suites (tracking-api, access-slip, conversion, ...); this scan is the net under all of them,
// including code paths those suites never drive. Also scans for console.* and for string-concatenated SQL carrying request values.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../../core/module.js';

const ROOTS = [join(REPO_ROOT, 'services', 'api', 'src', 'modules', 'partners'), join(REPO_ROOT, 'services', 'worker', 'src', 'jobs', 'partners')];
function sources(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === '__tests__' || n === 'node_modules') continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.ts$/.test(n) && !/\.test\.ts$/.test(n)) out.push(p);
  }
  return out;
}
const FILES = ROOTS.flatMap((r) => sources(r));
const read = (f: string) => readFileSync(f, 'utf8');

/** the text of every call `<callee>(...)` (balanced parentheses, string-aware) */
function calls(src: string, callee: RegExp): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = [];
  const re = new RegExp(callee.source, 'g');
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let i = m.index + m[0].length, depth = 1, q = '';
    const start = i;
    for (; i < src.length && depth > 0; i++) {
      const c = src[i]!;
      if (q) { if (c === '\\') i++; else if (c === q) q = ''; continue; }
      if (c === '"' || c === "'" || c === '`') q = c;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
    }
    out.push({ text: src.slice(start, i - 1), line: src.slice(0, m.index).split('\n').length });
  }
  return out;
}
// the code base writes `ctx.log.error(` and `ctx.metrics?.inc?.(` (optional chaining), so both spellings are matched
const LOG_CALL = /\b(?:log|logger)\??\.(?:info|warn|error|debug|trace|fatal)\??\.?\s*\(/;
const METRIC_CALL = /\bmetrics\??\.(?:inc|observe|set)\??\.?\s*\(/;
/** PHI / lab identifiers / secrets that must never be a logged value or a metric label (07-SECURITY §5). Matches property names and identifiers, not string prose. */
const FORBIDDEN = /\b(patient_full_name|patientName|patient_name|full_name|fullName|patient_birth_on|birth_on|patient_phone|phone_e164|contact_phone|contact_email|contact_name|email|partner_sample_ref|sampleRef|registration_no|registrationNo|manifest_no|manifestNo|clinical_note|clinicalNote|consent_\w+|orderables_snapshot|panel_names|portalUrl|portal_url|signedUrl|signed_url|slip_url|accessUrl|downloadUrl|token|jwt|password|secret|authorization|cookie|body|query\.q|\bq)\b/;

describe('ST13 static log-scan over the partners API module and worker jobs', () => {
  it('finds the source (guard is not vacuous)', () => {
    expect(FILES.length).toBeGreaterThan(40);
    expect(FILES.some((f) => /access-slip/.test(f)) && FILES.some((f) => /worker/.test(f))).toBe(true);
  });

  it('the scanner sees the real log / metric calls (a regex that matches nothing would pass every test below)', () => {
    expect(FILES.flatMap((f) => calls(read(f), LOG_CALL)).length).toBeGreaterThanOrEqual(1);
    expect(FILES.flatMap((f) => calls(read(f), METRIC_CALL)).length).toBeGreaterThanOrEqual(5);
  });

  it('self-check: the scanner flags planted offenders (so a green run means something)', () => {
    const planted = "ctx.log?.warn?.({ patient_full_name: row.patient_full_name });\nctx.metrics?.inc?.('x', { registration_no: r });\nconsole.log('x');\nctx.log.info({ a: 1, ...req })";
    expect(calls(planted, LOG_CALL).filter((c) => FORBIDDEN.test(c.text))).toHaveLength(1);
    expect(calls(planted, METRIC_CALL).filter((c) => FORBIDDEN.test(c.text))).toHaveLength(1);
    expect(calls(planted, /\bconsole\.log\s*\(/)).toHaveLength(1);
    expect(calls(planted, LOG_CALL).some((c) => /\.\.\.\s*req\b/.test(c.text))).toBe(true);
  });

  it('no console.* anywhere (ctx.log only, so redaction and the allow-list apply)', () => {
    const bad = FILES.flatMap((f) => calls(read(f), /\bconsole\.(?:log|info|warn|error|debug|trace|dir)\s*\(/).map((c) => `${f}:${c.line}`));
    expect(bad).toEqual([]);
  });

  it('no log call mentions a PHI / secret field (ids, states, codes, counts, durations only)', () => {
    const bad = FILES.flatMap((f) => calls(read(f), LOG_CALL).filter((c) => FORBIDDEN.test(c.text.replace(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, (s) => (/^["'`][a-z_.]+["'`]$/.test(s) ? s : '""')))).map((c) => `${f}:${c.line}: ${c.text.replace(/\s+/g, ' ').slice(0, 120)}`));
    expect(bad).toEqual([]);
  });

  it('no metric name or label is built from a PHI / secret field', () => {
    const bad = FILES.flatMap((f) => calls(read(f), METRIC_CALL).filter((c) => FORBIDDEN.test(c.text)).map((c) => `${f}:${c.line}: ${c.text.replace(/\s+/g, ' ').slice(0, 120)}`));
    expect(bad).toEqual([]);
  });

  it('log calls never spread or stringify a whole request / row / error object (they leak whatever the object holds)', () => {
    const risky = /(\.\.\.\s*(?:req|request|row|line|body|input|payload|e|err|error)\b|JSON\.stringify\s*\(\s*(?:req|request|row|line|body|input|payload|err|error|e)\b|\{\s*(?:req|request|row|line|body|input|payload|err|error)\s*[,}])/;
    const bad = FILES.flatMap((f) => calls(read(f), LOG_CALL).filter((c) => risky.test(c.text)).map((c) => `${f}:${c.line}: ${c.text.replace(/\s+/g, ' ').slice(0, 120)}`));
    expect(bad).toEqual([]);
  });

  it('SQL text is never built from a request value: no template-literal / concatenated values in query() calls (values are bound; ST13 "SQL text" leg)', () => {
    const bad = FILES.flatMap((f) => calls(read(f), /\.query\s*\(/).filter((c) => /^\s*`[^`]*\$\{/.test(c.text) && /\b(select|insert|update|delete)\b/i.test(c.text) && /\$\{\s*(?:req|request|body|query|params|input|v\.|data)\b/.test(c.text))
      .map((c) => `${f}:${c.line}: ${c.text.replace(/\s+/g, ' ').slice(0, 120)}`));
    expect(bad).toEqual([]);
  });

  it('the access-slip link (portalUrl / token) is only ever mentioned in the worker slip task, the RenderPort call and the slip service comments, never in an API handler body', () => {
    const offenders = FILES.filter((f) => /services[\\/]api[\\/]/.test(f) && /\.(handlers|handler)\b|[\\/]handlers[\\/]/.test(f)).filter((f) => /\b(portalUrl|portal_url|issuePortalLink)\b/.test(read(f).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')));
    expect(offenders).toEqual([]);
    const svc = FILES.filter((f) => /services[\\/]api[\\/]/.test(f)).filter((f) => /\bissuePortalLink\b/.test(read(f).replace(/\/\/.*$/gm, '')));
    expect(svc, 'R4 under partner claims makes no ReportingPort.issuePortalLink call (08 A2.1)').toEqual([]);
  });
});
