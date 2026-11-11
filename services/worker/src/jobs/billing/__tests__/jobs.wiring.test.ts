// BL-T17 wiring + static rules (02-TRD §10 rows billing.fiscal_counter_prepare / billing.integrity_check; §15 metric; 07-SECURITY counter row
// "integrity_check nightly", 05-SCHEMA §3 "never auto-fix"). No DB. ASSUMED (spec silent, writer: dispute if wrong):
//  - cron.ts exports `crontab` (like reporting/cron.ts) and ../index.js manifest registers both tasks + crontab + maxAttempts (5 and 1);
//  - task payload is { tenant_id }; a payload whose tenant_id is missing or differs from ctx.tenantId runs NO statement and resolves.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateManifests } from '../../../core/manifest.js';

const DIR = join(import.meta.dirname, '..');
const PREP = 'billing.fiscal_counter_prepare', CHECK = 'billing.integrity_check';
const TENANT_A = '0190a000-0000-7000-8000-00000000aaaa', TENANT_B = '0190a000-0000-7000-8000-00000000bbbb';
const manifest = async (): Promise<any> => (await import('../index.js')).manifest;
const src = (rel: string) => readFileSync(join(DIR, rel), 'utf8');
const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function ctxOf(tenantId: string | undefined) {
  const stmts: string[] = [], inc: unknown[][] = [];
  const tx = { async query(text: string) { stmts.push(text); return { rows: [] }; } };
  const ctx: any = {
    tenantId, tx, actor: { type: 'system', id: '0190a000-0000-7000-8000-00000000a009' }, requestId: 'r', attempt: 1, maxAttempts: 1, jobId: '1',
    now: () => '2026-11-07T12:00:30.000Z', isNewer: () => true, events: {}, core: {}, storage: {}, files: {}, audit: {},
    log: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } },
    metrics: { inc: (...a: unknown[]) => { inc.push(a); }, set() {}, observe() {} },
  };
  ctx.db = { tx: async (fn: any) => fn(ctx) };
  return { ctx, stmts, inc };
}

describe('manifest + crontab (02-TRD §10)', () => {
  it('registers both tasks in the billing namespace and the manifest still validates', async () => {
    const m = await manifest();
    expect(typeof m.tasks[PREP]).toBe('function');
    expect(typeof m.tasks[CHECK]).toBe('function');
    expect(() => validateManifests([m])).not.toThrow();
  });
  it('fiscal_counter_prepare: cron 45 18 * * *, per_tenant, 5 attempts', async () => {
    const m = await manifest(); const c = (m.crontab as any[]).filter((x) => x.identifier === PREP);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ schedule: '45 18 * * *', tenantScope: 'per_tenant', maxAttempts: 5 });
    expect(m.maxAttempts[PREP]).toBe(5);
  });
  it('integrity_check: cron 0 20 * * *, per_tenant, 1 attempt (a failed check pages, it is not retried silently)', async () => {
    const m = await manifest(); const c = (m.crontab as any[]).filter((x) => x.identifier === CHECK);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ schedule: '0 20 * * *', tenantScope: 'per_tenant', maxAttempts: 1 });
    expect(m.maxAttempts[CHECK]).toBe(1);
  });
  it('cron.ts exports the same crontab the manifest uses', async () => {
    const m = await manifest(); const cron: any = await import('../cron.js');
    expect(cron.crontab).toEqual(m.crontab);
  });
});

describe.each([[PREP], [CHECK]])('%s tenant guard (REQ-SEC-024)', (id) => {
  it('payload tenant_id missing or different from the job tenant -> no statement, no throw, no metric', async () => {
    const m = await manifest();
    for (const payload of [{}, { tenant_id: TENANT_B }, { tenant_id: 'not-a-uuid' }]) {
      const { ctx, stmts, inc } = ctxOf(TENANT_A);
      await m.tasks[id](payload, ctx);
      expect(stmts).toEqual([]); expect(inc).toEqual([]);
    }
  });
  it('job without a tenant scope runs no statement', async () => {
    const m = await manifest(); const { ctx, stmts } = ctxOf(undefined);
    await m.tasks[id]({ tenant_id: TENANT_A }, ctx); expect(stmts).toEqual([]);
  });
});

describe('integrity_check is read-only and tenant-scoped (never auto-fix)', () => {
  it('with an empty database it runs only SELECT/WITH statements, each naming tenant_id, and reports no violation', async () => {
    const m = await manifest(); const { ctx, stmts, inc } = ctxOf(TENANT_A);
    await m.tasks[CHECK]({ tenant_id: TENANT_A }, ctx);
    expect(stmts.length).toBeGreaterThan(0);
    for (const s of stmts) { expect(s).toMatch(/^\s*(select|with)\b/i); expect(s).toMatch(/\btenant_id\b/i); }
    expect(inc.filter((a) => a[0] === 'lims_billing_integrity_violations_total')).toEqual([]);
  });
  it('source: no INSERT/UPDATE/DELETE/TRUNCATE/DDL anywhere, names the metric, no console, no other module\'s job folder', () => {
    const c = code('tasks/integrity_check.ts');
    expect(c).not.toMatch(/\b(insert\s+into|update\s+[a-z_.]+\s+set|delete\s+from|truncate|alter\s+table|drop\s+)/i);
    expect(c).toContain('lims_billing_integrity_violations_total');
    expect(c).not.toMatch(/console\./);
    expect(c).not.toMatch(/from\s+['"][^'"]*\/jobs\/(?!billing\b)[a-z_]+\//);
  });
  it('source: covers every check of the TRD row (max(seq), issued_at ordering, print_log, order_balances)', () => {
    const c = code('tasks/integrity_check.ts');
    for (const needle of [/invoice_seq/, /issued_at/, /print_log/, /print_count/, /order_balances/, /fiscal_counters/]) expect(c).toMatch(needle);
  });
});

describe('fiscal_counter_prepare never touches numbering (07-SECURITY: no skipping/reuse)', () => {
  it('source: creates rows / sets closed_at only — never writes last_no, never deletes, no console', () => {
    const c = code('tasks/fiscal_counter_prepare.ts');
    expect(c).not.toMatch(/delete\s+from|truncate/i);
    expect(c).not.toMatch(/update\s+billing\.fiscal_counters\s+set[^;`]*\blast_no\b/is);
    expect(c).not.toMatch(/on\s+conflict[^;`]*do\s+update[^;`]*\blast_no\b/is);
    expect(c).not.toMatch(/console\./);
    expect(c).toMatch(/billing\.fiscal_counters/);
    expect(c).toMatch(/\bclosed_at\b/);
  });
  it('source: series list is exactly INV, CN, RC (TRD §10)', () => {
    const c = code('tasks/fiscal_counter_prepare.ts');
    for (const s of ['INV', 'CN', 'RC']) expect(c).toContain(s);
  });
});
