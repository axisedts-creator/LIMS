// AN-T22 (C8) - metrics emitted by the tasks + log PHI-scan (02-TRD §13 Logs/Metrics; 07-SECURITY §6 "PHI and logging rules", E4).
// ASSUMED (TRD §13): a refresh of one family emits ctx.metrics.observe('lims_analytics_refresh_duration_seconds', seconds, { family }) and
//   ctx.log.info({ event: 'analytics_refresh_run', tenant_id, family, from, to, rows_written, duration_ms, outcome, run_id });
//   a failing family emits ctx.metrics.inc('lims_analytics_refresh_failures_total', { family }) and
//   ctx.log.<level>({ event: 'analytics_refresh_failed', tenant_id, family, error_code, attempt }) and still rethrows (Graphile retries).
//   error_code is the SQLSTATE / typed code, NEVER error.message (a DB message can echo row values).
// Log objects carry ONLY the field names of the TRD table (snake_case) and only the TRD event keys; this is also scanned statically over the C8 sources.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../../../api/src/core/module.js';
import { createCtx, createFakeDb } from '../../../../../api/src/modules/analytics/service/__tests__/refreshFake.js';
import { refreshTenantTask } from '../tasks/refresh_tenant.js';
import { selfCheckTask } from '../tasks/self_check.js';
import { createWorld } from './tasksFake.js';

const TA = '01a1a98a-ac40-7000-8000-00000000a001';
const FIELDS: Record<string, string[]> = {
  analytics_refresh_run: ['tenant_id', 'family', 'from', 'to', 'rows_written', 'duration_ms', 'outcome', 'run_id'],
  analytics_refresh_failed: ['tenant_id', 'family', 'error_code', 'attempt'],
  reconciliation_mismatch: ['tenant_id', 'rule', 'family', 'business_date', 'diff_paisa'],
  analytics_export_requested: ['tenant_id', 'export_id', 'report_code', 'format', 'rows', 'size_bytes', 'failure_code'],
  analytics_export_built: ['tenant_id', 'export_id', 'report_code', 'format', 'rows', 'size_bytes', 'failure_code'],
  analytics_export_downloaded: ['tenant_id', 'export_id', 'report_code', 'format', 'rows', 'size_bytes', 'failure_code'],
  analytics_export_failed: ['tenant_id', 'export_id', 'report_code', 'format', 'rows', 'size_bytes', 'failure_code'],
  analytics_schedule_dispatched: ['tenant_id', 'schedule_id', 'run_id', 'recipients_sent', 'recipients_skipped'],
};
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const PHI = [/[\w.+-]+@[\w-]+\.[\w.]+/, /\+?\d[\d\s-]{6,}\d/, /\bSita\b|\bRai\b/i, /:\/\/|\bwww\./i];

/** Every string leaf of a log record, uuids and ISO dates removed (those are the allowed ids/dates). */
function leaves(o: unknown, out: string[] = []): string[] {
  if (typeof o === 'string') out.push(o.replace(UUID, '').replace(/\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?/g, ''));
  else if (o && typeof o === 'object') for (const v of Object.values(o)) leaves(v, out);
  return out;
}
function scan(records: any[]): void {
  expect(records.length).toBeGreaterThan(0);
  for (const r of records) {
    const rec = r?.event ? r : {};
    expect(Object.keys(FIELDS), `event ${rec.event}`).toContain(rec.event);
    const extra = Object.keys(rec).filter((k) => k !== 'event' && k !== 'msg' && !FIELDS[rec.event]!.includes(k));
    expect(extra, `${rec.event} has fields outside TRD §13`).toEqual([]);
    for (const s of leaves(rec)) for (const re of PHI) expect(s, `${rec.event} leaks ${re}`).not.toMatch(re);
  }
}
function recorder() {
  const logs: any[] = [], metrics: { kind: string; name: string; value?: number; labels: Record<string, unknown> }[] = [];
  const lg = (x: unknown) => { logs.push(x); };
  return {
    logs, metrics,
    log: { info: lg, warn: lg, error: lg, debug() {} },
    m: {
      inc: (name: string, labels: Record<string, unknown> = {}) => { metrics.push({ kind: 'inc', name, labels }); },
      set: (name: string, value: number, labels: Record<string, unknown> = {}) => { metrics.push({ kind: 'set', name, value, labels }); },
      observe: (name: string, value: number, labels: Record<string, unknown> = {}) => { metrics.push({ kind: 'observe', name, value, labels }); },
    },
  };
}
const boom = Object.assign(new Error('relation failed for patient Sita Rai 9841000000'), { code: '57014' });   // synthetic PHI in the message

describe('refresh_tenant observability', () => {
  it('a refreshed family observes the duration histogram {family} and logs analytics_refresh_run (ids, family, dates, counts, outcome)', async () => {
    const f = createFakeDb({ marks: [{ tenant: TA, family: 'income', date: '2026-11-01' }] });
    const r = recorder(); const ctx = { ...createCtx(f, { tenantId: TA }), log: r.log, metrics: r.m };
    await refreshTenantTask({ tenant_id: TA }, ctx as never);
    const d = r.metrics.filter((m) => m.name === 'lims_analytics_refresh_duration_seconds');
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ kind: 'observe', labels: { family: 'income' } });
    expect(Object.keys(d[0]!.labels)).toEqual(['family']);
    expect(d[0]!.value).toBeGreaterThanOrEqual(0);
    expect(r.metrics.filter((m) => m.name === 'lims_analytics_refresh_failures_total')).toEqual([]);
    const run = r.logs.filter((l) => l?.event === 'analytics_refresh_run');
    expect(run).toHaveLength(1);
    expect(run[0]).toMatchObject({ tenant_id: TA, family: 'income' });
    expect(run[0].outcome).toBeTruthy();
    scan(r.logs);
  });

  it('a failing family increments refresh_failures_total {family}, logs analytics_refresh_failed with the SQLSTATE (never the message) and still rethrows', async () => {
    const f = createFakeDb({ marks: [{ tenant: TA, family: 'income', date: '2026-11-01' }], hook: (a) => { if (a.kind === 'insertRollup') throw boom; } });
    const r = recorder(); const ctx = { ...createCtx(f, { tenantId: TA }), log: r.log, metrics: r.m };
    await expect(refreshTenantTask({ tenant_id: TA }, ctx as never)).rejects.toBeTruthy();
    const fl = r.metrics.filter((m) => m.name === 'lims_analytics_refresh_failures_total');
    expect(fl).toHaveLength(1);
    expect(fl[0]).toMatchObject({ kind: 'inc', labels: { family: 'income' } });
    const l = r.logs.filter((x) => x?.event === 'analytics_refresh_failed');
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ tenant_id: TA, family: 'income', error_code: '57014' });
    expect(JSON.stringify(r.logs)).not.toMatch(/Sita|9841000000|patient/i);
    scan(r.logs);
  });
});

describe('self_check observability', () => {
  it('a mismatch logs reconciliation_mismatch with TRD fields only and counts it once with { rule, family }', async () => {
    const w = createWorld({ now: '2026-11-08T21:00:00.000Z' });
    w.mismatches.set('R3|income', ['2026-11-05']);
    await selfCheckTask({ tenant_id: TA } as never, w.ctx);
    expect(w.metrics.filter((m) => m.name === 'lims_analytics_reconciliation_mismatch_total')).toEqual([{ name: 'lims_analytics_reconciliation_mismatch_total', labels: { rule: 'R3', family: 'income' } }]);
    scan(w.logs.length ? w.logs : w.warns);
  });
});

describe('log PHI-scan over the C8 sources (static)', () => {
  const roots = [join(REPO_ROOT, 'services', 'worker', 'src', 'jobs', 'analytics'), join(REPO_ROOT, 'services', 'api', 'src', 'modules', 'analytics')];
  const files = (d: string): string[] => readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    if (n === '__tests__' || n === 'node_modules') return [];
    return statSync(p).isDirectory() ? files(p) : /\.ts$/.test(n) && !/\.test\.ts$/.test(n) ? [p] : [];
  });

  it('every `event:` key a C8 source logs is a TRD §13 event key', () => {
    const seen = new Set<string>();
    for (const f of roots.flatMap(files)) for (const m of readFileSync(f, 'utf8').matchAll(/\bctx\.log\.(?:info|warn|error|debug)\(\s*\{[^}]*?\bevent:\s*'([a-z_]+)'/g)) seen.add(m[1]!);
    expect(seen.size).toBeGreaterThan(0);
    expect([...seen].filter((e) => !(e in FIELDS))).toEqual([]);
  });

  it('no C8 log call interpolates an error message, a name, an e-mail or a URL (ctx.log.*(... err.message | .name | .email | url ...))', () => {
    const bad: string[] = [];
    for (const f of roots.flatMap(files)) for (const m of readFileSync(f, 'utf8').matchAll(/\bctx\.log\.(?:info|warn|error|debug)\([^;]*\)/g)) {
      if (/\b(?:e|err|error)\.message\b|\b(?:patient|referrer|doctor|staff|schedule)_?name\b|\bemail\b|\burl\b|https?:\/\//i.test(m[0])) bad.push(`${f.slice(REPO_ROOT.length)}: ${m[0].slice(0, 90)}`);
    }
    expect(bad).toEqual([]);
  });
});
