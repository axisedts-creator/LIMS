// C12.T-14 contract tests for #63-#68 (stock counts): permission gate on the list, strict request schemas (400 common.validation_failed), If-Match (428 / 400), no DB access on refusals.
// Spec: 02-TRD §5.5 #63-#68, §5.11, contracts/openapi/inventory.yaml (query / body schemas), 07-SECURITY P-B2 / P-B8 / PE-1. Seams: counts.helpers.ts.
// The tx is DEAD here: a refusal that touches the database fails the test. Row-dependent gates (404 / 403 by branch, 409 transitions) live in counts.integration.test.ts.
import { describe, expect, it } from 'vitest';
import { A, PERMISSION, READ, call, cLine, deadTx, expectLims, ifm, makeKeeperCtx, openBody, postBody, recBody, rej, uid, type LotOpts } from './counts.helpers.js';

const STORE = uid(1001), ITEM = uid(2001), LOT = uid(4001), CNT = uid(8901), LINE = uid(8921);
const fresh = (o: LotOpts = {}) => { const tx = deadTx(); return { tx, ...makeKeeperCtx(tx, A, o) }; };

const VALID: Record<string, any> = {
  listStockCounts: {},
  openStockCount: { body: openBody(STORE) },
  getStockCount: { params: { count_id: CNT } },
  recordStockCountLines: { params: { count_id: CNT }, body: recBody([cLine(ITEM, '10', LOT)]) },
  postStockCount: { params: { count_id: CNT }, headers: ifm(1), body: postBody('skip') },
  cancelStockCount: { params: { count_id: CNT }, headers: ifm(1) },
};
const IF_MATCH_OPS = ['postStockCount', 'cancelStockCount'];
const PATH_OPS = ['getStockCount', 'recordStockCountLines', ...IF_MATCH_OPS];

describe('T-14 #63 listStockCounts: permission first (no branchId), strict query', () => {
  it('without inventory.item.read -> 403 auth.forbidden; assertRole({permission}) without branchId; tx untouched', async () => {
    const c = fresh({ permissions: [] });
    await expectLims(call('listStockCounts', c.ctx, VALID['listStockCounts']), 'auth.forbidden', 403);
    expect(c.roleCalls[0]).toEqual({ permission: PERMISSION['listStockCounts'] });
    expect(c.tx.calls).toEqual([]);
  });
  it('permission before validation: a stranger with a bad query learns nothing (403, not 400)', async () => {
    const c = fresh({ permissions: [] });
    await expectLims(call('listStockCounts', c.ctx, { query: { status: 'banana' } }), 'auth.forbidden', 403);
    expect(c.tx.calls).toEqual([]);
  });
  const bad = (query: Record<string, unknown>) => async () => { const c = fresh({ permissions: [READ] }); await expectLims(call('listStockCounts', c.ctx, { query }), 'common.validation_failed', 400); expect(c.tx.calls).toEqual([]); };
  it('status outside open|posted|cancelled', bad({ status: 'draft' }));
  it('store_id must be a uuid', bad({ store_id: 'MAIN-A' }));
  it('unknown query key (tenant_id smuggle)', bad({ tenant_id: A }));
  it('limit 0 and limit 201', async () => { await bad({ limit: 0 })(); await bad({ limit: 201 })(); });
});

describe('T-14 #64 openStockCount body (strict; validation runs before any read)', () => {
  const badBody = (body: unknown) => async () => { const c = fresh(); await expectLims(call('openStockCount', c.ctx, { body }), 'common.validation_failed', 400); expect(c.tx.calls).toEqual([]); };
  it('a stranger with a bad body gets 400 (the permission needs the store row, which is never read for invalid input)', async () => {
    const c = fresh({ permissions: [] });
    await expectLims(call('openStockCount', c.ctx, { body: {} }), 'common.validation_failed', 400);
    expect(c.tx.calls).toEqual([]);
  });
  it('store_id is required and must be a uuid', async () => { await badBody({})(); await badBody(openBody('MAIN-A'))(); await badBody(openBody(null as any))(); });
  it('scope_category outside the item categories (reagent|kit|consumable|control|calibrator|other)', async () => { for (const v of ['Reagent', 'equipment', '', 5]) await badBody(openBody(STORE, { scope_category: v }))(); });
  it('notes longer than 1000 chars; notes not a string', async () => { await badBody(openBody(STORE, { notes: 'x'.repeat(1001) }))(); await badBody(openBody(STORE, { notes: 5 }))(); });
  it('unknown keys (tenant_id, status, count_no, lines, snapshot_at)', async () => { for (const k of ['tenant_id', 'status', 'count_no', 'lines', 'snapshot_at']) await badBody(openBody(STORE, { [k]: 'x' }))(); });
  it('a body that is not an object (array / string / null / missing)', async () => { for (const b of [[], 'x', null, undefined]) await badBody(b)(); });
  it('the exact 1000-char notes boundary and every category are valid for the schema (reach the tx: never a 400)', async () => {
    for (const cat of ['reagent', 'kit', 'consumable', 'control', 'calibrator', 'other']) {
      const c = fresh();
      const e = await rej(call('openStockCount', c.ctx, { body: openBody(STORE, { scope_category: cat, notes: 'x'.repeat(1000) }) }));
      expect((e as { code?: string }).code).not.toBe('common.validation_failed');
    }
  });
});

describe('T-14 #65-#68 path id and If-Match', () => {
  it.each(PATH_OPS)('%s: count_id must be a uuid -> 400, tx untouched', async (op) => {
    const c = fresh();
    await expectLims(call(op, c.ctx, { ...VALID[op], params: { count_id: 'SC2600001' } }), 'common.validation_failed', 400);
    expect(c.tx.calls).toEqual([]);
  });
  it.each(IF_MATCH_OPS)('%s without If-Match -> 428 common.precondition_required, tx untouched', async (op) => {
    const c = fresh();
    await expectLims(call(op, c.ctx, { ...VALID[op], headers: {} }), 'common.precondition_required', 428);
    expect(c.tx.calls).toEqual([]);
  });
  it.each(IF_MATCH_OPS)('%s with a malformed If-Match (banana, W/"1", "0", 1) -> 400 common.validation_failed, tx untouched', async (op) => {
    for (const v of ['banana', 'W/"1"', '"0"', '1', '""']) {
      const c = fresh();
      await expectLims(call(op, c.ctx, { ...VALID[op], headers: { 'if-match': v } }), 'common.validation_failed', 400);
      expect(c.tx.calls).toEqual([]);
    }
  });
});

describe('T-14 #65 getStockCount query (limit / cursor page the lines)', () => {
  const bad = (query: Record<string, unknown>) => async () => { const c = fresh(); await expectLims(call('getStockCount', c.ctx, { ...VALID['getStockCount'], query }), 'common.validation_failed', 400); expect(c.tx.calls).toEqual([]); };
  it('limit 0 / 201 / not a number; unknown key', async () => { await bad({ limit: 0 })(); await bad({ limit: 201 })(); await bad({ limit: 'many' })(); await bad({ tenant_id: A })(); });
});

describe('T-14 #66 recordStockCountLines body (strict)', () => {
  const badBody = (body: unknown) => async () => { const c = fresh(); await expectLims(call('recordStockCountLines', c.ctx, { ...VALID['recordStockCountLines'], body }), 'common.validation_failed', 400); expect(c.tx.calls).toEqual([]); };
  const ok = cLine(ITEM, '10', LOT);
  it('lines missing / empty / more than 200', async () => { await badBody({})(); await badBody(recBody([]))(); await badBody(recBody(Array.from({ length: 201 }, (_, i) => cLine(uid(30000 + i), '1'))))(); });
  it('item_id and counted_qty_base are required; ids must be uuids', async () => {
    await badBody(recBody([{ counted_qty_base: '1' }]))(); await badBody(recBody([{ item_id: ITEM }]))();
    await badBody(recBody([cLine('GLU-R1', '1')]))(); await badBody(recBody([cLine(ITEM, '1', 'L-001')]))(); await badBody(recBody([cLine(ITEM, '1', LOT, { line_id: 'LINE-1' })]))();
  });
  it('counted_qty_base: negative, signed, 7 decimals, 13 digits, not a number, a JSON number, empty, null', async () => {
    for (const q of ['-1', '+1', '1.1234567', '1234567890123', 'ten', '', 10, null]) await badBody(recBody([cLine(ITEM, q as any, LOT)]))();
  });
  it('counted_at must be an ISO UTC instant (date only / local offset / garbage / number)', async () => { for (const v of ['2026-11-02', '2026-11-02T10:00:00+05:45', 'yesterday', 5]) await badBody(recBody([cLine(ITEM, '1', LOT, { counted_at: v })]))(); });
  it('reason_code: spaces / upper case / 33 chars / a number', async () => { for (const r of ['Count Variance', 'COUNT', 'a'.repeat(33), 5]) await badBody(recBody([cLine(ITEM, '1', LOT, { reason_code: r })]))(); });
  it('unknown keys: body (status, count_id) and line (book_qty_snapshot, variance_qty_base, counted_by, version)', async () => {
    await badBody({ lines: [ok], status: 'posted' })(); await badBody({ lines: [ok], count_id: CNT })();
    for (const k of ['book_qty_snapshot', 'book_qty_at_count', 'variance_qty_base', 'counted_by', 'version']) await badBody(recBody([{ ...ok, [k]: 1 }]))();
  });
  it('the same line_id twice, or the same (item_id, lot_id) twice, in one request', async () => {
    await badBody(recBody([cLine(ITEM, '1', LOT, { line_id: LINE }), cLine(uid(2002), '1', null, { line_id: LINE })]))();
    await badBody(recBody([cLine(ITEM, '1', LOT), cLine(ITEM, '2', LOT)]))();
  });
  it('counted_qty_base "0" and the 200-line boundary are VALID (they reach the tx: never a 400)', async () => {
    const c = fresh();
    const e = await rej(call('recordStockCountLines', c.ctx, { ...VALID['recordStockCountLines'], body: recBody(Array.from({ length: 200 }, (_, i) => cLine(uid(30000 + i), '0', null, { counted_at: '2026-11-02T04:30:00.000Z', reason_code: 'count_variance' }))) }));
    expect((e as { code?: string }).code).not.toBe('common.validation_failed');
  });
});

describe('T-14 #67 postStockCount body (strict)', () => {
  const badBody = (body: unknown) => async () => { const c = fresh(); await expectLims(call('postStockCount', c.ctx, { ...VALID['postStockCount'], body }), 'common.validation_failed', 400); expect(c.tx.calls).toEqual([]); };
  it('uncounted_policy is required and is skip | zero (nothing else, no default)', async () => { await badBody({})(); for (const v of ['ignore', 'SKIP', '', null, true, 0]) await badBody({ uncounted_policy: v })(); });
  it('unknown keys (status, version, lines, tenant_id)', async () => { for (const k of ['status', 'version', 'lines', 'tenant_id']) await badBody(postBody('skip', { [k]: 'x' }))(); });
  it('a body that is not an object (array / string / null / missing)', async () => { for (const b of [[], 'x', null, undefined]) await badBody(b)(); });
  it.each(['skip', 'zero'] as const)('uncounted_policy %s is valid for the schema (reaches the tx: never a 400)', async (p) => {
    const c = fresh();
    const e = await rej(call('postStockCount', c.ctx, { ...VALID['postStockCount'], body: postBody(p) }));
    expect((e as { code?: string }).code).not.toBe('common.validation_failed');
  });
});

describe('T-14 #68 cancelStockCount takes no body', () => {
  it('a body with keys is refused 400 (strict: nothing to smuggle)', async () => {
    const c = fresh();
    await expectLims(call('cancelStockCount', c.ctx, { ...VALID['cancelStockCount'], body: { status: 'cancelled' } }), 'common.validation_failed', 400);
    expect(c.tx.calls).toEqual([]);
  });
});

describe('T-14 #64-#68: the permission is asserted per branch, never tenant-wide, once the row is loaded', () => {
  it.each(['openStockCount', 'getStockCount', 'recordStockCountLines', 'postStockCount', 'cancelStockCount'])('%s with a valid request touches the tx (the scope read) before any permission decision', async (op) => {
    const c = fresh({ permissions: [] });
    const e = await rej(call(op, c.ctx, VALID[op]));
    expect((e as { message?: string }).message).toMatch(/tx touched/); // 404 beats 403 (P-B8): no assertRole may precede the row read
    expect(c.roleCalls).toEqual([]);
  });
});
