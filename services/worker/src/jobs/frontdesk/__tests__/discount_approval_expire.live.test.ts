// FD-T07 live-DB behaviour of frontdesk.discount_approval_expire (03-APP-FLOW §1.3: `pending`/`approved` -> `expired` by the cron when now >= expires_at; `rejected`/`consumed`/`expired` are
// terminal and never touched; 02-TRD §10; 05-SCHEMA discount_approvals lifecycle guard + mutable columns; REQ-SEC-024 tenant isolation).
// Skipped unless LIMS_TEST_DATABASE_URL (superuser URL of a migrated + seeded DB; tests/frontdesk/FD-T07.pg.sh exports it). Tasks run through a hand-built JobContext whose tx is a pg client in a
// transaction with system claims (BL-T13 pattern). ctx.now() is injected (2099-06-01) so a task using the DB clock instead of ctx.now() leaves the rows pending and fails here.
// ASSUMED: same payload / export names as the wiring test. Fixtures: ids 0190c507-…, patient-less (draft_hash) so no patient fixture; removed in beforeAll/afterAll.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SU = process.env['LIMS_TEST_DATABASE_URL'];
const TENANT_A = '01a1a98a-ac40-7000-8000-00000000a001', TENANT_B = '01a1a98a-ac40-7000-8000-00000000b001';
const CENTRE_A = '01a1a98a-ac40-7000-8000-00000000a201', CENTRE_B = '01a1a98a-ac40-7000-8000-00000000b201';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const REQ = '01a1a98a-ac40-7000-8000-00000000a501', DEC = '01a1a98a-ac40-7000-8000-00000000a502';
const ID = 'frontdesk.discount_approval_expire';
const NOW = '2099-06-01T12:00:00.000Z';
const at = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();
const uid = (n: number) => `0190c507-0000-7000-8000-${String(n).padStart(12, '0')}`;
const N = { pendPast: 1, pendAtNow: 2, pendFuture: 3, apprPast: 4, apprFuture: 5, rejPast: 6, consPast: 7, expiredAlready: 8, bPendPast: 9, guardPast: 10, empty: 11 };
const ALL = Object.values(N).map(uid);

const row = (n: number, tenant: string, centre: string, status: string, expires: string, o: Record<string, unknown> = {}) => ({
  id: uid(n), tenant_id: tenant, centre_id: centre, requested_by_membership_id: REQ, draft_hash: 'a'.repeat(64), base_fingerprint: 'b'.repeat(64),
  discounts: [{ scope: 'bill', kind: 'percent', percent_bp: 3000, reason_code: 'staff_family' }], gross_paisa: 70000, computed_discount_paisa: 21000, percent_of_gross_bp: 3000,
  reason_code: 'staff_family', status, expires_at: expires, created_by: SYS, updated_by: SYS,
  version: 1, is_active: true, created_at: at(-7_200_000), updated_at: at(-7_200_000),     // jsonb_populate_record yields NULL, not the column default
  ...(['approved', 'rejected', 'consumed'].includes(status) ? { decided_by_membership_id: DEC, decided_at: at(-3_600_000), decision_note: status === 'rejected' ? 'Synthetic' : null } : {}),
  ...(status === 'consumed' ? { consumed_order_id: uid(900), consumed_at: at(-60_000) } : {}), ...o });

describe.skipIf(!SU)('frontdesk.discount_approval_expire over a real DB', () => {
  let su: any;
  let manifest: any;

  const claims = (tenant: string) => JSON.stringify({ tenant_id: tenant, sub: SYS, actor_type: 'system' });
  async function insert(rows: object[]) {
    const c = await su.connect();
    try {
      await c.query('BEGIN');
      for (const r of rows) {
        await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [claims((r as any).tenant_id)]);   // the audit trigger writes under the claimed tenant
        await c.query(`INSERT INTO frontdesk.discount_approvals SELECT * FROM jsonb_populate_record(NULL::frontdesk.discount_approvals, $1::jsonb)`, [JSON.stringify(r)]);
      }
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  }
  async function run(tenantCtx: string, payload: Record<string, unknown>) {
    const c = await su.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [claims(tenantCtx)]);
      const ctx: any = {
        tenantId: tenantCtx, tx: c, actor: { type: 'system', id: SYS }, requestId: uid(990), attempt: 1, maxAttempts: 3, jobId: '1', now: () => NOW, isNewer: () => true,
        events: {}, core: {}, storage: {}, files: {}, audit: {}, log: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } }, metrics: { inc() {}, set() {}, observe() {} },
      };
      ctx.db = { tx: async (fn: any) => fn(ctx) };
      await manifest.tasks[ID](payload, ctx);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  }
  const get = async (n: number) => (await su.query('SELECT * FROM frontdesk.discount_approvals WHERE id = $1', [uid(n)])).rows[0];
  async function cleanup() {                                   // the audit trigger needs claims.sub on DELETE too
    const c = await su.connect();
    try {
      await c.query('BEGIN');
      for (const t of [TENANT_A, TENANT_B]) {
        await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [claims(t)]);
        await c.query('DELETE FROM frontdesk.discount_approvals WHERE tenant_id = $2 AND id = ANY($1::uuid[])', [ALL, t]);
      }
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  }

  beforeAll(async () => {
    const pg: any = createRequire(join(import.meta.dirname, '../../../../../api/package.json'))('pg');   // pg lives in services/api (the worker has no pg dependency)
    su = new (pg.default ?? pg).Pool({ connectionString: SU, max: 3 });
    manifest = (await import('../index.js')).manifest;
    await cleanup();
  });
  afterAll(async () => { if (su) { await cleanup(); await su.end(); } });

  it('expires pending/approved rows with expires_at <= ctx.now() (boundary inclusive); leaves the future ones and every terminal row alone; other tenants untouched', async () => {
    await insert([
      row(N.pendPast, TENANT_A, CENTRE_A, 'pending', at(-3_600_000)),
      row(N.pendAtNow, TENANT_A, CENTRE_A, 'pending', NOW),
      row(N.pendFuture, TENANT_A, CENTRE_A, 'pending', at(1000)),
      row(N.apprPast, TENANT_A, CENTRE_A, 'approved', at(-60_000)),
      row(N.apprFuture, TENANT_A, CENTRE_A, 'approved', at(60_000)),
      row(N.rejPast, TENANT_A, CENTRE_A, 'rejected', at(-3_600_000)),
      row(N.consPast, TENANT_A, CENTRE_A, 'consumed', at(-3_600_000)),
      row(N.expiredAlready, TENANT_A, CENTRE_A, 'expired', at(-3_600_000)),
      row(N.bPendPast, TENANT_B, CENTRE_B, 'pending', at(-3_600_000)),
    ]);
    const before = { rej: await get(N.rejPast), cons: await get(N.consPast), exp: await get(N.expiredAlready), apprPast: await get(N.apprPast) };
    await run(TENANT_A, { tenant_id: TENANT_A });
    for (const n of [N.pendPast, N.pendAtNow, N.apprPast]) expect((await get(n)).status, `row ${n}`).toBe('expired');
    for (const [n, s] of [[N.pendFuture, 'pending'], [N.apprFuture, 'approved'], [N.rejPast, 'rejected'], [N.consPast, 'consumed'], [N.expiredAlready, 'expired'], [N.bPendPast, 'pending']] as const) {
      expect((await get(n)).status, `row ${n}`).toBe(s);
    }
    // the expiry changes status only: decision columns, binding and consumption are preserved
    const apprPast = await get(N.apprPast);
    expect(apprPast).toMatchObject({ decided_by_membership_id: before.apprPast.decided_by_membership_id, base_fingerprint: 'b'.repeat(64), consumed_order_id: null, requested_by_membership_id: REQ });
    expect((await get(N.pendPast)).decided_by_membership_id).toBeNull();
    expect(await get(N.rejPast)).toEqual(before.rej);
    expect(await get(N.consPast)).toEqual(before.cons);
    expect(await get(N.expiredAlready)).toEqual(before.exp);
  });

  it('idempotent: a second run changes nothing and does not fail; tenant B\'s own run then expires only tenant B', async () => {
    const snap = async () => JSON.stringify(await Promise.all([N.pendPast, N.pendAtNow, N.pendFuture, N.apprPast, N.apprFuture].map(get)));
    const first = await snap();
    await run(TENANT_A, { tenant_id: TENANT_A });
    expect(await snap()).toBe(first);
    expect((await get(N.bPendPast)).status).toBe('pending');
    await run(TENANT_B, { tenant_id: TENANT_B });
    expect((await get(N.bPendPast)).status).toBe('expired');
    expect((await get(N.pendFuture)).status).toBe('pending');
  });

  it('tenant guard: a payload for another tenant (or none) under tenant A\'s context changes nothing, even with overdue rows present', async () => {
    await insert([row(N.guardPast, TENANT_A, CENTRE_A, 'pending', at(-3_600_000))]);
    await run(TENANT_A, { tenant_id: TENANT_B });
    await run(TENANT_A, {});
    expect((await get(N.guardPast)).status).toBe('pending');
    await run(TENANT_A, { tenant_id: TENANT_A });
    expect((await get(N.guardPast)).status).toBe('expired');
  });

  it('nothing to expire: resolves without error', async () => {
    await insert([row(N.empty, TENANT_A, CENTRE_A, 'pending', at(86_400_000))]);
    await expect(run(TENANT_A, { tenant_id: TENANT_A })).resolves.toBeUndefined();
    expect((await get(N.empty)).status).toBe('pending');
  });
});
