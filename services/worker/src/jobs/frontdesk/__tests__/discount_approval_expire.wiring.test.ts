// FD-T07 frontdesk.discount_approval_expire wiring + static rules (02-TRD §3.3 manifest, §10 row: cron `*/5 * * * *`, per_tenant, 3 attempts, "pending/approved past expires_at -> expired";
// 06-IMPLEMENTATION-PLAN FD-T07: `cron.ts` with tenantScope 'per_tenant' (P-6); 07-SECURITY REQ-SEC-024 tenant guard). No DB: behaviour is in discount_approval_expire.live.test.ts.
// ASSUMED (spec silent; same shape as BL-T13/BL-T17 tasks, writer: dispute if wrong): tasks/discount_approval_expire.ts exports DISCOUNT_APPROVAL_EXPIRE = 'frontdesk.discount_approval_expire'
//   and the handler `discountApprovalExpire`; payload { tenant_id }; a payload whose tenant_id is missing or differs from ctx.tenantId runs NO statement and resolves; statements go through ctx.tx.
// Fails now: the task file and the crontab do not exist (manifest is `{ module: 'frontdesk' }`).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateManifests } from '../../../core/manifest.js';

const DIR = join(import.meta.dirname, '..');
const ID = 'frontdesk.discount_approval_expire';
const TENANT_A = '01a1a98a-ac40-7000-8000-00000000a001', TENANT_B = '01a1a98a-ac40-7000-8000-00000000b001';
const manifest = async (): Promise<any> => (await import('../index.js')).manifest;
const code = (rel: string) => readFileSync(join(DIR, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function ctxOf(tenantId: string | undefined) {
  const stmts: Array<{ text: string; values: unknown[] }> = [];
  const tx = { async query(text: string, values: unknown[] = []) { stmts.push({ text, values }); return { rows: [], rowCount: 0 }; } };
  const ctx: any = {
    tenantId, tx, actor: { type: 'system', id: '01a1b34e-1000-7eee-9d29-d7ca59a102b5' }, requestId: 'r', attempt: 1, maxAttempts: 3, jobId: '1',
    now: () => '2026-11-10T12:00:00.000Z', isNewer: () => true, events: {}, core: {}, storage: {}, files: {}, audit: {},
    log: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } }, metrics: { inc() {}, set() {}, observe() {} },
  };
  ctx.db = { tx: async (fn: any) => fn(ctx) };
  return { ctx, stmts };
}

describe('manifest + crontab (02-TRD §10)', () => {
  it('registers frontdesk.discount_approval_expire as a function and the frontdesk manifest still validates', async () => {
    const m = await manifest();
    expect(m.module).toBe('frontdesk');
    expect(typeof m.tasks?.[ID]).toBe('function');
    expect(() => validateManifests([m])).not.toThrow();
  });
  it('cron */5 * * * *, per_tenant, maxAttempts 3 — in crontab and in manifest.maxAttempts; exactly one entry', async () => {
    const m = await manifest();
    const c = ((m.crontab ?? []) as any[]).filter((x) => x.identifier === ID);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ schedule: '*/5 * * * *', tenantScope: 'per_tenant', maxAttempts: 3 });
    expect(m.maxAttempts?.[ID]).toBe(3);
  });
  it('cron.ts exports the crontab the manifest uses; the task file exports the identifier and handler', async () => {
    const m = await manifest();
    const cron: any = await import('../cron.js');
    expect(cron.crontab).toBe(m.crontab);
    expect(Object.isFrozen(cron.crontab)).toBe(true);
    const task: any = await import('../tasks/discount_approval_expire.js');
    expect(task.DISCOUNT_APPROVAL_EXPIRE).toBe(ID);
    expect(task.discountApprovalExpire).toBe(m.tasks[ID]);
  });
});

describe('tenant guard (REQ-SEC-024): the job acts only on the tenant it was enqueued for', () => {
  for (const [name, payload, tenantId] of [
    ['payload without tenant_id', {}, TENANT_A],
    ['payload tenant_id of another tenant', { tenant_id: TENANT_B }, TENANT_A],
    ['payload tenant_id but ctx without tenant', { tenant_id: TENANT_A }, undefined],
    ['payload tenant_id that is not a uuid', { tenant_id: "x' OR '1'='1" }, TENANT_A],
  ] as const) {
    it(`${name}: no statement runs and the task resolves`, async () => {
      const { ctx, stmts } = ctxOf(tenantId);
      await expect((await manifest()).tasks[ID](payload, ctx)).resolves.toBeUndefined();
      expect(stmts).toHaveLength(0);
    });
  }
  it('matching tenant: every statement names tenant_id and binds it; nothing destructive; an UPDATE of frontdesk.discount_approvals sets status expired for pending/approved', async () => {
    const { ctx, stmts } = ctxOf(TENANT_A);
    await (await manifest()).tasks[ID]({ tenant_id: TENANT_A }, ctx);
    expect(stmts.length).toBeGreaterThan(0);
    for (const s of stmts) {
      expect(s.text).toMatch(/tenant_id/);
      expect(s.text).not.toMatch(/DELETE|INSERT|TRUNCATE|DROP/i);
      expect(s.values).toContain(TENANT_A);
    }
    const upd = stmts.filter((s) => /UPDATE\s+frontdesk\.discount_approvals/i.test(s.text));
    expect(upd.length).toBeGreaterThan(0);
    const blob = upd.map((s) => `${s.text}\n${JSON.stringify(s.values)}`).join('\n');
    for (const w of ['expired', 'pending', 'approved']) expect(blob, w).toContain(w);
  });
  it('the task source takes "now" from ctx.now() (testable clock), not the DB or process clock', () => {
    const src = code('tasks/discount_approval_expire.ts');
    expect(src).toMatch(/ctx\.now\(\)|\.now\(\)/);
    expect(src).not.toMatch(/Date\.now\(\)|new Date\(\s*\)/);
  });
});
