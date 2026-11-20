// T0B-SYNC-5 done_when (4) OBSERVABILITY (gauges): backlog age per device, conflict inbox size and recall count, exposed through the existing metrics path (core/observability/metrics.ts,
// rendered by createMetrics().render()). The accepted / duplicate / rejected / conflict counters are lims_core_sync_operations_total{status} and are proved in ./chaos.live.test.ts.
// Live PG17, the function runs as lims_api under RLS (a worker task passes its own tx). PINNED SURFACE: ./kit.ts header (refreshSyncGauges in services/api/src/core/sync/metrics.ts).
// Absolute numbers would be polluted by rows other test files leave in tenant_a / tenant_b, so every count is compared with an independent owner side query and with exact DELTAS of seeded rows.
// Fails today: services/api/src/core/sync/metrics.ts and the three gauges in observability/metrics.ts do not exist.
import { beforeAll, describe, expect, it } from 'vitest';
import { createMetrics } from '../../../observability/metrics.js';
import { A1, B1, TENANT_A, TENANT_B, USER, ensureS5, newDevice, ownerRows, superTx, uid, withCtx } from './kit.js';

const T = 300_000;
const NOWD = new Date('2026-11-18T12:00:00Z');
const GAUGES = { backlog: 'lims_core_sync_device_backlog_age_seconds', conflicts: 'lims_core_sync_conflicts_open', recalls: 'lims_core_sync_print_recalls' } as const;
beforeAll(ensureS5);

async function refresh(who: typeof A1, tenantId: string) {
  const reg = createMetrics();
  const mod: any = await import('../../metrics.js').catch(() => ({}));
  expect(typeof mod.refreshSyncGauges, 'services/api/src/core/sync/metrics.ts must export refreshSyncGauges').toBe('function');
  const o = await withCtx(who, (ctx: any) => mod.refreshSyncGauges(ctx.tx, reg, { tenantId, now: NOWD }));
  if (o.error) throw o.error;
  return reg;
}
/** [labels, value] of every sample of `name` in the rendered exposition text. */
async function samples(reg: ReturnType<typeof createMetrics>, name: string): Promise<Array<{ labels: Record<string, string>; value: number }>> {
  const text = await reg.render();
  return [...text.matchAll(new RegExp(`^${name}(?:\\{([^}]*)\\})? (\\S+)$`, 'gm'))].map((m) => ({
    labels: Object.fromEntries([...(m[1] ?? '').matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1]!, x[2]!])), value: Number(m[2]),
  }));
}
const forTenant = async (reg: ReturnType<typeof createMetrics>, name: string, tenant: string) => (await samples(reg, name)).filter((s) => s.labels.tenant_id === tenant);

async function seedOp(tenant: string, device: string, user: string, type: string, status = 'accepted'): Promise<string> {
  const id = uid();
  await superTx((tx) => tx.query(
    `INSERT INTO core.sync_operation (tenant_id, op_id, device_id, user_id, op_type, payload_hash, payload, device_created_at, server_received_at, status, result)
     VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, now(), now(), $7, $8::jsonb)`, [tenant, id, device, user, type, `h${id}`, status, JSON.stringify({ status })]), tenant);
  return id;
}
const seedOpenConflict = async (tenant: string, device: string, user: string): Promise<string> => {
  const op = await seedOp(tenant, device, user, 'result.enter', 'conflict'); const id = uid();
  await superTx((tx) => tx.query(
    `INSERT INTO core.sync_conflict (id, tenant_id, op_id, entity_type, entity_id, local_payload, server_payload, created_by, updated_by) VALUES ($1, $2, $3, 'order', $4, '{}'::jsonb, '{}'::jsonb, $5, $5)`,
    [id, tenant, op, uid(), user]), tenant);
  return id;
};
const ownerCount = async (sql: string, tenant: string): Promise<number> => Number((await ownerRows(sql, [tenant]))[0].n);
const OPEN = `SELECT count(*)::int AS n FROM core.sync_conflict WHERE tenant_id = $1 AND status = 'open'`;
const RECALLS = `SELECT count(*)::int AS n FROM core.sync_print_marker WHERE tenant_id = $1 AND state = 'recall_required'`;

describe('conflict inbox size (lims_core_sync_conflicts_open)', () => {
  it('equals the open conflicts of the tenant (independent owner side count), moves by exactly the seeded delta, drops when a conflict is resolved, is set (not added) on every refresh', async () => {
    const dev = await newDevice(A1);
    const base = await ownerCount(OPEN, TENANT_A);
    expect((await forTenant(await refresh(A1, TENANT_A), GAUGES.conflicts, TENANT_A)).map((s) => s.value)).toEqual([base]);
    const c1 = await seedOpenConflict(TENANT_A, dev, USER.a1); await seedOpenConflict(TENANT_A, dev, USER.a1);
    const reg = await refresh(A1, TENANT_A);
    expect((await forTenant(reg, GAUGES.conflicts, TENANT_A)).map((s) => s.value)).toEqual([base + 2]);
    await refresh(A1, TENANT_A);                                                              // a second refresh on a NEW registry: same number (the function is a snapshot, not an increment)
    await superTx((tx) => tx.query(`UPDATE core.sync_conflict SET status = 'resolved', resolution = 'keep_server', resolved_by = $2, resolved_at = now(), reason = 'resolved (synthetic)', updated_at = now() WHERE id = $1`, [c1, USER.a1]), TENANT_A);
    expect((await forTenant(await refresh(A1, TENANT_A), GAUGES.conflicts, TENANT_A)).map((s) => s.value)).toEqual([base + 1]);
  }, T);

  it('reports the tenant it is called for and no other: a refresh of tenant A carries no tenant B label; tenant B has its own, exact, value (0 is reported, not omitted)', async () => {
    const reg = await refresh(A1, TENANT_A);
    expect((await samples(reg, GAUGES.conflicts)).every((s) => s.labels.tenant_id === TENANT_A)).toBe(true);
    expect((await samples(reg, GAUGES.recalls)).every((s) => s.labels.tenant_id === TENANT_A)).toBe(true);
    expect((await samples(reg, GAUGES.backlog)).every((s) => s.labels.tenant_id === TENANT_A)).toBe(true);
    const regB = await refresh(B1, TENANT_B);
    expect((await forTenant(regB, GAUGES.conflicts, TENANT_B)).map((s) => s.value)).toEqual([await ownerCount(OPEN, TENANT_B)]);
    expect((await forTenant(regB, GAUGES.recalls, TENANT_B)).map((s) => s.value)).toEqual([await ownerCount(RECALLS, TENANT_B)]);
  }, T);
});

describe('recall count (lims_core_sync_print_recalls)', () => {
  it('counts the print markers in state recall_required of the tenant; pending and confirmed ones do not count', async () => {
    const dev = await newDevice(A1);
    const base = await ownerCount(RECALLS, TENANT_A);
    const mk = async (state: string) => {
      const op = await seedOp(TENANT_A, dev, USER.a1, 'report.print_marker');
      await superTx((tx) => tx.query(`INSERT INTO core.sync_print_marker (tenant_id, op_id, report_version_id, result_ids, device_id, state, device_created_at) VALUES ($1, $2, $3, $4::uuid[], $5, $6, now())`,
        [TENANT_A, op, uid(), [uid()], dev, state]), TENANT_A);
    };
    await mk('recall_required'); await mk('recall_required'); await mk('pending'); await mk('confirmed');
    expect((await forTenant(await refresh(A1, TENANT_A), GAUGES.recalls, TENANT_A)).map((s) => s.value)).toEqual([base + 2]);
  }, T);
});

describe('backlog age per device (lims_core_sync_device_backlog_age_seconds)', () => {
  const setDevice = (id: string, cols: { first: string; seen: string; sync: string | null; status?: string }) => superTx((tx) => tx.query(
    `UPDATE core.sync_device SET first_seen_at = $2, last_seen_at = $3, last_sync_at = $4, status = $5 WHERE id = $1`, [id, cols.first, cols.seen, cols.sync, cols.status ?? 'active']), TENANT_A);
  const iso = (hoursBefore: number): string => new Date(NOWD.getTime() - hoursBefore * 3_600_000).toISOString();

  it('an active device seen after its last sync reports now - last_sync_at in seconds; a device in sync reports 0; a never synced one counts from first_seen_at; a revoked one is not reported', async () => {
    const [d1, d2, d3, d4] = [await newDevice(A1), await newDevice(A1), await newDevice(A1), await newDevice(A1)];
    await setDevice(d1, { first: iso(30), seen: iso(1), sync: iso(2) });             // seen 1 h ago, last sync 2 h ago: backlog 2 h
    await setDevice(d2, { first: iso(30), seen: iso(1), sync: iso(1) });             // in sync
    await setDevice(d3, { first: iso(3), seen: iso(0.5), sync: null });              // never synced, seen since first contact: 3 h
    await setDevice(d4, { first: iso(30), seen: iso(1), sync: iso(2), status: 'revoked' });
    const rows = await samples(await refresh(A1, TENANT_A), GAUGES.backlog);
    const of = (id: string) => rows.filter((s) => s.labels.device_id === id && s.labels.tenant_id === TENANT_A).map((s) => s.value);
    expect(of(d1)).toEqual([7200]); expect(of(d2)).toEqual([0]); expect(of(d3)).toEqual([10_800]); expect(of(d4)).toEqual([]);
  }, T);

  it('never negative (a device clock or a row in the future of `now` reports 0), one sample per device, only the two labels tenant_id and device_id', async () => {
    const d = await newDevice(A1);
    await setDevice(d, { first: iso(-5), seen: iso(-3), sync: iso(-4) });            // all after `now`
    const rows = await samples(await refresh(A1, TENANT_A), GAUGES.backlog);
    expect(rows.length).toBeGreaterThan(0);
    for (const s of rows) { expect(s.value).toBeGreaterThanOrEqual(0); expect(Object.keys(s.labels).sort()).toEqual(['device_id', 'tenant_id']); }
    expect(rows.filter((s) => s.labels.device_id === d).map((s) => s.value)).toEqual([0]);
    const ids = rows.map((s) => s.labels.device_id); expect(new Set(ids).size).toBe(ids.length);
  }, T);

  it('devices of another tenant are never reported to this tenant (RLS)', async () => {
    const dB = await newDevice(B1);
    const rows = await samples(await refresh(A1, TENANT_A), GAUGES.backlog);
    expect(rows.some((s) => s.labels.device_id === dB)).toBe(false);
  }, T);
});
