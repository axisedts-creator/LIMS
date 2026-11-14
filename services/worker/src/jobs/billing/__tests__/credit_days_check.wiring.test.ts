// BL-T13 billing.credit_days_check wiring + static rules (02-TRD §10 row: cron `0 19 * * *` (00:45 NPT), per_tenant, 3 attempts, "lock credit accounts whose oldest unpaid periodic
// invoice age > credit_days (lock_reason_code = credit_days_exceeded); never auto-unlock"; PRD US-BL-10.4; 07-SECURITY REQ-SEC-024 tenant guard). No DB (logic is in credit_days_check.live.test.ts).
// ASSUMED (spec silent; writer: dispute if wrong): task file tasks/credit_days_check.ts exports CREDIT_DAYS_CHECK = 'billing.credit_days_check' and the handler `creditDaysCheck`;
//   payload { tenant_id }; a payload whose tenant_id is missing or differs from ctx.tenantId runs NO statement and resolves (same rule as BL-T17 tasks); statements go through ctx.tx.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateManifests } from '../../../core/manifest.js';

const DIR = join(import.meta.dirname, '..');
const ID = 'billing.credit_days_check';
const TENANT_A = '0190a000-0000-7000-8000-00000000aaaa', TENANT_B = '0190a000-0000-7000-8000-00000000bbbb';
const manifest = async (): Promise<any> => (await import('../index.js')).manifest;
const code = (rel: string) => readFileSync(join(DIR, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function ctxOf(tenantId: string | undefined) {
  const stmts: Array<{ text: string; values: unknown[] }> = [];
  const tx = { async query(text: string, values: unknown[] = []) { stmts.push({ text, values }); return { rows: [], rowCount: 0 }; } };
  const ctx: any = {
    tenantId, tx, actor: { type: 'system', id: '0190a000-0000-7000-8000-00000000a009' }, requestId: 'r', attempt: 1, maxAttempts: 3, jobId: '1',
    now: () => '2026-11-08T12:00:30.000Z', isNewer: () => true, events: {}, core: {}, storage: {}, files: {}, audit: {},
    log: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } }, metrics: { inc() {}, set() {}, observe() {} },
  };
  ctx.db = { tx: async (fn: any) => fn(ctx) };
  return { ctx, stmts };
}

describe('manifest + crontab (02-TRD §10)', () => {
  it('registers billing.credit_days_check as a function and the manifest still validates', async () => {
    const m = await manifest();
    expect(typeof m.tasks[ID]).toBe('function');
    expect(() => validateManifests([m])).not.toThrow();
  });
  it('cron 0 19 * * * (00:45 NPT), per_tenant, maxAttempts 3 — in crontab and in manifest.maxAttempts', async () => {
    const m = await manifest(); const c = (m.crontab as any[]).filter((x) => x.identifier === ID);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ schedule: '0 19 * * *', tenantScope: 'per_tenant', maxAttempts: 3 });
    expect(m.maxAttempts[ID]).toBe(3);
  });
  it('cron.ts exports the crontab the manifest uses, and the BL-T17 entries are still there', async () => {
    const m = await manifest(); const cron: any = await import('../cron.js');
    expect(cron.crontab).toEqual(m.crontab);
    const ids = (m.crontab as any[]).map((x) => x.identifier);
    expect(ids).toEqual(expect.arrayContaining(['billing.fiscal_counter_prepare', 'billing.integrity_check', ID]));
  });
  it('task module exports the identifier constant', async () => {
    const mod: any = await import('../tasks/credit_days_check.js');
    expect(mod.CREDIT_DAYS_CHECK).toBe(ID);
  });
});

describe('tenant guard (REQ-SEC-024)', () => {
  it('payload tenant_id missing / different from the job tenant / not a uuid -> no statement, no throw', async () => {
    const m = await manifest();
    for (const payload of [{}, { tenant_id: TENANT_B }, { tenant_id: 'not-a-uuid' }, undefined]) {
      const { ctx, stmts } = ctxOf(TENANT_A);
      await m.tasks[ID](payload, ctx);
      expect(stmts, JSON.stringify(payload)).toEqual([]);
    }
  });
  it('job without a tenant scope runs no statement', async () => {
    const m = await manifest(); const { ctx, stmts } = ctxOf(undefined);
    await m.tasks[ID]({ tenant_id: TENANT_A }, ctx); expect(stmts).toEqual([]);
  });
});

describe('what the job may do (US-BL-10.4; "never auto-unlock"; 05-SCHEMA credit_accounts__lock__ck)', () => {
  it('with nothing overdue it runs statements that all carry the tenant id as a bound parameter and resolves', async () => {
    const m = await manifest(); const { ctx, stmts } = ctxOf(TENANT_A);
    await m.tasks[ID]({ tenant_id: TENANT_A }, ctx);
    expect(stmts.length).toBeGreaterThan(0);
    for (const s of stmts) { expect(s.text).toMatch(/\btenant_id\b/i); expect(s.values).toContain(TENANT_A); }
  });
  it('source: locks with reason credit_days_exceeded, writes only billing.credit_accounts, targets only unlocked accounts, never unlocks, never deletes, no console', () => {
    const c = code('tasks/credit_days_check.ts');
    expect(c).toContain('credit_days_exceeded');
    expect(c).toMatch(/billing\.credit_accounts/);
    expect(c).toMatch(/\bis_locked\s*=\s*(true|TRUE)\b/);
    expect(c).not.toMatch(/\bis_locked\s*=\s*(false|FALSE)\b/);
    expect(c).not.toMatch(/\block_reason_code\s*=\s*null\b/i);
    expect(c).not.toMatch(/delete\s+from|truncate|alter\s+table|drop\s+/i);
    expect(c).not.toMatch(/\b(insert\s+into|update)\s+billing\.(?!credit_accounts\b)[a-z_]+/i);
    expect(c).not.toMatch(/console\./);
  });
  it('source: honours the tenant setting credit_days_auto_lock, uses credit_days and the periodic-invoice flag, and looks at payments', () => {
    const c = code('tasks/credit_days_check.ts');
    for (const needle of [/credit_days_auto_lock/, /\bcredit_days\b/, /is_periodic_credit_bill/, /ledger_entries/, /issued_at/]) expect(c).toMatch(needle);
  });
  it('source: no tenant uuid literal, no import of another module\'s job folder', () => {
    const c = code('tasks/credit_days_check.ts');
    expect(c).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(c).not.toMatch(/from\s+['"][^'"]*\/jobs\/(?!billing\b)[a-z_]+\//);
  });
});
