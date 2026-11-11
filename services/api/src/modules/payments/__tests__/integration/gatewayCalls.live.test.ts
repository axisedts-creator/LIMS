// PG-T04 live-DB integration (05-SCHEMA payments.gateway_calls: RLS, append-only grants, CHECKs; REQ-SEC-056/098; ST-11).
// Needs the C0/C15 DDL (payments schema). Gated like billing/repository/__tests__/immutability.live.test.ts: skipped unless both URLs are set.
//   LIMS_TEST_DATABASE_URL      superuser URL of a migrated + seeded DB (tenant 01a1a98a-ac40-7000-8000-00000000a001). Reads/cleans only.
//   LIMS_TEST_APP_DATABASE_URL  URL that logs in as (or can SET ROLE to) lims_app; inserts/assertions run as lims_app with real claims.
// Rows use ids 0190c403-0000-7000-8000-0000000400xx (no intent/merchant FK: both columns are nullable); removed in afterAll.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../../../../core/db/tx.js';
import { insertGatewayCall } from '../../repository/gatewayCalls.repo.js';

const SU = process.env['LIMS_TEST_DATABASE_URL'], APP = process.env['LIMS_TEST_APP_DATABASE_URL'];
const TENANT = '01a1a98a-ac40-7000-8000-00000000a001', OTHER_TENANT = '01a1a98a-ac40-7000-8000-00000000a0ff';
const MEMBERSHIP = '01a1a98a-ac40-7000-8000-00000000a500', SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const uid = (n: number) => `0190c403-0000-7000-8000-${String(400 + n).padStart(12, '0')}`;
const CLAIMS = { actor_type: 'system', tenant_id: TENANT, sub: SYS, membership_id: MEMBERSHIP };
const PHONE = '9800000000';

describe.skipIf(!SU || !APP)('payments.gateway_calls through the repo as lims_app over a real DB', () => {
  let su: any, app: any, db: ReturnType<typeof createDb>;
  const requestTx = <T>(fn: Parameters<typeof db.requestTx<T>>[1]) =>
    db.requestTx({ claims: CLAIMS as never, requestId: uid(90), clientIp: '203.0.113.7', operation: { module: 'payments', operationId: 'PG-T04.live' } }, fn);
  async function asApp(sql: string, values: unknown[] = [], claims: object = CLAIMS): Promise<string> {
    const c = await app.connect();
    try {
      await c.query('BEGIN'); await c.query('SET LOCAL ROLE lims_app');
      await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
      const r = await c.query(sql, values); await c.query('ROLLBACK');
      return `n=${r.rowCount}`;
    } catch (e: any) { await c.query('ROLLBACK').catch(() => undefined); return `E${e.code}|${e.message}`; } finally { c.release(); }
  }

  beforeAll(async () => {
    const pg: any = await import(['p', 'g'].join(''));
    const Pool = (pg.default ?? pg).Pool;
    su = new Pool({ connectionString: SU, max: 2 }); app = new Pool({ connectionString: APP, max: 4 });
    db = createDb({ pool: app, identitySystemActorId: SYS });
  });
  afterAll(async () => {
    if (su) await su.query(`DELETE FROM payments.gateway_calls WHERE id = ANY($1::uuid[])`, [[1, 2, 3].map(uid)]).catch(() => undefined);
    await su?.end(); await app?.end();
  });

  it('insertGatewayCall persists a row; unredacted input is stored allowlisted-only (no mobile, no payment_url)', async () => {
    await requestTx((tx) => insertGatewayCall(tx, {
      id: uid(1), tenantId: TENANT, gateway: 'khalti', operation: 'khalti_lookup', outcome: 'answer', httpStatus: 200, gatewayStatusRaw: 'Completed', durationMs: 31, createdBy: SYS,
      responseRedacted: { status: 'Completed', total_amount: 225000, mobile: PHONE, payment_url: 'https://x.example/', zzz: 1 },
    } as never));
    const { rows } = await su.query(`SELECT * FROM payments.gateway_calls WHERE id = $1`, [uid(1)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenant_id: TENANT, gateway: 'khalti', operation: 'khalti_lookup', outcome: 'answer', http_status: 200, attempt: 1, duration_ms: 31 });
    expect(rows[0].response_redacted).toEqual({ status: 'Completed', total_amount: 225000 });
    expect(JSON.stringify(rows[0])).not.toContain(PHONE);
  });

  it('a timeout row stores NULL response and NULL http_status', async () => {
    await requestTx((tx) => insertGatewayCall(tx, { id: uid(2), tenantId: TENANT, gateway: 'esewa', operation: 'esewa_status', outcome: 'timeout', durationMs: 2500, createdBy: SYS } as never));
    const { rows } = await su.query(`SELECT http_status, response_redacted, outcome FROM payments.gateway_calls WHERE id = $1`, [uid(2)]);
    expect(rows[0]).toEqual({ http_status: null, response_redacted: null, outcome: 'timeout' });
  });

  it('schema CHECKs reject an unknown outcome and an oversized response even if the repo were bypassed', async () => {
    const ins = (outcome: string, resp: string | null) => asApp(
      `INSERT INTO payments.gateway_calls (id, tenant_id, gateway, operation, outcome, response_redacted, duration_ms, created_by) VALUES ($1,$2,'khalti','khalti_lookup',$3,$4::jsonb,1,$5)`,
      [uid(3), TENANT, outcome, resp, SYS]);
    expect(await ins('bogus', null)).toMatch(/^E23514/);
    expect(await ins('answer', JSON.stringify({ k: 'x'.repeat(3000) }))).toMatch(/^E23514/);
  });

  it('lims_app cannot UPDATE or DELETE gateway_calls (append-only, class A)', async () => {
    expect(await asApp(`UPDATE payments.gateway_calls SET outcome = 'answer' WHERE id = $1`, [uid(1)])).toMatch(/^E42501/);
    expect(await asApp(`DELETE FROM payments.gateway_calls WHERE id = $1`, [uid(1)])).toMatch(/^E42501/);
  });

  it('RLS: another tenant sees no rows and cannot insert into this tenant', async () => {
    const other = { ...CLAIMS, tenant_id: OTHER_TENANT };
    expect(await asApp(`SELECT 1 FROM payments.gateway_calls WHERE id = $1`, [uid(1)], other)).toBe('n=0');
    expect(await asApp(
      `INSERT INTO payments.gateway_calls (id, tenant_id, gateway, operation, outcome, duration_ms, created_by) VALUES ($1,$2,'khalti','khalti_lookup','answer',1,$3)`,
      [uid(3), TENANT, SYS], other)).toMatch(/^E(42501|23514|P0001)/);
  });
});
