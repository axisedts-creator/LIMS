// C8 AN-T13 — listPendingTests (GET /v1/analytics/reports/pending-tests/items). PRD US-10.1, 10.3, 10.4; 02-TRD §5 #12, §5.1 PendingItemDto, §6.7 (keyset cursor {age_seconds, order_item_id}); 08 A13 D-13, A17 D-49.
// Same emulators and world as pending.summary.handler.test.ts (./helpers.t13.ts); every expected order / count is hand-computed from seedT13().
// ASSUMPTIONS (spec-silent, flagged in .orchestra/notes/AN-T13-tests.md): ties are ordered by order_item_id ascending in BOTH sort directions; the service asks the repo for limit + 1 rows.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  A1, BR1, DEPT, LABMGR, LABMGR_A1, OWNER_A1, OWNER_ALL, TEST, TEST_NAME, A3, TA, calls13, call13, contractErrors13, expectLims, ids13, items13, makeCtx13, oi, od, pn, seedT13, ADMIN,
} from './helpers.t13.js';

vi.mock('../../repository/sourceViews.repo.js', async () => (await import('./helpers.t13.js')).sourceViewsMockT13);
vi.mock('../../repository/rollups.repo.js', async () => (await import('./helpers.t13.js')).rollupsMockT13);
vi.mock('../../repository/labels.repo.js', async () => (await import('./helpers.t13.js')).labelsRepoMockT13);

beforeEach(() => { seedT13(); vi.clearAllMocks(); });

const reads = () => calls13.filter((c) => c.fn === 'pendingItems');
const DESC = pn(6, 4, 3, 5, 2, 7, 1, 8);   // age 300000, 259200, 86400, 20000, 14400, 14399, 3600 (P1), 3600 (P8)
const ASC = pn(1, 8, 7, 2, 5, 3, 4, 6);
const ALLOWED = ['order_item_id', 'order_id', 'centre_id', 'processing_branch_id', 'department_id', 'test_id', 'test_code', 'test_label', 'priority', 'item_status', 'age_seconds', 'tat_target_seconds', 'is_overdue', 'open_route_id'];

describe('US-10.3 — drill-down items: department, test code/name, priority, status, centre, age, overdue flag; no patient data', () => {
  it('P1: every PendingItemDto field, with test code/label from the test directory and is_overdue derived from age > target', async () => {
    const body = await items13((await makeCtx13(OWNER_ALL)).ctx);
    const p1 = body.data.find((d: any) => d.order_item_id === oi(1));
    expect(p1).toEqual({
      order_item_id: oi(1), order_id: od(1), centre_id: A1, processing_branch_id: BR1, department_id: DEPT.H, test_id: TEST.CBC, test_code: 'CBC', test_label: TEST_NAME.CBC,
      priority: 'routine', item_status: 'in_process', age_seconds: 3600, tat_target_seconds: 7200, is_overdue: false,
    });
    expect(contractErrors13('listPendingTests', body)).toEqual([]);
  });

  it('is_overdue: P2 (14400 > 7200) and P5 (20000 > 10000) are overdue; P4 (259200 == 259200), P7 (14399 == 14399) and the no-target P3/P6 are not', async () => {
    const body = await items13((await makeCtx13(OWNER_ALL)).ctx);
    const overdue = body.data.filter((d: any) => d.is_overdue).map((d: any) => d.order_item_id).sort();
    expect(overdue).toEqual([oi(2), oi(5)].sort());
  });

  it('optional fields are omitted, never null: no processing branch (P7) → no processing_branch_id; no target (P3) → no tat_target_seconds', async () => {
    const body = await items13((await makeCtx13(OWNER_ALL)).ctx);
    const p7 = body.data.find((d: any) => d.order_item_id === oi(7));
    const p3 = body.data.find((d: any) => d.order_item_id === oi(3));
    expect(p7).not.toHaveProperty('processing_branch_id');
    expect(p7.tat_target_seconds).toBe(14399);
    expect(p3).not.toHaveProperty('tat_target_seconds');
    expect(p3.is_overdue).toBe(false);
    for (const d of body.data) for (const v of Object.values(d)) expect(v).not.toBeNull();
  });

  it('only the PendingItemDto allow-list leaves the service: the hostile columns of the view row (patient_name, registration_no, barcode, result_value, received_centre_id) never appear', async () => {
    const body = await items13((await makeCtx13(LABMGR)).ctx);
    for (const d of body.data) expect(Object.keys(d).filter((k) => !ALLOWED.includes(k))).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(/PLANTED|patient|registration|barcode|result_value|received_centre/i);
  });

  it('open_route_id = staff.lab.order_results ONLY for a holder of lab.result.read (lab_manager); the owner_viewer gets the key absent (not null, not "")', async () => {
    const holder = await items13((await makeCtx13(LABMGR)).ctx);
    expect(holder.data).toHaveLength(8);
    for (const d of holder.data) expect(d.open_route_id).toBe('staff.lab.order_results');
    expect(contractErrors13('listPendingTests', holder)).toEqual([]);
    const other = await items13((await makeCtx13(OWNER_ALL)).ctx);
    expect(other.data).toHaveLength(8);
    for (const d of other.data) expect(d).not.toHaveProperty('open_route_id');
  });

});

describe('ordering and keyset paging — default sort -age_seconds, ties by order_item_id; opaque cursor {age_seconds, order_item_id}', () => {
  it('default: oldest first, ties (P1 / P8 at 3600 s) by order_item_id ascending; page = { limit: 50 } with no next_cursor', async () => {
    const { ctx } = await makeCtx13(ADMIN);
    const body = await items13(ctx);
    expect(ids13(body)).toEqual(DESC);
    expect(body.page).toEqual({ limit: 50 });
    expect(reads()).toHaveLength(1);
    expect(reads()[0]!.args).toMatchObject({ tenantId: TA, sort: '-age_seconds', limit: 51 });   // limit + 1: one extra row tells whether a next page exists
  });

  it('sort=age_seconds: youngest first, ties still by order_item_id ascending', async () => {
    const body = await items13((await makeCtx13(ADMIN)).ctx, { sort: 'age_seconds' });
    expect(ids13(body)).toEqual(ASC);
    expect(reads()[0]!.args.sort).toBe('age_seconds');
  });

  it('limit 3 walks the whole list in 3 pages (3 + 3 + 2) with no gap and no duplicate; the last page has no next_cursor', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    const sizes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const body = await items13((await makeCtx13(ADMIN)).ctx, { limit: 3, ...(cursor ? { cursor } : {}) });
      seen.push(...ids13(body)); sizes.push(body.data.length);
      expect(body.page.limit).toBe(3);
      expect(contractErrors13('listPendingTests', body)).toEqual([]);
      cursor = body.page.next_cursor;
      if (!cursor) break;
    }
    expect(sizes).toEqual([3, 3, 2]);
    expect(seen).toEqual(DESC);
  });

  it('page 2 resumes strictly after the last row of page 1: the repo gets after = { age_seconds, order_item_id } of that row; the cursor is an opaque string (no raw id in it, ≤ 512 chars)', async () => {
    const first = await items13((await makeCtx13(ADMIN)).ctx, { limit: 3 });
    expect(ids13(first)).toEqual(pn(6, 4, 3));
    const cursor: string = first.page.next_cursor;
    expect(typeof cursor).toBe('string');
    expect(cursor.length).toBeLessThanOrEqual(512);
    expect(cursor).not.toContain(oi(3));
    calls13.length = 0;
    const second = await items13((await makeCtx13(ADMIN)).ctx, { limit: 3, cursor });
    expect(ids13(second)).toEqual(pn(5, 2, 7));
    expect(reads()[0]!.args.after).toEqual({ age_seconds: 86400, order_item_id: oi(3) });
  });

  it('the cursor crosses a tie correctly: sort=age_seconds, limit 1 → P1 then P8 (same age, next order_item_id), nothing skipped or repeated', async () => {
    const one = await items13((await makeCtx13(ADMIN)).ctx, { sort: 'age_seconds', limit: 1 });
    expect(ids13(one)).toEqual(pn(1));
    const two = await items13((await makeCtx13(ADMIN)).ctx, { sort: 'age_seconds', limit: 1, cursor: one.page.next_cursor });
    expect(ids13(two)).toEqual(pn(8));
    const three = await items13((await makeCtx13(ADMIN)).ctx, { sort: 'age_seconds', limit: 1, cursor: two.page.next_cursor });
    expect(ids13(three)).toEqual(pn(7));
  });

  it('exactly `limit` rows left → no next_cursor; one more than `limit` → next_cursor', async () => {
    const eight = await items13((await makeCtx13(ADMIN)).ctx, { limit: 8 });
    expect(eight.data).toHaveLength(8);
    expect(eight.page).toEqual({ limit: 8 });
    const seven = await items13((await makeCtx13(ADMIN)).ctx, { limit: 7 });
    expect(seven.data).toHaveLength(7);
    expect(typeof seven.page.next_cursor).toBe('string');
  });

  it('limit bounds: 200 is accepted (the repo is asked for 201); 0, -1, 201, 1.5 and "many" are 400 common.validation_failed before any read', async () => {
    await items13((await makeCtx13(ADMIN)).ctx, { limit: 200 });
    expect(reads().at(-1)!.args.limit).toBe(201);
    for (const limit of [0, -1, 201, 1.5, 'many']) {
      calls13.length = 0;
      await expectLims(call13('listPendingTests', (await makeCtx13(ADMIN)).ctx, { limit }), 'common.validation_failed', 400);
      expect(calls13, String(limit)).toHaveLength(0);
    }
  });

  it('an empty result is a normal page: data [] and page { limit }', async () => {
    const body = await items13((await makeCtx13(ADMIN)).ctx, { priority: 'urgent', item_status: ['resulted'] });  // P4 is the only resulted item and it is routine
    expect(body).toEqual({ data: [], page: { limit: 50 } });
  });
});

describe('D-49 / D-13 — scope is the C5 policy of the caller\'s tx; no implicit centre predicate', () => {
  it('restricted caller {A1}: P5 (collected at A3, received at the hub A1) is listed with its own centre_id A3; the repo gets no centre predicate', async () => {
    const { ctx, tx } = await makeCtx13(OWNER_A1);
    const body = await items13(ctx);
    expect(ids13(body)).toEqual(pn(5, 2, 7, 1, 8));
    expect(body.data.find((d: any) => d.order_item_id === oi(5)).centre_id).toBe(A3);
    expect(reads()).toHaveLength(1);
    expect(reads()[0]!.args.centreIds).toBeUndefined();
    expect(reads()[0]!.tx).toBe(tx);
    expect(contractErrors13('listPendingTests', body)).toEqual([]);
  });

  it('restricted callers never see rows the policy hides (P3 P4 P6 for {A1}), and the all-centre caller sees all 8', async () => {
    const restricted = ids13(await items13((await makeCtx13(OWNER_A1)).ctx));
    for (const hidden of pn(3, 4, 6)) expect(restricted).not.toContain(hidden);
    expect(ids13(await items13((await makeCtx13(OWNER_ALL)).ctx))).toHaveLength(8);
  });

  it('a lab_manager restricted to {A1} gets the same rows, plus the Open link on each', async () => {
    const body = await items13((await makeCtx13(LABMGR_A1)).ctx);
    expect(ids13(body)).toEqual(pn(5, 2, 7, 1, 8));
    for (const d of body.data) expect(d.open_route_id).toBe('staff.lab.order_results');
  });

  it('explicit centre_id=A1 → centreIds [A1] on the COLLECTION centre: P5 drops out for the admin and for {A1} alike', async () => {
    for (const actor of [ADMIN, OWNER_A1]) {
      calls13.length = 0;
      const body = await items13((await makeCtx13(actor)).ctx, { centre_id: [A1] });
      expect(reads()[0]!.args.centreIds, actor).toEqual([A1]);
      expect(ids13(body), actor).toEqual(pn(2, 7, 1, 8));
    }
  });

  it('a centre outside the caller\'s scope is 404 common.not_found with no read: {A1} asking for A3', async () => {
    await expectLims(call13('listPendingTests', (await makeCtx13(OWNER_A1)).ctx, { centre_id: [A3] }), 'common.not_found', 404);
    expect(reads()).toHaveLength(0);
  });
});

describe('filters (TRD §5 #12): department_id, priority, processing_branch_id, item_status[], overdue_only', () => {
  it('department_id=[B] → P3 P4 P6 P8 in age order', async () => {
    expect(ids13(await items13((await makeCtx13(ADMIN)).ctx, { department_id: [DEPT.B] }))).toEqual(pn(6, 4, 3, 8));
    expect(reads()[0]!.args.departmentIds).toEqual([DEPT.B]);
  });

  it('priority=urgent → P6, P2; processing_branch_id=[BR1] → P4 P3 P5 P2 P1 P8 (P7 has none, P6 is BR2)', async () => {
    expect(ids13(await items13((await makeCtx13(ADMIN)).ctx, { priority: 'urgent' }))).toEqual(pn(6, 2));
    expect(ids13(await items13((await makeCtx13(ADMIN)).ctx, { processing_branch_id: [BR1] }))).toEqual(pn(4, 3, 5, 2, 1, 8));
  });

  it('item_status=[awaiting_receipt, in_process] → P5 P2 P7 P1 P8; a single status works too', async () => {
    expect(ids13(await items13((await makeCtx13(ADMIN)).ctx, { item_status: ['awaiting_receipt', 'in_process'] }))).toEqual(pn(5, 2, 7, 1, 8));
    expect(reads()[0]!.args.itemStatuses).toEqual(['awaiting_receipt', 'in_process']);
    expect(ids13(await items13((await makeCtx13(ADMIN)).ctx, { item_status: ['verified'] }))).toEqual(pn(6));
  });

  it('overdue_only=true → only P5 and P2 (age > target); false / absent → no restriction', async () => {
    expect(ids13(await items13((await makeCtx13(ADMIN)).ctx, { overdue_only: true }))).toEqual(pn(5, 2));
    expect(reads()[0]!.args.overdueOnly).toBe(true);
    expect(ids13(await items13((await makeCtx13(ADMIN)).ctx, { overdue_only: false }))).toHaveLength(8);
  });

  it('filters combine with scope and paging: {A1} + overdue_only + limit 1 → P5, then P2', async () => {
    const one = await items13((await makeCtx13(OWNER_A1)).ctx, { overdue_only: true, limit: 1 });
    expect(ids13(one)).toEqual(pn(5));
    const two = await items13((await makeCtx13(OWNER_A1)).ctx, { overdue_only: true, limit: 1, cursor: one.page.next_cursor });
    expect(ids13(two)).toEqual(pn(2));
    expect(two.page.next_cursor).toBeUndefined();
  });

  it('closed lists: item_status "bogus", sort "name", priority "normal", 6 statuses → 400 common.validation_failed before any read', async () => {
    const bad: Record<string, unknown>[] = [
      { item_status: ['bogus'] }, { sort: 'name' }, { sort: '-age_seconds; DROP TABLE lab.order_tests' }, { priority: 'normal' },
      { item_status: ['awaiting_collection', 'awaiting_receipt', 'in_process', 'resulted', 'verified', 'verified'] },
    ];
    for (const q of bad) {
      calls13.length = 0;
      await expectLims(call13('listPendingTests', (await makeCtx13(ADMIN)).ctx, q), 'common.validation_failed', 400);
      expect(calls13, JSON.stringify(q)).toHaveLength(0);
    }
  });

  it('a processing_branch_id of another tenant / unknown → 404 common.not_found', async () => {
    await expectLims(call13('listPendingTests', (await makeCtx13(ADMIN)).ctx, { processing_branch_id: ['00000000-0000-4000-8000-0000000000ff'] }), 'common.not_found', 404);
  });
});

describe('cursor integrity — a malformed or hostile cursor is 400 common.invalid_cursor, no read, no echo', () => {
  const hostile = ['%%%', 'AAAA', Buffer.from('{"k":"x"}').toString('base64url'), Buffer.from('not json at all').toString('base64url'),
    Buffer.from(JSON.stringify({ age_seconds: 'x', order_item_id: 'y' })).toString('base64url'),
    "x'; DROP TABLE lab.order_tests;--"];
  it.each(hostile)('cursor %s', async (cursor) => {
    const e = await expectLims(call13('listPendingTests', (await makeCtx13(ADMIN)).ctx, { cursor }), 'common.invalid_cursor', 400);
    expect(reads()).toHaveLength(0);
    expect(JSON.stringify({ m: e.message, d: e.details })).not.toContain('DROP TABLE');
  });
});
