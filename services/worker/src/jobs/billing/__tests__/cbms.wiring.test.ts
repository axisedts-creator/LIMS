// BL-T14 worker wiring + static rules for billing.cbms_sync and billing.cbms_sweep (02-TRD §9, §10 table rows: cbms_sync = outbox, tenant, 10 attempts; cbms_sweep = cron `*/15 * * * *`,
// per_tenant, 3 attempts, "invoices, invoice cancellations, credit notes"; PRD US-BL-13.2; 07-SECURITY REQ-SEC-024 tenant guard). No DB (behaviour against a DB is in cbms.live.test.ts).
// ASSUMED (spec silent; writer: dispute if wrong):
//   tasks/cbms_sync.ts   exports CBMS_SYNC = 'billing.cbms_sync', `cbmsSync` (default: RecordingStubCbmsClient, mode from LIMS_BILLING_CBMS_MODE which config.ts already restricts to stub) and
//                        `createCbmsSync({ client })` (the test seam: the integration tests inject a client returning each outcome). Payload { tenant_id, document_kind, document_id }.
//   tasks/cbms_sweep.ts  exports CBMS_SWEEP = 'billing.cbms_sweep' and `cbmsSweep`; payload { tenant_id }. It only READS documents and enqueues `billing.cbms_sync` through app.enqueue_job
//                        (job_key `cbms:<kind>:<id>`); it never writes a document or cbms_submissions row.
//   A payload whose tenant_id is missing / differs from ctx.tenantId, a document_kind outside the three kinds, or a document_id that is not a uuid runs NO statement and calls no client; it resolves
//   (same rule as BL-T13/T17 tasks). All statements go through ctx.tx.
//   alerts: services/worker/src/jobs/billing/alerts/cbms.rules.yaml (Prometheus rule-file format, same as jobs/instruments/alerts/instruments.rules.yml; TRD §"Alert rules for C1" paths).
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateManifests } from '../../../core/manifest.js';

const DIR = join(import.meta.dirname, '..');
const SYNC = 'billing.cbms_sync', SWEEP = 'billing.cbms_sweep';
const TENANT_A = '0190a000-0000-7000-8000-00000000aaaa', TENANT_B = '0190a000-0000-7000-8000-00000000bbbb';
const DOC_ID = '0190a000-0000-7000-8000-00000000d001';
const manifest = async (): Promise<any> => (await import('../index.js')).manifest;
const code = (rel: string) => readFileSync(join(DIR, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function ctxOf(tenantId: string | undefined, gaugeRow?: Record<string, number>) {
  const stmts: Array<{ text: string; values: unknown[] }> = [];
  const metrics: Array<{ kind: string; name: string; labels: any; value?: number }> = [];
  const tx = { async query(text: string, values: unknown[] = []) {
    stmts.push({ text, values });
    return gaugeRow && /stale_1h/.test(text) ? { rows: [gaugeRow], rowCount: 1 } : { rows: [], rowCount: 0 };
  } };
  const ctx: any = {
    tenantId, tx, actor: { type: 'system', id: '0190a000-0000-7000-8000-00000000a009' }, requestId: 'r', attempt: 1, maxAttempts: 10, jobId: '1',
    now: () => '2026-11-08T12:00:30.000Z', isNewer: () => true, events: {}, core: {}, storage: {}, files: {}, audit: {},
    log: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } },
    metrics: { inc: (name: string, labels: unknown) => metrics.push({ kind: 'inc', name, labels }), set: (name: string, value: number, labels: unknown) => metrics.push({ kind: 'set', name, value, labels }), observe() {} },
  };
  ctx.db = { tx: async (fn: any) => fn(ctx) };
  return { ctx, stmts, metrics };
}
const throwingClient = () => { const calls: unknown[] = []; return { calls, mode: 'live' as const, async submit(i: unknown) { calls.push(i); return { outcome: 'accepted' as const }; } }; };

describe('manifest + crontab (02-TRD §10)', () => {
  it('registers both tasks as functions and the manifest still validates', async () => {
    const m = await manifest();
    expect(typeof m.tasks[SYNC]).toBe('function'); expect(typeof m.tasks[SWEEP]).toBe('function');
    expect(() => validateManifests([m])).not.toThrow();
  });
  it('cbms_sync: maxAttempts 10 and NOT a cron task (outbox); cbms_sweep: cron `*/15 * * * *`, per_tenant, maxAttempts 3', async () => {
    const m = await manifest(); const cron = m.crontab as any[];
    expect(m.maxAttempts[SYNC]).toBe(10); expect(m.maxAttempts[SWEEP]).toBe(3);
    expect(cron.filter((c) => c.identifier === SYNC)).toEqual([]);
    expect(cron.filter((c) => c.identifier === SWEEP)).toEqual([expect.objectContaining({ schedule: '*/15 * * * *', tenantScope: 'per_tenant', maxAttempts: 3 })]);
  });
  it('cron.ts exports the crontab the manifest uses; BL-T13/T17 tasks and cron entries are still there', async () => {
    const m = await manifest(); const cron: any = await import('../cron.js');
    expect(cron.crontab).toEqual(m.crontab);
    expect(Object.keys(m.tasks)).toEqual(expect.arrayContaining(['billing.fiscal_counter_prepare', 'billing.credit_days_check', 'billing.integrity_check', 'billing.export_tenant', SYNC, SWEEP]));
    expect((m.crontab as any[]).map((c) => c.identifier)).toEqual(expect.arrayContaining(['billing.fiscal_counter_prepare', 'billing.credit_days_check', 'billing.integrity_check', SWEEP]));
  });
  it('task modules export their identifier constants and the sync factory', async () => {
    const s: any = await import('../tasks/cbms_sync.js'), w: any = await import('../tasks/cbms_sweep.js');
    expect(s.CBMS_SYNC).toBe(SYNC); expect(w.CBMS_SWEEP).toBe(SWEEP);
    expect(typeof s.createCbmsSync).toBe('function'); expect(typeof s.cbmsSync).toBe('function'); expect(typeof w.cbmsSweep).toBe('function');
  });
});

describe('tenant guard and payload validation (REQ-SEC-024): no statement, no client call', () => {
  const GOOD = { tenant_id: TENANT_A, document_kind: 'invoice', document_id: DOC_ID };
  const BAD: Array<[string, unknown]> = [
    ['no payload', undefined], ['empty', {}], ['other tenant', { ...GOOD, tenant_id: TENANT_B }], ['tenant not a uuid', { ...GOOD, tenant_id: 'x' }],
    ['kind unknown', { ...GOOD, document_kind: 'receipt' }], ['kind missing', { tenant_id: TENANT_A, document_id: DOC_ID }], ['kind injection', { ...GOOD, document_kind: "invoice'; DROP TABLE billing.invoices;--" }],
    ['id not a uuid', { ...GOOD, document_id: '1 OR 1=1' }], ['id missing', { tenant_id: TENANT_A, document_kind: 'invoice' }],
  ];
  for (const [label, payload] of BAD) {
    it(`cbms_sync: ${label}`, async () => {
      const { createCbmsSync } = (await import('../tasks/cbms_sync.js')) as any; const client = throwingClient(); const { ctx, stmts } = ctxOf(TENANT_A);
      await createCbmsSync({ client })(payload, ctx);
      expect(stmts).toEqual([]); expect(client.calls).toEqual([]);
    });
  }
  it('cbms_sync: a job without a tenant scope runs nothing', async () => {
    const { createCbmsSync } = (await import('../tasks/cbms_sync.js')) as any; const client = throwingClient(); const { ctx, stmts } = ctxOf(undefined);
    await createCbmsSync({ client })(GOOD, ctx); expect(stmts).toEqual([]); expect(client.calls).toEqual([]);
  });
  for (const [label, payload] of [['missing', {}], ['other tenant', { tenant_id: TENANT_B }], ['not a uuid', { tenant_id: 'x' }]] as Array<[string, unknown]>) {
    it(`cbms_sweep: tenant_id ${label} -> no statement`, async () => {
      const m = await manifest(); const { ctx, stmts } = ctxOf(TENANT_A);
      await m.tasks[SWEEP](payload, ctx); expect(stmts).toEqual([]);
    });
  }
});

describe('what the tasks do against an EMPTY database', () => {
  it('cbms_sync: unknown document -> the client is never called, the task resolves, every statement is tenant-bound', async () => {
    const { createCbmsSync } = (await import('../tasks/cbms_sync.js')) as any; const client = throwingClient(); const { ctx, stmts } = ctxOf(TENANT_A);
    await createCbmsSync({ client })({ tenant_id: TENANT_A, document_kind: 'credit_note', document_id: DOC_ID }, ctx);
    expect(client.calls).toEqual([]);
    for (const s of stmts) { expect(s.text).toMatch(/\btenant_id\b/i); expect(s.values).toContain(TENANT_A); }
  });
  it('cbms_sweep: nothing due -> resolves, enqueues nothing, never writes a document (statements are SELECTs only), every statement is tenant-bound', async () => {
    const m = await manifest(); const { ctx, stmts } = ctxOf(TENANT_A);
    await m.tasks[SWEEP]({ tenant_id: TENANT_A }, ctx);
    expect(stmts.length).toBeGreaterThan(0);
    for (const s of stmts) {
      expect(s.text).toMatch(/\btenant_id\b/i); expect(s.values).toContain(TENANT_A);
      expect(s.text, 'sweep must not write documents or submissions').not.toMatch(/\b(UPDATE|DELETE|INSERT|TRUNCATE)\b/i);
      expect(s.text).not.toMatch(/app\.enqueue_job/); // nothing due -> nothing enqueued
    }
  });
});

describe('stale_1h gauge feeds the page alert (TRD §"Alert rules for C1": live mode only; age from the document, not the last attempt)', () => {
  const ROW = { pending: 1, stale_1h: 1, attempts_10_plus: 0 }; // what the DB would say for a doc older than 1 h
  const stale = async (mode: string | undefined) => {
    const prev = process.env['LIMS_BILLING_CBMS_MODE'];
    if (mode === undefined) delete process.env['LIMS_BILLING_CBMS_MODE']; else process.env['LIMS_BILLING_CBMS_MODE'] = mode;
    try {
      const m = await manifest(); const { ctx, metrics, stmts } = ctxOf(TENANT_A, ROW);
      await m.tasks[SWEEP]({ tenant_id: TENANT_A }, ctx);
      const g = metrics.filter((x) => x.kind === 'set' && x.name === 'lims_billing_cbms_pending_documents');
      return { value: g.find((x) => x.labels?.state === 'stale_1h')?.value, pending: g.find((x) => x.labels?.state === 'pending')?.value, stmts };
    } finally { if (prev === undefined) delete process.env['LIMS_BILLING_CBMS_MODE']; else process.env['LIMS_BILLING_CBMS_MODE'] = prev; }
  };
  it('stub mode (also the default): stale_1h is 0 even with a pending document older than 1 h; pending stays truthful', async () => {
    for (const mode of ['stub', undefined]) { const r = await stale(mode); expect(r.value, String(mode)).toBe(0); expect(r.pending, String(mode)).toBe(1); }
  });
  it('live mode: stale_1h carries the count', async () => { expect((await stale('live')).value).toBe(1); });
  it('stale_1h ages the document from created_at / cancelled_at, never from the last attempt (a retry 5 min ago must not hide a 2 h old document)', async () => {
    const { stmts } = await stale('live');
    const g = stmts.find((s) => /stale_1h/.test(s.text))!; expect(g, 'gauge statement').toBeTruthy();
    const filter = /FILTER\s*\(\s*WHERE((?:(?!FILTER).)*?)\)\s*AS\s+stale_1h/is.exec(g.text)?.[1] ?? '';
    expect(filter, 'stale_1h FILTER clause').not.toBe('');
    expect(filter).not.toMatch(/last_attempt_at/i);
    expect(g.text).toMatch(/i\.created_at/); expect(g.text).toMatch(/n\.created_at/); expect(g.text).toMatch(/i\.cancelled_at/);
  });
});

describe('static rules', () => {
  it('cbms_sweep covers all three document kinds on the right columns (invoice cbms_*, invoice_cancellation cbms_cancel_*, credit_note cbms_*) and uses the TRD job key', () => {
    const c = code('tasks/cbms_sweep.ts');
    for (const w of ['billing.invoices', 'billing.credit_notes', 'cbms_cancel_state', 'cbms_cancel_last_attempt_at', 'cbms_last_attempt_at', 'invoice_cancellation', 'credit_note', 'app.enqueue_job', 'billing.cbms_sync', 'cbms:']) expect(c, w).toContain(w);
    expect(c).toMatch(/'pending'|"pending"/);
  });
  it('cbms_sync delegates to the service (no CBMS wire detail, no SQL against document tables, no network)', () => {
    const c = code('tasks/cbms_sync.ts');
    expect(c).toMatch(/cbms\.service/);
    expect(c).not.toMatch(/\bfetch\s*\(|node:(http|https|net|tls)|process\.env\.LIMS_BILLING_CBMS_(URL|KEY|TOKEN)|UPDATE\s+billing\./i);
  });
  it('neither task logs the payload, the document or error messages verbatim, and neither uses console', () => {
    for (const f of ['tasks/cbms_sync.ts', 'tasks/cbms_sweep.ts']) {
      const c = code(f);
      expect(c, f).not.toMatch(/console\./);
      expect(c, f).not.toMatch(/log\??\.(info|warn|error|debug)\??\.?\([^)]*(payload\b|\.message|String\(e|JSON\.stringify)/);
    }
  });
  it('cbms_sync never writes state "synced" itself (only the service maps an accepted outcome)', () => {
    expect(code('tasks/cbms_sync.ts')).not.toMatch(/['"]synced['"]/);
    expect(code('tasks/cbms_sweep.ts')).not.toMatch(/\bSET\b[^;]*['"]synced['"]/i);
  });
});

describe('alert rules (02-TRD §"Alert rules for C1": CBMS pending > 1 h = page; attempts >= 10 and pending = warn)', () => {
  const file = join(DIR, 'alerts', 'cbms.rules.yaml'); // TRD §"Alert rules for C1": C4 path is alerts/*.yaml (a .yml file is missed by that glob)
  const { parse } = createRequire(join(DIR, '../../../../api/package.json'))('yaml') as { parse(s: string): any };
  const rules = (): any[] => (existsSync(file) ? parse(readFileSync(file, 'utf8')).groups.flatMap((g: any) => g.rules) : []);
  it('the rule file exists and is a Prometheus rule file (groups -> rules with alert/expr/labels.severity)', () => {
    expect(existsSync(file), file).toBe(true);
    const r = rules(); expect(r.length).toBeGreaterThanOrEqual(2);
    for (const x of r) { expect(typeof x.alert).toBe('string'); expect(typeof x.expr).toBe('string'); expect(['page', 'warn']).toContain(x.labels?.severity); }
  });
  it('one page rule on lims_billing_cbms_pending_documents (documents stuck pending), one warn rule for documents at 10+ attempts', () => {
    const r = rules(); const text = (x: any) => `${x.alert} ${x.expr} ${JSON.stringify(x.annotations ?? {})}`;
    const page = r.find((x) => x.labels?.severity === 'page'), warn = r.find((x) => x.labels?.severity === 'warn');
    expect(page && /lims_billing_cbms_pending_documents/.test(String(page.expr)), 'page rule expr').toBe(true);
    expect(warn && /cbms/i.test(text(warn)) && /\b10\b/.test(text(warn)), 'warn rule mentions cbms and the 10-attempt threshold').toBe(true);
  });
});
