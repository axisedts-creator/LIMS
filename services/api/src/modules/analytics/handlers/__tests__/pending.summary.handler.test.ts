// C8 AN-T13 — getPendingTestsSummary (GET /v1/analytics/reports/pending-tests/summary). PRD US-10.1, 10.2, 10.4, 10.5; 02-TRD §5 #11, §5.1 PendingSummary, §6.7; 08 A13 D-13, A17 D-49.
// sourceViews.repo (live lab.v_pub_pending_items under the caller's tx RLS), rollups.repo (analytics.report_backlog) and labels.repo are in-memory emulators (./helpers.t13.ts);
// handler + service + mapper + labels.service are real. Every expected number is hand-computed from the world documented in seedT13().
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  A1, A2, A3, B1, BR1, BR2, BRB, CENTRE_NAME, DEPT, ADMIN, OWNER_A1, OWNER_ALL, OWNER_MULTI, SENTINEL, TA, calls13, contractErrors13, expectLims, makeCtx13, call13, seedT13, summary13, t13,
} from './helpers.t13.js';

vi.mock('../../repository/sourceViews.repo.js', async () => (await import('./helpers.t13.js')).sourceViewsMockT13);
vi.mock('../../repository/rollups.repo.js', async () => (await import('./helpers.t13.js')).rollupsMockT13);
vi.mock('../../repository/labels.repo.js', async () => (await import('./helpers.t13.js')).labelsRepoMockT13);

beforeEach(() => { seedT13(); vi.clearAllMocks(); });

const counts = (xs: any[], key: string): Record<string, number> => Object.fromEntries(xs.filter((x) => x.count > 0).map((x) => [x[key], x.count]));
const live = (fn = 'pendingSummaryRows') => calls13.filter((c) => c.fn === fn);
const dept = (body: any) => Object.fromEntries(body.by_department.map((d: any) => [d.department_id, { label: d.label, count: d.count, overdue: d.overdue }]));
const centres = (body: any) => Object.fromEntries(body.backlog.by_centre.map((c: any) => [c.centre_id, [c.reports_pending, c.awaiting_results, c.ready_unreleased]]));

describe('US-10.1 — counts by item_status, department, priority and age bucket, live, from the caller\'s RLS view', () => {
  it('all-centre caller: exact totals over the 8 tenant-A items (tenant B never counted)', async () => {
    const body = await summary13((await makeCtx13(ADMIN)).ctx);
    expect(body.report_code).toBe('pending_tests');
    expect(body.total).toBe(8);
    expect(counts(body.by_status, 'item_status')).toEqual({ awaiting_collection: 1, awaiting_receipt: 1, in_process: 4, resulted: 1, verified: 1 });
    expect(counts(body.by_priority, 'priority')).toEqual({ routine: 6, urgent: 2 });
    expect(counts(body.by_age_bucket, 'bucket')).toEqual({ lt_4h: 3, h4_24: 2, d1_3: 1, gt_3d: 2 });
    expect(dept(body)).toEqual({ [DEPT.H]: { label: 'Haematology', count: 4, overdue: 2 }, [DEPT.B]: { label: 'Biochemistry', count: 4, overdue: 0 } });
    expect(JSON.stringify(body)).not.toContain(String(SENTINEL));
    expect(contractErrors13('getPendingTestsSummary', body)).toEqual([]);
  });

  it('age buckets: the boundary items land on the upper side — 14399 s (P7) lt_4h, 14400 s (P2) h4_24, 86400 s (P3) d1_3, 259200 s (P4) gt_3d (counts 3 / 2 / 1 / 2 would shift otherwise)', async () => {
    const body = await summary13((await makeCtx13(ADMIN)).ctx);
    expect(body.by_age_bucket.map((b: any) => b.bucket).sort()).toEqual(['d1_3', 'gt_3d', 'h4_24', 'lt_4h']);
    expect(counts(body.by_age_bucket, 'bucket')).toEqual({ lt_4h: 3, h4_24: 2, d1_3: 1, gt_3d: 2 });
  });

  it('the response carries no period, echoes the resolved scope, a generated_at, and the age-anchor label key (US-10.4)', async () => {
    const body = await summary13((await makeCtx13(ADMIN)).ctx);
    expect(body).not.toHaveProperty('period');
    expect(body.scope).toEqual({ all_centres: true, centre_ids: [], tenant_wide_sections_hidden: [] });
    expect(body.generated_at).toBe('2026-11-06T06:00:00.000Z');
    expect(body.age_anchor_note_key).toBe('analytics.pending.age_anchor');
    expect(Array.isArray(body.freshness)).toBe(true);
  });

  it('freshness (US-16.3): a pending_items entry, when present, is live and never stale', async () => {
    const body = await summary13((await makeCtx13(ADMIN)).ctx);
    for (const f of body.freshness.filter((x: any) => x.family === 'pending_items')) expect(f).toMatchObject({ live: true, is_stale: false });
  });

  it('an empty tenant answers zeros and empty lists, never nulls or a missing section', async () => {
    t13.items.length = 0;
    const body = await summary13((await makeCtx13(ADMIN)).ctx);
    expect(body).toMatchObject({ total: 0, overdue: 0, no_target: 0, by_status: [], by_priority: [], by_department: [], by_age_bucket: [] });
    expect(contractErrors13('getPendingTestsSummary', body)).toEqual([]);
  });
});

describe('US-10.2 — overdue = target present AND age > target; items without a target are "no target"', () => {
  it('overdue 2 (P2 14400 > 7200, P5 20000 > 10000); age == target (P4, P7) is NOT overdue; no_target 2 (P3, P6); a no-target item is never overdue', async () => {
    const body = await summary13((await makeCtx13(ADMIN)).ctx);
    expect(body.overdue).toBe(2);
    expect(body.no_target).toBe(2);
    expect(body.overdue + body.no_target).toBeLessThanOrEqual(body.total);
  });

  it('per-department overdue is a subset of that department\'s count', async () => {
    const body = await summary13((await makeCtx13(ADMIN)).ctx);
    for (const d of body.by_department) expect(d.overdue).toBeLessThanOrEqual(d.count);
    expect(body.by_department.reduce((s: number, d: any) => s + d.overdue, 0)).toBe(body.overdue);
  });
});

describe('US-10.1 / D-49 / D-13 — centre scope comes ONLY from the C5 policy of the caller\'s tx: no implicit centre predicate', () => {
  it('restricted caller {A1} sees the item collected at A3 but received at its hub A1 (D-13) — total 5, not 4', async () => {
    const body = await summary13((await makeCtx13(OWNER_A1)).ctx);
    expect(body.total).toBe(5);                                         // P1 P2 P5 P7 P8; P5 is collected at A3
    expect(body.overdue).toBe(2);                                       // P2 and the hub item P5
    expect(counts(body.by_status, 'item_status')).toEqual({ awaiting_receipt: 1, in_process: 4 });
    expect(dept(body)).toEqual({ [DEPT.H]: { label: 'Haematology', count: 4, overdue: 2 }, [DEPT.B]: { label: 'Biochemistry', count: 1, overdue: 0 } });
    expect(contractErrors13('getPendingTestsSummary', body)).toEqual([]);
  });

  it('the repo is called WITHOUT a centre predicate (centreIds undefined) for restricted and all-centre callers alike', async () => {
    for (const actor of [OWNER_A1, OWNER_MULTI, ADMIN, OWNER_ALL]) {
      calls13.length = 0;
      await summary13((await makeCtx13(actor)).ctx);
      expect(live(), actor).toHaveLength(1);
      expect(live()[0]!.args.centreIds, actor).toBeUndefined();
      expect(live()[0]!.args.tenantId).toBe(TA);
    }
  });

  it('restricted caller {A1, A2} sees P1–P5, P7, P8 (7) but not P6 (A3 collected and received)', async () => {
    const body = await summary13((await makeCtx13(OWNER_MULTI)).ctx);
    expect(body.total).toBe(7);
    expect(body.no_target).toBe(1);                                     // P3 only: P6 is invisible
    expect(counts(body.by_priority, 'priority')).toEqual({ routine: 6, urgent: 1 });
  });

  it('the live read runs in the request tx (ctx.tx) — the same object that carries the caller\'s RLS context — exactly once', async () => {
    const { ctx, tx } = await makeCtx13(OWNER_A1);
    await summary13(ctx);
    expect(live()).toHaveLength(1);
    expect(live()[0]!.tx).toBe(tx);
  });

  it('the answer is the policy\'s answer, not a post-filter: two callers with different RLS contexts differ for the same query', async () => {
    const a = await summary13((await makeCtx13(OWNER_A1)).ctx);
    const all = await summary13((await makeCtx13(OWNER_ALL)).ctx);
    expect(a.total).toBeLessThan(all.total);
    expect(all.total).toBe(8);
  });
});

describe('explicit filters (ScopeQuery centre_id / branch_id, department_id, priority, processing_branch_id)', () => {
  it('centre_id=A1 adds the predicate centre_id = ANY([A1]) on the COLLECTION centre: the hub-received P5 (collected at A3) drops out, for the admin and for the {A1} caller alike', async () => {
    for (const actor of [ADMIN, OWNER_A1]) {
      calls13.length = 0;
      const body = await summary13((await makeCtx13(actor)).ctx, { centre_id: [A1] });
      expect(live()[0]!.args.centreIds, actor).toEqual([A1]);
      expect(body.total, actor).toBe(4);                                // P1 P2 P7 P8
      expect(body.overdue, actor).toBe(1);                              // P2
      expect(body.scope.centre_ids, actor).toEqual([A1]);
    }
  });

  it('centre_id=A2 for the admin: P3 and P4 only; the backlog narrows to the same centre', async () => {
    const body = await summary13((await makeCtx13(ADMIN)).ctx, { centre_id: [A2] });
    expect(body.total).toBe(2);
    expect(body.no_target).toBe(1);
    expect(centres(body)).toEqual({ [A2]: [5, 4, 1] });
  });

  it('branch_id=BR1 (centres A1, A2) → predicate over those centres: P1 P2 P3 P4 P7 P8 (6); P5 (centre A3) is out', async () => {
    const body = await summary13((await makeCtx13(ADMIN)).ctx, { branch_id: [BR1] });
    expect([...live()[0]!.args.centreIds].sort()).toEqual([A1, A2].sort());
    expect(body.total).toBe(6);
  });

  it('a branch never widens a restricted caller: {A1} + branch BR1 → centres [A1] only; {A1} + branch BR2 → empty predicate [] → nothing (never "no predicate")', async () => {
    const one = await summary13((await makeCtx13(OWNER_A1)).ctx, { branch_id: [BR1] });
    expect(live()[0]!.args.centreIds).toEqual([A1]);
    expect(one.total).toBe(4);
    calls13.length = 0;
    const none = await summary13((await makeCtx13(OWNER_A1)).ctx, { branch_id: [BR2] });
    expect(none.total).toBe(0);
    for (const c of live()) expect(c.args.centreIds).toEqual([]);       // a service may also skip the query; if it asks, the predicate is the empty list
  });

  it('a centre outside the caller\'s scope, a foreign-tenant centre and a foreign branch are 404 common.not_found, with no live read', async () => {
    for (const [actor, q] of [[OWNER_A1, { centre_id: [A3] }], [OWNER_A1, { centre_id: [A2] }], [ADMIN, { centre_id: [B1] }], [ADMIN, { branch_id: [BRB] }]] as const) {
      calls13.length = 0;
      await expectLims(call13('getPendingTestsSummary', (await makeCtx13(actor)).ctx, q), 'common.not_found', 404);
      expect(live(), JSON.stringify(q)).toHaveLength(0);
    }
  });

  it('department_id, priority and processing_branch_id are passed as filters and narrow the answer', async () => {
    const d = await summary13((await makeCtx13(ADMIN)).ctx, { department_id: [DEPT.B] });
    expect(live()[0]!.args.departmentIds).toEqual([DEPT.B]);
    expect(d.total).toBe(4);                                            // P3 P4 P6 P8
    const p = await summary13((await makeCtx13(ADMIN)).ctx, { priority: 'urgent' });
    expect(live().at(-1)!.args.priority).toBe('urgent');
    expect(p.total).toBe(2);                                            // P2 P6
    const b = await summary13((await makeCtx13(ADMIN)).ctx, { processing_branch_id: [BR1] });
    expect(live().at(-1)!.args.processingBranchIds).toEqual([BR1]);
    expect(b.total).toBe(6);                                            // P1 P2 P3 P4 P5 P8; P7 has no processing branch, P6 is BR2
  });

  it('an unknown / other-tenant processing_branch_id is 404 common.not_found (id never echoed)', async () => {
    for (const id of [BRB, '00000000-0000-4000-8000-0000000000ff']) {
      const e = await expectLims(call13('getPendingTestsSummary', (await makeCtx13(ADMIN)).ctx, { processing_branch_id: [id] }), 'common.not_found', 404);
      expect(JSON.stringify({ m: e.message, d: e.details })).not.toContain(id);
    }
  });

  it('closed lists and size limits are enforced before any lookup: priority "normal", 51 departments, 21 processing branches, 21 centres → 400 common.validation_failed', async () => {
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const bad: Record<string, unknown>[] = [
      { priority: 'normal' }, { department_id: Array.from({ length: 51 }, (_, i) => uuid(i + 1)) },
      { processing_branch_id: Array.from({ length: 21 }, (_, i) => uuid(i + 1)) }, { centre_id: Array.from({ length: 21 }, (_, i) => uuid(i + 1)) },
    ];
    for (const q of bad) {
      calls13.length = 0;
      await expectLims(call13('getPendingTestsSummary', (await makeCtx13(ADMIN)).ctx, q), 'common.validation_failed', 400);
      expect(calls13, Object.keys(q)[0]).toHaveLength(0);
    }
  });
});

describe('US-10.5 — reports pending (M52) = awaiting results (M53) + ready but unreleased (M54), from the report_backlog snapshot under the normal scope rules', () => {
  it('all-centre caller: reports_pending 16 = awaiting 13 + ready 3; oldest registered 2026-10-20; per-centre split with centre labels', async () => {
    const body = await summary13((await makeCtx13(ADMIN)).ctx);
    expect(body.backlog).toMatchObject({ reports_pending: 16, awaiting_results: 13, ready_unreleased: 3, oldest_registered_at: '2026-10-20T00:00:00.000Z' });
    expect(centres(body)).toEqual({ [A1]: [5, 3, 2], [A2]: [5, 4, 1], [A3]: [6, 6, 0] });
    for (const c of body.backlog.by_centre) expect(c.label).toBe(CENTRE_NAME(c.centre_id));
    expect(body.backlog.reports_pending).toBe(body.backlog.awaiting_results + body.backlog.ready_unreleased);
    expect(JSON.stringify(body)).not.toContain(String(SENTINEL));
  });

  it('restricted caller {A1}: the snapshot follows the SCOPE (centre list), not the live RLS — 5 / 3 / 2, A1 only, oldest 2026-11-05T09:00', async () => {
    const { ctx, tx } = await makeCtx13(OWNER_A1);
    const body = await summary13(ctx);
    expect(body.backlog).toMatchObject({ reports_pending: 5, awaiting_results: 3, ready_unreleased: 2, oldest_registered_at: '2026-11-05T09:00:00.000Z' });
    expect(centres(body)).toEqual({ [A1]: [5, 3, 2] });
    const b = calls13.filter((c) => c.fn === 'backlogRows');
    expect(b).toHaveLength(1);
    expect(b[0]!.args).toMatchObject({ tenantId: TA, scope: { all: false, centreIds: [A1] } });
    expect(b[0]!.tx).toBe(tx);
  });

  it('all-centre caller: scope {all: true} reaches the snapshot read', async () => {
    await summary13((await makeCtx13(ADMIN)).ctx);
    expect(calls13.find((c) => c.fn === 'backlogRows')!.args.scope).toEqual({ all: true, centreIds: [] });
  });

  it('no backlog rows: zeros, an empty by_centre and NO oldest_registered_at key (omitted, not null)', async () => {
    t13.backlog.length = 0;
    const body = await summary13((await makeCtx13(ADMIN)).ctx);
    expect(body.backlog).toEqual({ reports_pending: 0, awaiting_results: 0, ready_unreleased: 0, by_centre: [] });
    expect(contractErrors13('getPendingTestsSummary', body)).toEqual([]);
  });
});
