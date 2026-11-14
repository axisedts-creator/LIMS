// AN-T04 services/worker/src/jobs/analytics/tasks/refresh_tenant.ts (02-TRD §9.3 `analytics.refresh_tenant`, max_attempts 5; §9.4 manifest).
// ASSUMED API: `export const refreshTenantTask: TaskHandler` (payload `{ tenant_id }`, ctx = JobContext) - a thin wrapper over
// api/.../service/refresh.service.refreshTenant(ctx, { tenantId, trigger: 'event' }); index.ts registers it under 'analytics.refresh_tenant' (replacing the AN-T01 stub).
// The engine itself is proven in api/.../service/__tests__/refresh.service.test.ts; here: wiring, payload trust, fail-open/closed behaviour.
import { describe, expect, it } from 'vitest';
import { createCtx, createFakeDb } from '../../../../../api/src/modules/analytics/service/__tests__/refreshFake.js';
import { manifest } from '../index.js';
import { refreshTenantTask } from '../tasks/refresh_tenant.js';

const TA = '01a1a98a-ac40-7000-8000-00000000a001', TB = '01a1a98a-ac40-7000-8000-00000000b001';
const mark = (tenant: string, family: 'income' | 'results', date = '2026-11-01') => ({ tenant, family, date });

describe('manifest wiring', () => {
  it("'analytics.refresh_tenant' is the real task, not the fail-closed AN-T01 stub; max_attempts stays 5", () => {
    expect(manifest.tasks!['analytics.refresh_tenant']).toBe(refreshTenantTask);
    expect(manifest.maxAttempts!['analytics.refresh_tenant']).toBe(5);
    expect(Object.keys(manifest.tasks!)).toHaveLength(8);
  });
});

describe('refreshTenantTask', () => {
  it('processes the payload tenant\'s dirty partitions: replaces the table, consumes the marks, records success', async () => {
    const f = createFakeDb({ marks: [mark(TA, 'income'), mark(TB, 'results')] });
    await refreshTenantTask({ tenant_id: TA }, createCtx(f, { tenantId: TA }) as never);
    expect(f.committed('replace').map((e) => e.table)).toEqual(['daily_income']);
    expect([...f.model.marks.keys()]).toEqual([`${TB}|results|2026-11-01`]);          // the other tenant's mark is not touched
    expect(f.committed('state_success').map((e) => e.family)).toEqual(['income']);
  });

  it('a payload tenant that differs from the job\'s tenant context is refused before any statement (no cross-tenant refresh by payload)', async () => {
    const f = createFakeDb({ marks: [mark(TA, 'income'), mark(TB, 'income')] });
    await expect(refreshTenantTask({ tenant_id: TB }, createCtx(f, { tenantId: TA }) as never)).rejects.toBeTruthy();
    expect(f.log).toEqual([]);
    expect(f.model.marks.size).toBe(2);
  });

  it('missing / non-uuid / non-string tenant_id is refused before any statement', async () => {
    for (const payload of [{}, { tenant_id: '' }, { tenant_id: 'nope' }, { tenant_id: 42 }, { tenant_id: ["' OR 1=1"] }, { tenantId: TA }]) {
      const f = createFakeDb({ marks: [mark(TA, 'income')] });
      await expect(refreshTenantTask(payload as never, createCtx(f, { tenantId: TA }) as never)).rejects.toBeTruthy();
      expect(f.log).toEqual([]);
    }
  });

  it('unknown extra payload fields are ignored (they never reach SQL)', async () => {
    const f = createFakeDb({ marks: [mark(TA, 'income')] });
    await refreshTenantTask({ tenant_id: TA, family: "income'; DROP TABLE x;--", from: '1999-01-01' } as never, createCtx(f, { tenantId: TA }) as never);
    expect(f.committed('replace')).toHaveLength(1);
    for (const l of f.log) expect(l.text + JSON.stringify(l.values)).not.toMatch(/DROP TABLE|1999-01-01/);
  });

  it('a failing family makes the task reject (so Graphile backs off and retries, max 5); marks and old partition stay', async () => {
    const f = createFakeDb({
      marks: [mark(TA, 'income')],
      hook: (a) => { if (a.kind === 'insertRollup') throw Object.assign(new Error('boom'), { code: '57014' }); },
    });
    await expect(refreshTenantTask({ tenant_id: TA }, createCtx(f, { tenantId: TA }) as never)).rejects.toMatchObject({ code: '57014' });
    expect(f.model.marks.size).toBe(1);
    expect(f.model.partitions.get('daily_income') ?? 'old').toBe('old');
    expect(f.committed('state_failure')).toHaveLength(1);
  });

  it('nothing dirty -> resolves without writing', async () => {
    const f = createFakeDb();
    await expect(refreshTenantTask({ tenant_id: TA }, createCtx(f, { tenantId: TA }) as never)).resolves.toBeUndefined();
    expect(f.log.some((l) => ['replaceDelete', 'insertRollup', 'deleteMarks', 'stateUpsert', 'runInsert', 'runUpdate'].includes(l.kind))).toBe(false);
  });
});
