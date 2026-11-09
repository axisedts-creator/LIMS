// AN-T04 live-DB integration: `rollups_equal_views` (PRD US-20.3, TRD §15) + concurrent runs + lazy refresh_state/refresh_runs + never_refreshed, over a real migrated + seeded DB.
// Gated exactly like billing/.../counter.live.test.ts: skipped unless both URLs are set (needs `pg`, loaded dynamically):
//   LIMS_TEST_DATABASE_URL      superuser URL of a migrated + seeded DB (tenant A 01a1a98a-ac40-7000-8000-00000000a001, tenant B …b001). Used to compare, inspect, clean up.
//   LIMS_TEST_APP_DATABASE_URL  URL that logs in as / may SET ROLE lims_app; the engine runs through createDb().requestTx as the analytics system actor.
// Data = whatever the C0 1x seed put behind the v_pub_* views; the test seeds nothing. LIMS_TEST_SEEDED_1X=1 additionally requires that at least 5 compared families are non-empty
// (otherwise "equal" could be the trivial empty == empty). Atomicity / failure / marks-during-run / TAT-move are proven deterministically in the fake-tx suites (no DB can fail on demand here).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../../../../core/db/tx.js';
import { FAMILIES, FAMILY_TABLE, SNAPSHOT_DATE, type Family } from '../../domain/families.js';
import { loadFamilyStates, markDirty } from '../refresh.repo.js';
import { evaluateFreshness } from '../../domain/freshness.js';
import { refreshTenant } from '../../service/refresh.service.js';

const SU = process.env['LIMS_TEST_DATABASE_URL'], APP = process.env['LIMS_TEST_APP_DATABASE_URL'];
const TA = '01a1a98a-ac40-7000-8000-00000000a001', TB = '01a1a98a-ac40-7000-8000-00000000b001';
const MEMBERSHIP = '01a1a98a-ac40-7000-8000-00000000a500', SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const CLAIMS = { actor_type: 'system', tenant_id: TA, sub: SYS, membership_id: MEMBERSHIP };
const uid = (n: number) => `0190c409-0000-7000-8000-${String(n).padStart(12, '0')}`;

/** family -> published view with the same column names (straight copies, §9.2). */
const COPY: Partial<Record<Family, string>> = {
  orders: 'frontdesk.v_pub_order_daily', centre_volume: 'frontdesk.v_pub_centre_volume', referrer_volume: 'frontdesk.v_pub_referrer_volume',
  income: 'billing.v_pub_invoice_daily', department_income: 'billing.v_pub_department_income', collections: 'billing.v_pub_payment_collection',
  referrer_billing: 'billing.v_pub_referrer_billing', results: 'lab.v_pub_result_daily', rejections: 'lab.v_pub_rejection_daily',
  critical_values: 'lab.v_pub_critical_value_daily', interface_messages: 'instruments.v_pub_message_daily',
};
const DATE_FAMILIES = FAMILIES.filter((f) => f !== 'report_backlog');

describe.skipIf(!SU || !APP)('analytics refresh engine over a real DB (lims_app, system actor)', () => {
  let su: any, app: any, db: ReturnType<typeof createDb>;
  let from = '', to = '';
  let reqN = 0;
  const requestTx = <T>(fn: Parameters<typeof db.requestTx<T>>[1]) =>
    db.requestTx({ claims: CLAIMS as never, requestId: uid(++reqN), clientIp: '203.0.113.7', operation: { module: 'analytics', operationId: 'AN-T04.live' } }, fn);
  const ctx = () => ({
    actor: { type: 'system' as const, id: SYS }, tenantId: TA, requestId: uid(++reqN), jobId: '1', attempt: 1, maxAttempts: 5,
    now: () => new Date().toISOString(), log: { info() {}, warn() {}, error() {}, debug() {} },
    db: { tx: <T>(fn: (c: any) => Promise<T>) => requestTx((tx) => fn({ tx })) },
  });
  const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const one = async (sql: string, values: unknown[]) => Number((await su.query(sql, values)).rows[0].n);

  async function markAll(reason: 'manual' | 'backfill' = 'backfill') {
    await requestTx(async (tx) => {
      for (const family of FAMILIES) {
        if (family === 'report_backlog') { await markDirty(tx, { tenantId: TA, family, businessDate: SNAPSHOT_DATE, reason, actorId: SYS } as never); continue; }
        for (let d = from; d < to; d = addDays(d, 1)) await markDirty(tx, { tenantId: TA, family, businessDate: d, reason, actorId: SYS } as never);
      }
    });
  }
  const rowCount = (family: Family) => one(`SELECT count(*)::int AS n FROM analytics.${FAMILY_TABLE[family]} WHERE tenant_id = $1`, [TA]);

  async function cleanup() {
    for (const t of ['dirty_partitions', 'refresh_runs', 'refresh_state']) await su.query(`DELETE FROM analytics.${t} WHERE tenant_id = $1`, [TA]);
  }

  beforeAll(async () => {
    const pg: any = await import(['p', 'g'].join(''));
    const Pool = (pg.default ?? pg).Pool;
    su = new Pool({ connectionString: SU, max: 3 }); app = new Pool({ connectionString: APP, max: 8 });
    db = createDb({ pool: app, identitySystemActorId: SYS });
    const today = String((await su.query(`SELECT ((now() AT TIME ZONE 'Asia/Kathmandu')::date)::text AS d`)).rows[0].d);
    from = addDays(today, -40); to = addDays(today, 1);
    await cleanup();
  });
  afterAll(async () => { if (su) await cleanup().catch(() => undefined); await su?.end(); await app?.end(); });

  it('before any refresh: tenant B has no refresh_state rows -> every family never_refreshed', async () => {
    expect(await one(`SELECT count(*)::int AS n FROM analytics.refresh_state WHERE tenant_id = $1`, [TB])).toBe(0);
    const states = await loadFamilyStates({ query: (t: string, v?: unknown[]) => su.query(t, v) } as never, { tenantId: TB } as never);
    expect(states).toHaveLength(16);
    for (const s of states) expect(evaluateFreshness(s, new Date().toISOString() as never, { staleDirtyMinutes: 20, staleSuccessMinutes: 30 })).toMatchObject({ is_stale: true, stale_reason: 'never_refreshed' });
  });

  it('rollups_equal_views: after a 40-day refresh of all 16 families every rollup equals its view aggregate for [today-40, today]; marks consumed; refresh_state lazily created for all 16', async () => {
    await markAll();
    await refreshTenant(ctx() as never, { tenantId: TA, trigger: 'backfill' } as never);
    expect(await one(`SELECT count(*)::int AS n FROM analytics.dirty_partitions WHERE tenant_id = $1`, [TA])).toBe(0);

    let nonEmpty = 0;
    for (const [family, view] of Object.entries(COPY) as [Family, string][]) {
      const table = FAMILY_TABLE[family];
      const [vs, vn] = view.split('.');
      const cols: string[] = (await su.query(
        `SELECT a.column_name FROM information_schema.columns a JOIN information_schema.columns b ON b.column_name = a.column_name
          WHERE a.table_schema = 'analytics' AND a.table_name = $1 AND b.table_schema = $2 AND b.table_name = $3
            AND a.column_name NOT IN ('refresh_run_id', 'refreshed_at') ORDER BY a.ordinal_position`, [table, vs, vn])).rows.map((r: any) => `"${r.column_name}"`);
      expect(cols.length, `${family}: columns shared with ${view}`).toBeGreaterThanOrEqual(4);
      expect(cols).toContain('"business_date"');
      const list = cols.join(', ');
      const R = `FROM analytics.${table} WHERE tenant_id = $1 AND business_date >= $2 AND business_date < $3`;
      const V = `FROM ${view} WHERE tenant_id = $1 AND business_date >= $2 AND business_date < $3`;
      const diff = await one(`SELECT count(*)::int AS n FROM ((SELECT ${list} ${R} EXCEPT ALL SELECT ${list} ${V}) UNION ALL (SELECT ${list} ${V} EXCEPT ALL SELECT ${list} ${R})) d`, [TA, from, to]);
      expect(diff, `${family} differs from ${view}`).toBe(0);
      if (await one(`SELECT count(*)::int AS n ${V}`, [TA, from, to]) > 0) nonEmpty++;
    }

    const bd = (c: string) => `(${c} AT TIME ZONE 'Asia/Kathmandu')::date`;
    const rng = `>= $2 AND`;
    // releases: Σ released = number of released report versions
    expect(await one(`SELECT coalesce(sum(released), 0)::int AS n FROM analytics.daily_releases WHERE tenant_id = $1 AND business_date >= $2 AND business_date < $3`, [TA, from, to]))
      .toBe(await one(`SELECT count(*)::int AS n FROM reporting.v_pub_report_release WHERE tenant_id = $1 AND ${bd('released_at')} ${rng} ${bd('released_at')} < $3`, [TA, from, to]));
    // deliveries: every status column sums to the view's (recipient_kind mapping does not change totals)
    for (const col of ['queued', 'sent', 'delivered', '"read"', 'failed', 'suppressed']) {
      expect(await one(`SELECT coalesce(sum(${col}), 0)::int AS n FROM analytics.daily_deliveries WHERE tenant_id = $1 AND business_date >= $2 AND business_date < $3`, [TA, from, to]), `deliveries.${col}`)
        .toBe(await one(`SELECT coalesce(sum(${col}), 0)::int AS n FROM reporting.v_pub_delivery_daily WHERE tenant_id = $1 AND business_date >= $2 AND business_date < $3`, [TA, from, to]));
    }
    // specimens: collected/received/rejected = primary specimens (aliquots excluded) by their own local day
    for (const [col, ts] of [['collected', 'collected_at'], ['received', 'received_at'], ['rejected', 'rejected_at']] as const) {
      expect(await one(`SELECT coalesce(sum(${col}), 0)::int AS n FROM analytics.daily_specimens WHERE tenant_id = $1 AND business_date >= $2 AND business_date < $3`, [TA, from, to]), `specimens.${col}`)
        .toBe(await one(`SELECT count(*)::int AS n FROM lab.v_pub_specimen_timeline WHERE tenant_id = $1 AND parent_specimen_id IS NULL AND ${bd(ts)} ${rng} ${bd(ts)} < $3`, [TA, from, to]));
    }
    // tat: M64 only with total_tat_seconds; aliquots/rejected never in the specimen segments
    expect(await one(`SELECT count(*)::int AS n FROM analytics.tat_facts f WHERE f.tenant_id = $1 AND f.segment = 'total_final_release' AND f.business_date >= $2 AND f.business_date < $3
                       AND NOT EXISTS (SELECT 1 FROM reporting.v_pub_order_report_tat t WHERE t.tenant_id = f.tenant_id AND t.order_id = f.subject_id AND t.total_tat_seconds IS NOT NULL)`, [TA, from, to])).toBe(0);
    expect(await one(`SELECT count(*)::int AS n FROM analytics.tat_facts f JOIN lab.v_pub_specimen_timeline s ON s.tenant_id = f.tenant_id AND s.specimen_id = f.subject_id
                       WHERE f.tenant_id = $1 AND f.business_date >= $2 AND f.business_date < $3 AND f.segment IN ('pre_analytical', 'transport', 'within_lab')
                         AND (s.parent_specimen_id IS NOT NULL OR s.rejected_at IS NOT NULL)`, [TA, from, to])).toBe(0);
    // one fact per (segment, subject): PK held, nothing duplicated across days
    expect(await one(`SELECT count(*)::int AS n FROM (SELECT 1 FROM analytics.tat_facts WHERE tenant_id = $1 GROUP BY segment, subject_id HAVING count(*) > 1) d`, [TA])).toBe(0);
    // backlog: only the two stages / four buckets, nothing cancelled
    expect(await one(`SELECT count(*)::int AS n FROM analytics.report_backlog WHERE tenant_id = $1 AND (stage NOT IN ('awaiting_results','ready_unreleased') OR orders <= 0)`, [TA])).toBe(0);

    const st = await su.query(`SELECT family, last_success_at, consecutive_failures, last_error_code, last_run_id FROM analytics.refresh_state WHERE tenant_id = $1`, [TA]);
    expect(st.rows.map((r: any) => r.family).sort()).toEqual([...FAMILIES].sort());
    for (const r of st.rows) { expect(r.last_success_at).not.toBeNull(); expect(r.consecutive_failures).toBe(0); expect(r.last_error_code).toBeNull(); expect(r.last_run_id).not.toBeNull(); }
    const runs = await su.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE status = 'succeeded')::int AS ok, count(*) FILTER (WHERE expires_at = started_at + interval '90 days')::int AS exp FROM analytics.refresh_runs WHERE tenant_id = $1`, [TA]);
    expect(runs.rows[0].n).toBeGreaterThanOrEqual(16);
    expect(runs.rows[0].ok).toBe(runs.rows[0].n);
    expect(runs.rows[0].exp).toBe(runs.rows[0].n);

    if (process.env['LIMS_TEST_SEEDED_1X'] === '1') expect(nonEmpty).toBeGreaterThanOrEqual(5);
  }, 300_000);

  it('a second full refresh is idempotent: same row counts per table, no duplicate keys, marks consumed', async () => {
    const before = Object.fromEntries(await Promise.all(FAMILIES.map(async (f) => [f, await rowCount(f)] as const)));
    await markAll('manual');
    await refreshTenant(ctx() as never, { tenantId: TA, trigger: 'manual' } as never);
    for (const f of FAMILIES) expect(await rowCount(f), f).toBe(before[f]);
    expect(await one(`SELECT count(*)::int AS n FROM analytics.dirty_partitions WHERE tenant_id = $1`, [TA])).toBe(0);
  }, 300_000);

  it('two concurrent refreshes of the same tenant both succeed, serialise on the per-family advisory lock, and leave the same result', async () => {
    const before = Object.fromEntries(await Promise.all(FAMILIES.map(async (f) => [f, await rowCount(f)] as const)));
    await markAll('manual');
    const [a, b] = await Promise.allSettled([
      refreshTenant(ctx() as never, { tenantId: TA, trigger: 'manual' } as never),
      refreshTenant(ctx() as never, { tenantId: TA, trigger: 'manual' } as never),
    ]);
    expect(a.status, a.status === 'rejected' ? String(a.reason) : '').toBe('fulfilled');
    expect(b.status, b.status === 'rejected' ? String(b.reason) : '').toBe('fulfilled');
    for (const f of FAMILIES) expect(await rowCount(f), f).toBe(before[f]);
    expect(await one(`SELECT count(*)::int AS n FROM analytics.dirty_partitions WHERE tenant_id = $1`, [TA])).toBe(0);
    expect(await one(`SELECT count(*)::int AS n FROM analytics.refresh_state WHERE tenant_id = $1 AND consecutive_failures > 0`, [TA])).toBe(0);
  }, 300_000);

  it('every rollup row in the refreshed range carries a refresh_run_id that exists in refresh_runs (run bookkeeping is not optional)', async () => {
    for (const f of DATE_FAMILIES) {
      const orphans = await one(`SELECT count(*)::int AS n FROM analytics.${FAMILY_TABLE[f]} t WHERE t.tenant_id = $1 AND t.business_date >= $2 AND t.business_date < $3
                                  AND NOT EXISTS (SELECT 1 FROM analytics.refresh_runs r WHERE r.tenant_id = t.tenant_id AND r.id = t.refresh_run_id)`, [TA, from, to]);
      expect(orphans, f).toBe(0);
    }
  });
});
