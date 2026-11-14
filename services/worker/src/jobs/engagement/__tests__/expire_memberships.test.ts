// C16.T-M1 — cron `engagement.expire_memberships` (02-TRD §8.2: daily 00:20 Asia/Kathmandu, per_tenant, "valid_to < today -> expired"; PRD US-EN-17.6;
// 02-TRD §9.3: the system actor holds engagement.membership.enrol "(expiry)"; REQ-SEC-024 tenant guard).
// Fails now: the manifest has no `engagement.expire_memberships` task and no cron row.
// SEAMS (spec silent; same convention as close_queue_day.test.ts): manifest.tasks['engagement.expire_memberships'](payload {tenant_id}, ctx); crontab row in cron.ts / manifest.crontab:
//   00:20 NPT (UTC+05:45) = 18:35 UTC the day before -> `35 18 * * *`, tenantScope per_tenant. `today` = the Asia/Kathmandu date of ctx.now() (05-SCHEMA P-15).
//   Statements go through ctx.tx, always bind tenant_id, never DELETE / INSERT; expired rows get status 'expired', version + 1, updated_by = ctx.actor.id. DB = membership.world.ts (FakeDb: single-table statements).
import { describe, expect, it } from 'vitest';
import { validateManifests } from '../../../core/manifest.js';
import { ID, PAT1, PAT2, PAT3, PAT_B, SYSTEM, TA, TB, makeWorld, membership } from '../../../../../api/src/modules/engagement/__tests__/membership.world.js';

const TASK = 'engagement.expire_memberships';
const manifest = async (): Promise<any> => (await import('../index.js')).manifest;
const T_0020 = '2027-10-01T18:35:00.000Z'; // 00:20 NPT on 2027-10-02
const M = (n: number, o: Record<string, unknown> = {}) => membership({ id: ID(0x400 + n), card_no: `MB26${String(n).padStart(6, '0')}`, card_token: `${n.toString(32).toUpperCase().padStart(2, '0').replace(/[ILOU]/g, 'Z')}${'0123456789ABCDEFGHJKMNPQRS'.slice(2)}`, ...o });

function setup(now: string, tenantId?: string | null) {
  const w = makeWorld({ now, seed: (s) => {
    s.tables['patients']!.push({ id: ID(0x14), tenant_id: TA }, { id: ID(0x15), tenant_id: TA });
    s.tables['patient_memberships']!.push(
      M(1, { patient_id: PAT1, valid_to: '2027-10-01' }),                                  // yesterday -> expired
      M(2, { patient_id: PAT2, valid_to: '2027-10-02' }),                                  // valid_to = today -> still active (TRD: valid_to < today)
      M(3, { patient_id: PAT3, valid_to: '2027-12-01' }),                                  // future -> active
      M(4, { patient_id: ID(0x14), valid_to: '2026-12-01' }),                              // long past -> expired
      M(5, { patient_id: ID(0x15), status: 'cancelled', cancelled_at: '2026-10-10T00:00:00.000Z', cancel_reason_code: 'other', valid_to: '2026-12-01', version: 2 }), // cancelled stays cancelled
      M(6, { patient_id: ID(0x16), status: 'expired', valid_to: '2026-06-01', version: 3 }), // already expired: untouched
      M(7, { tenant_id: TB, patient_id: PAT_B, plan_id: ID(0x2b), valid_to: '2026-12-01' }), // other tenant: untouched
    );
    s.tables['patients']!.push({ id: ID(0x16), tenant_id: TA });
  } });
  const ctx: any = w.session('system', { attempt: 1, maxAttempts: 3, jobId: '1', isNewer: () => true, events: {}, core: {}, storage: {}, files: {}, ...(tenantId === null ? { tenantId: undefined } : tenantId ? { tenantId } : {}) });
  ctx.db = { tx: async (fn: any) => fn(ctx) };
  return { w, ctx };
}
const st = (w: ReturnType<typeof makeWorld>, n: number) => w.mem(ID(0x400 + n))!;
const run = async (now: string, payload: Record<string, unknown> = { tenant_id: TA }) => { const s = setup(now); await (await manifest()).tasks[TASK](payload, s.ctx); return s; };

describe('manifest + crontab (02-TRD §8.2)', () => {
  it('registers engagement.expire_memberships as a function and the manifest still validates', async () => {
    const m = await manifest();
    expect(typeof m.tasks?.[TASK]).toBe('function');
    expect(() => validateManifests([m])).not.toThrow();
  });
  it('one cron row: daily 00:20 Asia/Kathmandu = `35 18 * * *` (UTC), per_tenant, retried; existing rows untouched', async () => {
    const m = await manifest();
    const rows = ((m.crontab ?? []) as any[]).filter((x) => x.identifier === TASK);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ schedule: '35 18 * * *', tenantScope: 'per_tenant' });
    expect(rows[0].maxAttempts).toBeGreaterThanOrEqual(2);
    const ids = (m.crontab as any[]).map((x) => x.identifier);
    for (const id of ['engagement.close_queue_day', 'engagement.dispatch_due_reminders', 'engagement.purge_ephemeral', 'engagement.purge_queue']) expect(ids, id).toContain(id);
  });
});

describe('US-EN-17.6 expiry', () => {
  it('active memberships with valid_to < today (Asia/Kathmandu) become expired; valid_to = today and future ones stay active', async () => {
    const { w } = await run(T_0020);
    expect([1, 4].map((n) => st(w, n)['status'])).toEqual(['expired', 'expired']);
    expect([2, 3].map((n) => st(w, n)['status'])).toEqual(['active', 'active']);
  });
  it('the day comes from ctx.now() in the tenant timezone: at 18:35 UTC on 10-01 UTC-today is still 10-01 but NPT-today is 10-02, so valid_to 10-01 expires; a run one hour earlier (23:20 NPT 10-01) does not', async () => {
    expect(st((await run(T_0020)).w, 1)['status']).toBe('expired');
    expect(st((await run('2027-10-01T17:35:00.000Z')).w, 1)['status']).toBe('active');
  });
  it('the next night expires the valid_to = 10-02 card (fake clock advance)', async () => {
    const s = setup(T_0020);
    await (await manifest()).tasks[TASK]({ tenant_id: TA }, s.ctx);
    expect(st(s.w, 2)['status']).toBe('active');
    s.w.advance(24 * 3_600_000);
    await (await manifest()).tasks[TASK]({ tenant_id: TA }, s.ctx);
    expect(st(s.w, 2)['status']).toBe('expired');
    expect(st(s.w, 3)['status']).toBe('active');
  });
  it('an expired card keeps its number, token, dates and gets version + 1 and updated_by = the system actor; untouched rows keep their version', async () => {
    const { w } = await run(T_0020);
    expect(st(w, 1)).toMatchObject({ card_no: 'MB26000001', valid_to: '2027-10-01', version: 2, updated_by: SYSTEM, cancelled_at: null });
    expect(st(w, 3)['version']).toBe(1);
  });
  it('cancelled and already expired cards are not touched (status, version, cancel data)', async () => {
    const { w } = await run(T_0020);
    expect(st(w, 5)).toMatchObject({ status: 'cancelled', version: 2, cancel_reason_code: 'other' });
    expect(st(w, 6)).toMatchObject({ status: 'expired', version: 3 });
  });
  it('other tenants are never touched (tenant B card past its end stays active)', async () => {
    const { w } = await run(T_0020);
    expect(st(w, 7)).toMatchObject({ tenant_id: TB, status: 'active', version: 1 });
  });
  it('idempotent: a second run changes nothing and does not throw (retry safe)', async () => {
    const s = setup(T_0020);
    const t = (await manifest()).tasks[TASK];
    await t({ tenant_id: TA }, s.ctx);
    const snap = JSON.stringify(s.w.tables['patient_memberships']);
    await t({ tenant_id: TA }, s.ctx);
    expect(JSON.stringify(s.w.tables['patient_memberships'])).toBe(snap);
  });
  it('an expired patient can be enrolled again afterwards (the partial unique index only holds active cards)', async () => {
    const { w } = await run(T_0020);
    const before = w.tables['patient_memberships']!.length;
    await w.session('staff').tx.query(`INSERT INTO engagement.patient_memberships (id, tenant_id, patient_id, plan_id, card_no, card_token, valid_from, valid_to, enrolled_by, created_by, updated_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $9)`, [ID(0x4ff), TA, PAT1, ID(0x21), 'MB26000099', '9ABCDEFGHJKMNPQRSTVWXYZ012', '2027-10-02', '2028-10-02', ID(9)]);
    expect(w.tables['patient_memberships']).toHaveLength(before + 1);
  });
});

describe('tenant guard (REQ-SEC-024): the job acts only on the tenant it was enqueued for', () => {
  for (const [name, payload, tenantId] of [
    ['payload without tenant_id', {}, TA],
    ['payload tenant_id of another tenant', { tenant_id: TB }, TA],
    ['payload tenant_id but ctx without tenant', { tenant_id: TA }, null],
    ['payload tenant_id that is not a uuid', { tenant_id: "x' OR '1'='1" }, TA],
  ] as const) {
    it(`${name}: no statement runs and the task resolves`, async () => {
      const s = setup(T_0020, tenantId);
      await expect((await manifest()).tasks[TASK](payload, s.ctx)).resolves.toBeUndefined();
      expect(s.w.stmts).toHaveLength(0);
      expect(s.w.tables['patient_memberships']!.filter((m) => m['status'] === 'expired')).toHaveLength(1); // only the seeded one
    });
  }
  it('matching tenant: every statement names tenant_id and binds it; the UPDATE targets engagement.patient_memberships; nothing destructive, no catalog read', async () => {
    const { w } = await run(T_0020);
    expect(w.stmts.length).toBeGreaterThan(0);
    for (const c of w.stmts) { expect(c.text).toMatch(/tenant_id/); expect(c.text).not.toMatch(/\b(DELETE|INSERT|TRUNCATE|DROP)\b|v_pub_|catalog\./i); expect(c.values).toContain(TA); }
    expect(w.stmts.some((c) => /UPDATE\s+engagement\.patient_memberships/i.test(c.text))).toBe(true);
  });
});
