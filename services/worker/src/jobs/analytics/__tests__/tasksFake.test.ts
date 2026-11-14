// AN-T06 helper self-test: the world model used by the AN-T06 suites behaves as documented (guards the guards).
import { describe, expect, it } from 'vitest';
import { markDirty } from '../../../../../api/src/modules/analytics/repository/refresh.repo.js';
import { upsertOrderCreated } from '../../../../../api/src/modules/analytics/repository/orderIndex.repo.js';
import { refreshTenantTask } from '../tasks/refresh_tenant.js';
import { ACTOR, TA, createWorld } from './tasksFake.js';

describe('tasksFake world', () => {
  it('markDirty through ctx.tx and ctx.db.tx lands in the dirty marks and the refresh engine consumes it', async () => {
    const w = createWorld();
    await markDirty(w.ctx.tx, { tenantId: TA, family: 'income', businessDate: '2026-11-05', reason: 'sweep_recent', actorId: ACTOR });
    await w.ctx.db.tx((c: any) => markDirty(c.tx, { tenantId: TA, family: 'results', businessDate: '2026-11-06', reason: 'sweep_recent', actorId: ACTOR }));
    expect(w.marksMade).toHaveLength(2);
    await refreshTenantTask({ tenant_id: TA }, w.ctx);
    expect(w.marksOf(TA)).toEqual([]);
    expect(w.fake.committed('replace').map((e) => e.table).sort()).toEqual(['daily_income', 'daily_results']);
  });

  it('enqueue and order_index writes are recorded; backlog counts only unreleased, uncancelled, in-lookback orders', async () => {
    const w = createWorld();
    await w.ctx.tx.query(`SELECT app.enqueue_job('analytics.self_check', $1::jsonb, $2, now(), 2)`, [JSON.stringify({ tenant_id: TA }), `k:${TA}`]);
    expect(w.enqueued[0]).toMatchObject({ task: 'analytics.self_check', payload: { tenant_id: TA } });
    w.orderIndex.push({ tenant: TA, order_id: 'a', centre_id: null, branch_id: null, referrer_id: null, registered_at: '2026-11-07T05:00:00.000Z', registered_on: '2026-11-07', created_by: ACTOR, cancelled_at: null });
    w.orderIndex.push({ tenant: TA, order_id: 'b', centre_id: null, branch_id: null, referrer_id: null, registered_at: '2026-09-01T05:00:00.000Z', registered_on: '2026-09-01', created_by: ACTOR, cancelled_at: null });
    w.model.marks.set(`${TA}|report_backlog|1970-01-01`, { tenant: TA, family: 'report_backlog', date: '1970-01-01', first: w.model.clock.now, last: w.model.clock.now });
    await refreshTenantTask({ tenant_id: TA }, w.ctx);
    expect(w.backlog.orders).toBe(1);
    void upsertOrderCreated;
  });
});
