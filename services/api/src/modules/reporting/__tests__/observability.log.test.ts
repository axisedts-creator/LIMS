// C6-T33 — logger denylist with planted PHI + static log-scan (02-TRD §12 "Logs", 02-CV §9.1/§9.2, 07-SECURITY REQ-SEC-098, 01-PRD §6 "PHI found in any log line: 0").
// 02-TRD §12: "The logger denylist adds the keys otp, code, link_url, url, token, destination, body_text, params, to, action_url, action_json, portalUrl for this module
// (unit test with planted values)."
// ASSUMED API (spec gives none): services/api/src/modules/reporting/observability.ts exports
//   REPORTING_LOG_DENY: readonly string[]  (exactly those 12 keys, as spelled in the TRD)
//   createReportingLogger(opts: LoggerOptions): Logger   (= @lims/shared-ts createLogger + the 12 keys; same (msg, fields) signature and `destination` seam)
// Module keys are matched EXACTLY and case-insensitively (not as substrings): `code` and `to` as substrings would also hide `error_code`, `actor_id`, `tenant_id`... which
// CV §9.1 and 07-SECURITY §"Logging" require to stay visible (`report_id`, `version_no`, `delivery_id`, `link_id`, error codes).
// Log-scan: no log call in the module's non-test source (API + worker) may use a denylisted key, so the redaction is never the only line of defence and error codes go out as `error_code`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPORTING_LOG_DENY, createReportingLogger } from '../observability.js';

const TRD_KEYS = ['otp', 'code', 'link_url', 'url', 'token', 'destination', 'body_text', 'params', 'to', 'action_url', 'action_json', 'portalUrl'];

function capture() {
  const lines: string[] = [];
  const log = createReportingLogger({ service: 'api', env: 'test', version: '0.0.0', level: 'debug', destination: { write: (l: string) => { lines.push(l); } } });
  return { log, lines, text: () => lines.join('\n'), last: () => JSON.parse(lines.at(-1)!) as Record<string, any> };
}

describe('REPORTING_LOG_DENY (02-TRD §12)', () => {
  it('is exactly the 12 keys of the TRD', () => {
    expect([...REPORTING_LOG_DENY].sort()).toEqual([...TRD_KEYS].sort());
  });
});

describe('createReportingLogger — planted values never reach the sink', () => {
  it.each(TRD_KEYS)('key `%s` is redacted at top level, case-insensitively', (k) => {
    const planted = `PLANTED-${k}-9f3a1c`;
    for (const key of [k, k.toUpperCase(), k[0]!.toUpperCase() + k.slice(1)]) {
      const c = capture(); c.log.info('event', { [key]: planted, report_id: 'rep-1' });
      expect(c.text(), key).not.toContain(planted);
      expect(c.last()[key]).toBe('[REDACTED]');
      expect(c.last()['report_id']).toBe('rep-1');
    }
  });
  it('redacts nested in objects and arrays, and does not mutate the caller\'s object', () => {
    const c = capture(); const planted = { otp: 'PLANT-OTP-482913', link_url: 'https://portal.lims.invalid/r/PLANT-LINK-TOKEN', body_text: 'Dear PLANT-PATIENT, your report is ready' };
    const fields = { delivery: { params: { patient_name: 'PLANT-NAME', url: 'https://portal.lims.invalid/r/PLANT-URL' }, to: '+9779800000010' }, list: [planted, { destination: 'PLANT-DEST@example.com' }], action_json: { a: 'PLANT-ACTION' }, action_url: '/x/PLANT-ACT', portalUrl: 'https://portal.lims.invalid/PLANT-PORTAL' };
    const before = JSON.stringify(fields);
    c.log.warn('delivery failed', fields);
    expect(c.text()).not.toMatch(/PLANT-|portal\.lims\.invalid|9800000010|example\.com/);
    expect(JSON.stringify(fields)).toBe(before);
  });
  it('a planted phone number / bearer credential in the message text is scrubbed too (inherits the shared value scrubbers)', () => {
    const c = capture(); c.log.error('send to 9800000010 with Bearer PLANTEDSECRET1 failed', { error_code: 'reporting.render_unavailable' });
    expect(c.text()).not.toMatch(/9800000010|PLANTEDSECRET1/);
  });
  it('keeps the base CV §9.2 denylist (phone, email, authorization ...)', () => {
    const c = capture(); c.log.info('x', { phone: 'PLANT-PH', email: 'PLANT-EM', authorization: 'PLANT-AU' });
    expect(c.text()).not.toContain('PLANT-');
  });
  it('does NOT hide the fields CV §9.1 / 07-SECURITY say to log: error_code, tenant_id, actor_id, report_id, version_no, delivery_id, link_id, duration_ms, status', () => {
    const c = capture(); const f = { error_code: 'reporting.render_unavailable', tenant_id: 'ten-1', actor_id: 'act-1', report_id: 'rep-1', version_no: 3, delivery_id: 'del-1', link_id: 'lnk-1', duration_ms: 12, status: 429, event: 'render_failed' };
    c.log.error('render failed', f);
    for (const [k, v] of Object.entries(f)) expect(c.last()[k], k).toBe(v);
  });
});

// ------------------------------------------------------------------------------------------------ static log-scan
const API_SRC = join(import.meta.dirname, '..');
const WORKER_SRC = join(import.meta.dirname, '../../../../../worker/src/jobs/reporting');
const SENSITIVE = [...TRD_KEYS, 'phone', 'email', 'full_name', 'patient_name', 'registration_no', 'barcode', 'test_name', 'link_token'];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === '__tests__' || n === 'node_modules' ? [] : sources(p);
    return /\.ts$/.test(n) && !/\.(test|spec)\.ts$/.test(n) && !/\.d\.ts$/.test(n) ? [p] : [];
  });
}
/** Text between the parentheses of a call (balanced), string literals blanked unless they are object keys. */
function argsAt(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) { const ch = src[i]; if (ch === '(') depth++; else if (ch === ')' && --depth === 0) return src.slice(open + 1, i); }
  return src.slice(open + 1);
}
const blank = (s: string) => s.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1(?!\s*:)/g, '""');
const CALL = /\b(?:log|logger)\??\.(?:debug|info|warn|error)\??\.?\(/g;

function logCalls() {
  const out: Array<{ file: string; line: number; args: string }> = [];
  for (const file of [...sources(API_SRC), ...sources(WORKER_SRC)]) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(CALL)) out.push({ file, line: src.slice(0, m.index).split('\n').length, args: blank(argsAt(src, m.index! + m[0].length - 1)) });
  }
  return out;
}

describe('log-scan: no log call of the reporting module (API + worker source) carries a denylisted key (02-TRD §12, REQ-SEC-098)', () => {
  const calls = logCalls();
  it('the scan sees the module\'s log calls (not vacuous)', () => { expect(calls.length).toBeGreaterThanOrEqual(20); });
  it('no object key / shorthand property of any log call is a denylisted key (error codes go out as `error_code`)', () => {
    const bad: string[] = [];
    for (const c of calls) for (const k of SENSITIVE) {
      const re = new RegExp(`(?<![\\w.])['"]?${k}['"]?\\s*(?::|(?=\\s*[,}]))`, 'i');
      if (re.test(c.args.replace(/\.\.\.\w+/g, ''))) bad.push(`${c.file.replace(/.*services[\\/]/, '')}:${c.line} key \`${k}\``);
    }
    expect(bad).toEqual([]);
  });
  it('log calls never pass a whole error / payload / request / message object (spread or bare `payload`, `req`, `body`, `msg`)', () => {
    const bad = calls.filter((c) => /(^|[,(\s])(payload|req|request|body|msg|message|input)\s*[,)}]|\.\.\.\s*(payload|req|request|body|input)\b/.test(c.args)).map((c) => `${c.file.replace(/.*services[\\/]/, '')}:${c.line}`);
    expect(bad).toEqual([]);
  });
});
