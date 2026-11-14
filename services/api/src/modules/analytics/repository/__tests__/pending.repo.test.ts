// C8 AN-T13 — live pending reads + backlog snapshot SQL (02-TRD §6.7; 07-SECURITY P1, P4, injection; 08 A17 D-49). Fake tx records (text, values).
// SEAMS (writer may dispute; mirrored in handlers/__tests__/helpers.t13.ts):
//   sourceViews.repo.pendingSummaryRows(tx, { tenantId, centreIds?, departmentIds?, priority?, processingBranchIds? }) -> [{ item_status, priority, department_id, age_bucket, n, overdue, no_target }]
//   sourceViews.repo.pendingItems(tx, { tenantId, centreIds?, departmentIds?, priority?, processingBranchIds?, itemStatuses?, overdueOnly?, sort, after?, limit }) -> PendingItem rows
//   rollups.repo.backlogRows(tx, { tenantId, scope }) -> [{ centre_id, stage, orders, oldest_registered_at }]   (analytics.report_backlog, scope $all / $centres as every rollup)
// D-49: no implicit centre predicate — centre_id appears in the live SQL ONLY when an explicit centreIds filter is given.
import { describe, expect, it } from 'vitest';
import * as sv from '../sourceViews.repo.js';
import * as rollups from '../rollups.repo.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const C1 = '22222222-2222-4222-8222-222222222221';
const C2 = '22222222-2222-4222-8222-222222222222';
const D1 = '44444444-4444-4444-8444-444444444441';
const BR = '33333333-3333-4333-8333-333333333331';
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
function fakeTx(rows: any[] = []) {
  const calls: { text: string; values: unknown[] }[] = [];
  return { calls, async query(text: string, values: unknown[] = []) { calls.push({ text, values }); return { rows }; } };
}
const summary = (tx: any, over: Record<string, unknown> = {}) => (sv as any).pendingSummaryRows(tx, { tenantId: TENANT, ...over });
const list = (tx: any, over: Record<string, unknown> = {}) => (sv as any).pendingItems(tx, { tenantId: TENANT, sort: '-age_seconds', limit: 51, ...over });
const sql0 = (tx: { calls: { text: string }[] }) => norm(tx.calls[0]!.text);

describe('pendingSummaryRows — TRD §6.7 SQL', () => {
  it('exists; reads lab.v_pub_pending_items with tenant $1 and the closed bucket CASE (14400 / 86400 / 259200), overdue and no_target FILTERs, GROUP BY 1,2,3,4', async () => {
    expect(typeof (sv as any).pendingSummaryRows).toBe('function');
    const tx = fakeTx();
    await summary(tx);
    expect(tx.calls).toHaveLength(1);
    const s = sql0(tx);
    expect(s).toContain('from lab.v_pub_pending_items');
    expect(s).toContain('tenant_id = $1');
    expect(tx.calls[0]!.values[0]).toBe(TENANT);
    expect(s).toMatch(/age_seconds < 14400 then 'lt_4h'/);
    expect(s).toMatch(/age_seconds < 86400 then 'h4_24'/);
    expect(s).toMatch(/age_seconds < 259200 then 'd1_3'/);
    expect(s).toMatch(/else 'gt_3d'/);
    expect(s).toMatch(/count\(\*\) filter \(where tat_target_seconds is not null and age_seconds > tat_target_seconds\)/);
    expect(s).toMatch(/count\(\*\) filter \(where tat_target_seconds is null\)/);
    expect(s).toMatch(/group by 1, ?2, ?3, ?4/);
    expect(s).not.toContain('select *');
  });

  it('D-49: with no explicit centre filter there is NO centre predicate and no scope parameter at all (centre scope = C5 RLS only)', async () => {
    const tx = fakeTx();
    await summary(tx);
    expect(sql0(tx)).not.toMatch(/centre_id/);
    expect(tx.calls[0]!.values).toEqual([TENANT]);
  });

  it('an explicit centreIds filter adds centre_id = ANY (bound array); never interpolated; no "all-centres or" scope shortcut', async () => {
    const tx = fakeTx();
    await summary(tx, { centreIds: [C1, C2] });
    const s = sql0(tx);
    expect(s).toMatch(/centre_id = any \(\$\d+\)/);
    expect(s).not.toMatch(/centre_id is not null/);
    expect(tx.calls[0]!.values).toContainEqual([C1, C2]);
    expect(tx.calls[0]!.text).not.toContain(C1);
  });

  it('an explicit EMPTY centreIds matches nothing (never "no predicate")', async () => {
    const tx = fakeTx([{ item_status: 'in_process', priority: 'routine', department_id: D1, age_bucket: 'lt_4h', n: '9', overdue: '0', no_target: '0' }]);
    const out = await summary(tx, { centreIds: [] });
    if (tx.calls.length) expect(tx.calls[0]!.values).toContainEqual([]);
    else expect(out).toEqual([]);
    // a database given ANY('{}') answers no rows; with no query at all the repo itself must answer []
    if (!tx.calls.length) expect(out).toEqual([]);
  });

  it('filters are bound parameters, absent when not asked, and no value reaches the statement text', async () => {
    const none = fakeTx();
    await summary(none);
    expect(sql0(none)).not.toMatch(/department_id = any|priority =|processing_branch_id/);
    const all = fakeTx();
    await summary(all, { departmentIds: [D1], priority: 'urgent', processingBranchIds: [BR] });
    const s = sql0(all);
    expect(s).toMatch(/department_id = any \(\$\d+\)/);
    expect(s).toMatch(/priority = \$\d+/);
    expect(s).toMatch(/processing_branch_id = any \(\$\d+\)/);
    for (const v of [D1, BR, 'urgent']) expect(all.calls[0]!.text).not.toContain(v);
    expect(all.calls[0]!.values).toEqual(expect.arrayContaining([TENANT, [D1], 'urgent', [BR]]));
  });

  it('bigint counts arrive as strings and come back as safe integers; a count beyond 2^53 is refused, never rounded', async () => {
    const row = { item_status: 'in_process', priority: 'routine', department_id: D1, age_bucket: 'lt_4h', n: '12', overdue: '3', no_target: '1' };
    expect(await summary(fakeTx([row]))).toEqual([{ ...row, n: 12, overdue: 3, no_target: 1 }]);
    await expect(summary(fakeTx([{ ...row, n: '9007199254740993' }]))).rejects.toThrow(RangeError);
  });

  it('a missing tenant throws before any query', async () => {
    const tx = fakeTx();
    await expect((sv as any).pendingSummaryRows(tx, {})).rejects.toThrow();
    expect(tx.calls).toEqual([]);
  });
});

describe('pendingItems — TRD §6.7 list SQL', () => {
  it('reads lab.v_pub_pending_items, tenant $1, ORDER BY age_seconds DESC, order_item_id, LIMIT bound; explicit columns, no select *', async () => {
    expect(typeof (sv as any).pendingItems).toBe('function');
    const tx = fakeTx();
    await list(tx);
    const s = sql0(tx);
    expect(s).toContain('from lab.v_pub_pending_items');
    expect(s).toContain('tenant_id = $1');
    expect(s).toMatch(/order by age_seconds desc, order_item_id( asc)?(?! desc)/);
    expect(s).toMatch(/limit \$\d+/);
    expect(tx.calls[0]!.values).toContain(51);
    expect(s).not.toContain('select *');
    for (const c of ['order_item_id', 'order_id', 'centre_id', 'processing_branch_id', 'department_id', 'test_id', 'priority', 'item_status', 'age_seconds', 'tat_target_seconds']) expect(s).toContain(c);
  });

  it('the view is read alone: no join to patient / specimen / result tables, no patient column selected', async () => {
    const tx = fakeTx();
    await list(tx, { overdueOnly: true, itemStatuses: ['in_process'] });
    expect(sql0(tx)).not.toMatch(/\bjoin\b|patient|barcode|registration|specimen_id|result/);
  });

  it('sort age_seconds flips the first key to ASC (ties still by order_item_id ASC); any other sort is refused before a query', async () => {
    const tx = fakeTx();
    await list(tx, { sort: 'age_seconds' });
    expect(sql0(tx)).toMatch(/order by age_seconds asc, order_item_id/);
    const bad = fakeTx();
    for (const sort of ['order_id', 'age_seconds; drop table x', undefined, '']) await expect(list(bad, { sort })).rejects.toThrow();
    expect(bad.calls).toEqual([]);
  });

  it('keyset: after = { age_seconds, order_item_id } becomes a row comparison / OR-pair with both values bound — descending: age < $a OR (age = $a AND id > $b)', async () => {
    const tx = fakeTx();
    await list(tx, { after: { age_seconds: 86400, order_item_id: D1 } });
    const s = sql0(tx);
    expect(s).toMatch(/age_seconds < \$\d+ or \(age_seconds = \$\d+ and order_item_id > \$\d+\)/);
    expect(tx.calls[0]!.values).toEqual(expect.arrayContaining([86400, D1]));
    expect(tx.calls[0]!.text).not.toContain(D1);
    const asc = fakeTx();
    await list(asc, { sort: 'age_seconds', after: { age_seconds: 3600, order_item_id: D1 } });
    expect(norm(asc.calls[0]!.text)).toMatch(/age_seconds > \$\d+ or \(age_seconds = \$\d+ and order_item_id > \$\d+\)/);
  });

  it('D-49: no centre predicate unless centreIds is given; filters are bound; overdueOnly is the same age > target rule as the summary', async () => {
    const tx = fakeTx();
    await list(tx);
    expect(sql0(tx)).not.toMatch(/centre_id =|centre_id is not null/);
    const f = fakeTx();
    await list(f, { centreIds: [C1], departmentIds: [D1], priority: 'urgent', processingBranchIds: [BR], itemStatuses: ['in_process', 'resulted'], overdueOnly: true });
    const s = sql0(f);
    expect(s).toMatch(/centre_id = any \(\$\d+\)/);
    expect(s).toMatch(/item_status = any \(\$\d+\)/);
    expect(s).toMatch(/tat_target_seconds is not null and age_seconds > tat_target_seconds/);
    for (const v of [C1, D1, BR, 'urgent', 'in_process', 'resulted']) expect(f.calls[0]!.text).not.toContain(v);
  });

  it('a limit outside 1..201 or not an integer is refused before a query (the service asks for limit + 1)', async () => {
    const tx = fakeTx();
    for (const limit of [0, -1, 202, 1.5, NaN, '5']) await expect(list(tx, { limit })).rejects.toThrow();
    expect(tx.calls).toEqual([]);
  });

  it('returns bigint age_seconds / tat_target_seconds as safe integers and keeps a NULL target / processing branch as null', async () => {
    const row = { order_item_id: D1, order_id: D1, centre_id: C1, processing_branch_id: null, department_id: D1, test_id: D1, priority: 'routine', item_status: 'in_process', age_seconds: '3600', tat_target_seconds: null };
    const out = await list(fakeTx([row]));
    expect(out[0]).toMatchObject({ age_seconds: 3600, tat_target_seconds: null, processing_branch_id: null });
    await expect(list(fakeTx([{ ...row, age_seconds: '9007199254740993' }]))).rejects.toThrow(RangeError);
  });
});

describe('backlogRows — analytics.report_backlog snapshot (TRD §6.7 "Backlog"; §8.2)', () => {
  const run = (tx: any, scope: unknown) => (rollups as any).backlogRows(tx, { tenantId: TENANT, scope });

  it('exists; one bound SELECT: tenant $1 and the standard scope predicate ($all OR (centre_id IS NOT NULL AND centre_id = ANY(centres))), grouped by centre and stage', async () => {
    expect(typeof (rollups as any).backlogRows).toBe('function');
    const tx = fakeTx();
    await run(tx, { all: false, centreIds: [C1, C2] });
    expect(tx0(tx)).toContain('from analytics.report_backlog');
    expect(tx0(tx)).toContain('tenant_id = $1');
    expect(tx0(tx)).toMatch(/\$\d+ or \(centre_id is not null and centre_id = any \(\$\d+\)\)/);
    expect(tx0(tx)).toMatch(/group by/);
    expect(tx0(tx)).not.toContain('select *');
    expect(tx.calls[0]!.values).toEqual(expect.arrayContaining([TENANT, false, [C1, C2]]));
    expect(tx.calls[0]!.text).not.toContain(C1);
  });

  it('all-centre scope binds true and an empty list; an empty restricted scope sees nothing without widening; missing / malformed scope throws before a query', async () => {
    const all = fakeTx();
    await run(all, { all: true, centreIds: [] });
    expect(all.calls[0]!.values).toEqual(expect.arrayContaining([true, []]));
    expect(await run(fakeTx([{ centre_id: C1, stage: 'awaiting_results', orders: '1', oldest_registered_at: '2026-11-01T00:00:00.000Z' }]), { all: false, centreIds: [] })).toEqual([]);
    const tx = fakeTx();
    await expect(run(tx, undefined)).rejects.toThrow(/scope/i);
    await expect(run(tx, { all: 'yes', centreIds: [] })).rejects.toThrow(/scope/i);
    expect(tx.calls).toEqual([]);
  });

  it('orders arrive as strings → safe integers; oldest_registered_at (a Date from pg) → ISO string; beyond 2^53 refused', async () => {
    const out = await run(fakeTx([{ centre_id: C1, stage: 'ready_unreleased', orders: '7', oldest_registered_at: new Date('2026-11-01T00:00:00.000Z') }]), { all: true, centreIds: [] });
    expect(out).toEqual([{ centre_id: C1, stage: 'ready_unreleased', orders: 7, oldest_registered_at: '2026-11-01T00:00:00.000Z' }]);
    await expect(run(fakeTx([{ centre_id: C1, stage: 'awaiting_results', orders: '9007199254740993', oldest_registered_at: null }]), { all: true, centreIds: [] })).rejects.toThrow(RangeError);
  });
});
const tx0 = (tx: { calls: { text: string }[] }) => norm(tx.calls[0]!.text);
