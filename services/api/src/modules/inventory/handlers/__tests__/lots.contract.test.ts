// C12.T-09 contract tests for #30-#39 (lots, stock, movements, FEFO suggestion, opened containers): permission gate, strict request schemas (400 common.validation_failed),
// If-Match (428), privileged operations at aal1 (PE-1), no DB access on refusals.
// Spec: 02-TRD §5.2 #30-#39, §6.1, contracts/openapi/inventory.yaml (query / body schemas), 07-SECURITY PE-1 / PE-2 / P-B8. Seams: lots.helpers.ts.
// The tx is DEAD here: a refusal that touches the database fails the test. Store-scope operations cannot be gate-tested without reading the store (404 beats 403): see lots.integration.test.ts.
import { describe, expect, it } from 'vitest';
import { A, ADJUST, BENCH, PERMISSION, READ, call, correctExpiry, deadTx, expectLims, ifm, makeLotCtx, newContainer, reason, rej, setStatus, uid, type LotOpts } from './lots.helpers.js';

const STORE = uid(1001), ITEM = uid(2001), LOT = uid(4001), CONT = uid(9301);
const fresh = (o: LotOpts = {}) => { const tx = deadTx(); return { tx, ...makeLotCtx(tx, A, o) }; };

/** Every operation with a syntactically valid request. */
const VALID: Record<string, any> = {
  listInventoryLots: { query: { item_id: ITEM } },
  getInventoryLot: { params: { lot_id: LOT } },
  setInventoryLotStatus: { params: { lot_id: LOT }, headers: ifm(1), body: setStatus() },
  correctInventoryLotExpiry: { params: { lot_id: LOT }, headers: ifm(1), body: correctExpiry() },
  listStockBalances: {},
  listStockMovements: {},
  getFefoSuggestion: { query: { store_id: STORE, item_id: ITEM, qty_base: '10' } },
  listOpenedContainers: { query: { store_id: STORE } },
  openContainer: { body: newContainer(STORE, ITEM, { lot_id: LOT }) },
  finishContainer: { params: { container_id: CONT }, headers: ifm(1), body: {} },
};
/** Operations whose permission gate needs no row: tenant scope (#30-#33) and the visible-branch lists without store_id (#34, #35). */
const GATED = ['listInventoryLots', 'getInventoryLot', 'setInventoryLotStatus', 'correctInventoryLotExpiry', 'listStockBalances', 'listStockMovements'];
const PRIVILEGED = ['setInventoryLotStatus', 'correctInventoryLotExpiry'];

describe('T-09 gate: permission first, nothing else touched (PE-1, PE-2, REQ-SEC-062)', () => {
  it.each(GATED)('%s without the permission -> 403 auth.forbidden; assertRole({permission}) without branchId; tx untouched', async (op) => {
    const c = fresh({ permissions: [] });
    await expectLims(call(op, c.ctx, VALID[op]), 'auth.forbidden', 403);
    expect(c.roleCalls[0]).toEqual({ permission: PERMISSION[op] });
    expect(c.tx.calls).toEqual([]);
  });
  it.each(PRIVILEGED)('%s: a technologist (item.read + bench.record) is refused 403 (PE-2), tx untouched', async (op) => {
    const c = fresh({ permissions: [READ, BENCH] });
    await expectLims(call(op, c.ctx, VALID[op]), 'auth.forbidden', 403);
    expect(c.tx.calls).toEqual([]);
  });
  it.each(PRIVILEGED)('%s at aal1 -> 403 auth.mfa_required even with the permission (PE-1), tx untouched', async (op) => {
    const c = fresh({ permissions: [READ, ADJUST], aal: 'aal1' });
    await expectLims(call(op, c.ctx, VALID[op]), 'auth.mfa_required', 403);
    expect(c.roleCalls[0]).toEqual({ permission: ADJUST });
    expect(c.tx.calls).toEqual([]);
  });
  it.each(PRIVILEGED)('%s: a stranger with bad input learns nothing - the permission check runs before validation (403, not 400/428)', async (op) => {
    const c = fresh({ permissions: [] });
    await expectLims(call(op, c.ctx, { params: { lot_id: 'nope' }, body: { evil: 1 } }), 'auth.forbidden', 403);
    expect(c.tx.calls).toEqual([]);
  });
});

describe('T-09 #30 listInventoryLots query (strict)', () => {
  const bad = (query: Record<string, unknown>) => async () => { const c = fresh(); await expectLims(call('listInventoryLots', c.ctx, { query }), 'common.validation_failed', 400); expect(c.tx.calls).toEqual([]); };
  it('item_id is required', bad({}));
  it('item_id must be a uuid', bad({ item_id: 'GLU-R1' }));
  it('status outside available|quarantined|blocked', bad({ item_id: ITEM, status: 'expired' }));
  it('expiring_before must be a real calendar date (2026-02-30 is not)', bad({ item_id: ITEM, expiring_before: '2026-02-30' }));
  it('expiring_before with a time part', bad({ item_id: ITEM, expiring_before: '2026-12-01T00:00:00Z' }));
  it('unknown query key (tenant_id smuggle)', bad({ item_id: ITEM, tenant_id: A }));
  it('limit 0 and limit 201', async () => { await bad({ item_id: ITEM, limit: 0 })(); await bad({ item_id: ITEM, limit: 201 })(); });
});

describe('T-09 #31 / #32 / #33 path, header and body', () => {
  it('lot_id must be a uuid (#31 #32 #33)', async () => {
    for (const op of ['getInventoryLot', 'setInventoryLotStatus', 'correctInventoryLotExpiry']) {
      const c = fresh({ permissions: [READ, ADJUST] });
      await expectLims(call(op, c.ctx, { ...VALID[op], params: { lot_id: 'L-001' } }), 'common.validation_failed', 400);
      expect(c.tx.calls).toEqual([]);
    }
  });
  it.each(PRIVILEGED)('%s without If-Match -> 428 common.precondition_required', async (op) => {
    const c = fresh({ permissions: [READ, ADJUST] });
    await expectLims(call(op, c.ctx, { ...VALID[op], headers: {} }), 'common.precondition_required', 428);
    expect(c.tx.calls).toEqual([]);
  });
  it.each(PRIVILEGED)('%s with a malformed If-Match -> 400 common.validation_failed', async (op) => {
    const c = fresh({ permissions: [READ, ADJUST] });
    await expectLims(call(op, c.ctx, { ...VALID[op], headers: { 'if-match': 'banana' } }), 'common.validation_failed', 400);
    expect(c.tx.calls).toEqual([]);
  });
  const badBody = (op: string, body: unknown) => async () => { const c = fresh({ permissions: [READ, ADJUST] }); await expectLims(call(op, c.ctx, { ...VALID[op], body }), 'common.validation_failed', 400); expect(c.tx.calls).toEqual([]); };
  it('#32 status outside the enum', badBody('setInventoryLotStatus', setStatus({ status: 'expired' })));
  it('#32 status missing', badBody('setInventoryLotStatus', reason()));
  it('#32 unknown key (tenant_id / version smuggle)', async () => { await badBody('setInventoryLotStatus', setStatus({ tenant_id: A }))(); await badBody('setInventoryLotStatus', setStatus({ version: 9 }))(); });
  it('#32 reason_code malformed (spaces / upper case / 33 chars)', async () => {
    for (const r of ['Not A Code', 'UPPER', 'a'.repeat(33)]) await badBody('setInventoryLotStatus', setStatus({ reason_code: r }))();
  });
  it('#32 / #33 a missing reason is refused before any read: 400 (schema) or 422 inventory.reason_required, tx untouched', async () => {
    for (const [op, body] of [['setInventoryLotStatus', { status: 'blocked' }], ['correctInventoryLotExpiry', { expiry_on: '2027-06-30' }]] as const) {
      const c = fresh({ permissions: [READ, ADJUST] });
      const e = await rej(call(op, c.ctx, { ...VALID[op], body }));
      expect(['common.validation_failed', 'inventory.reason_required']).toContain((e as { code: string }).code);
      expect(c.tx.calls).toEqual([]);
    }
  });
  it('#33 expiry_on must be a real calendar date', async () => {
    for (const d of ['2027-02-30', '2027-13-01', '30/06/2027', '2027-06-30T00:00:00Z', '']) await badBody('correctInventoryLotExpiry', correctExpiry({ expiry_on: d }))();
  });
  it('#33 expiry_on missing / null (an expiry cannot be erased)', async () => { await badBody('correctInventoryLotExpiry', { reason_code: 'syn_expiry_fix' })(); await badBody('correctInventoryLotExpiry', correctExpiry({ expiry_on: null }))(); });
  it('#33 unknown key', badBody('correctInventoryLotExpiry', correctExpiry({ status: 'available' })));
  it('a body that is not an object (array / string / null)', async () => { for (const b of [[], 'x', null]) { await badBody('setInventoryLotStatus', b)(); await badBody('correctInventoryLotExpiry', b)(); } });
});

describe('T-09 #34 listStockBalances / #35 listStockMovements query (strict)', () => {
  const bad = (op: string, query: Record<string, unknown>) => async () => { const c = fresh(); await expectLims(call(op, c.ctx, { query }), 'common.validation_failed', 400); expect(c.tx.calls).toEqual([]); };
  it('#34 expiring_within_days outside 1..365', async () => { for (const n of [0, 366, -1, 1.5]) await bad('listStockBalances', { expiring_within_days: n })(); });
  it('#34 expired_only / include_zero / below_reorder must be booleans', async () => { for (const k of ['expired_only', 'include_zero', 'below_reorder']) await bad('listStockBalances', { [k]: 'sometimes' })(); });
  it('#34 category outside the enum, store_id / item_id not uuids', async () => {
    await bad('listStockBalances', { category: 'furniture' })();
    await bad('listStockBalances', { store_id: 'MAIN-A' })();
    await bad('listStockBalances', { item_id: 'GLU-R1' })();
  });
  it('#34 unknown key, limit 0 / 201', async () => { await bad('listStockBalances', { tenant_id: A })(); await bad('listStockBalances', { limit: 0 })(); await bad('listStockBalances', { limit: 201 })(); });
  it('#35 movement_kind csv with an unknown kind', bad('listStockMovements', { movement_kind: 'issue,teleport' }));
  it('#35 occurred_at_from / _to must be instants, doc_type outside the enum, ids not uuids', async () => {
    await bad('listStockMovements', { occurred_at_from: 'yesterday' })();
    await bad('listStockMovements', { occurred_at_to: '2026-11-13' })();
    await bad('listStockMovements', { doc_type: 'invoice' })();
    for (const k of ['store_id', 'item_id', 'lot_id', 'doc_id', 'instrument_id', 'attributed_test_id']) await bad('listStockMovements', { [k]: 'x' })();
  });
  it('#35 unknown key', bad('listStockMovements', { tenant_id: A }));
});

describe('T-09 #36-#39 store-scope request validation (400 / 428 before the store is read)', () => {
  const bad = (op: string, over: Req2) => async () => { const c = fresh(); await expectLims(call(op, c.ctx, { ...VALID[op], ...over }), 'common.validation_failed', 400); expect(c.tx.calls).toEqual([]); };
  type Req2 = Record<string, unknown>;
  it('#36 store_id / item_id / qty_base are all required', async () => {
    for (const k of ['store_id', 'item_id', 'qty_base']) { const q = { ...VALID['getFefoSuggestion'].query }; delete q[k]; await bad('getFefoSuggestion', { query: q })(); }
  });
  it('#36 qty_base: zero, negative, exponent, 7 decimals, 13 digits, blank, comma are all refused', async () => {
    for (const v of ['0', '0.000000', '-1', '1e3', '1.1234567', '1234567890123', '', ' ', '1,5', '+5', 'abc']) await bad('getFefoSuggestion', { query: { store_id: STORE, item_id: ITEM, qty_base: v } })();
  });
  it('#36 unknown key', bad('getFefoSuggestion', { query: { store_id: STORE, item_id: ITEM, qty_base: '1', lot_id: LOT } }));
  it('#37 store_id is required; status outside open|finished|discarded; instrument_id not a uuid; unknown key', async () => {
    await bad('listOpenedContainers', { query: {} })();
    await bad('listOpenedContainers', { query: { store_id: STORE, status: 'closed' } })();
    await bad('listOpenedContainers', { query: { store_id: STORE, instrument_id: 'BIO-1' } })();
    await bad('listOpenedContainers', { query: { store_id: STORE, tenant_id: A } })();
  });
  it('#38 store_id and item_id are required, ids must be uuids', async () => {
    await bad('openContainer', { body: { item_id: ITEM } })();
    await bad('openContainer', { body: { store_id: STORE } })();
    for (const k of ['store_id', 'item_id', 'lot_id', 'instrument_id']) await bad('openContainer', { body: newContainer(STORE, ITEM, { [k]: 'x' }) })();
  });
  it('#38 strict body: tenant_id / status / open_expiry_at / opened_by / version are not accepted (server authority, CV §4.7)', async () => {
    for (const [k, v] of [['tenant_id', A], ['status', 'finished'], ['open_expiry_at', '2030-01-01T00:00:00.000Z'], ['opened_by', uid(1)], ['version', 5], ['finished_at', '2026-11-13T00:00:00.000Z']]) await bad('openContainer', { body: newContainer(STORE, ITEM, { [k as string]: v }) })();
  });
  it('#38 opened_at must be an ISO UTC instant; notes <= 500 chars', async () => {
    for (const v of ['2026-11-13', 'yesterday', '2026-11-13T10:00:00+05:45', 12345]) await bad('openContainer', { body: newContainer(STORE, ITEM, { opened_at: v }) })();
    await bad('openContainer', { body: newContainer(STORE, ITEM, { notes: 'n'.repeat(501) }) })();
  });
  it('#38 an empty body / non-object body', async () => { for (const b of [{}, [], 'x', null]) await bad('openContainer', { body: b })(); });
  it('#39 container_id must be a uuid; If-Match missing -> 428; malformed -> 400', async () => {
    await bad('finishContainer', { params: { container_id: 'C-1' } })();
    const c = fresh();
    await expectLims(call('finishContainer', c.ctx, { ...VALID['finishContainer'], headers: {} }), 'common.precondition_required', 428);
    expect(c.tx.calls).toEqual([]);
    await bad('finishContainer', { headers: { 'if-match': 'banana' } })();
  });
  it('#39 finished_at must be an ISO UTC instant; unknown key (status) refused', async () => {
    await bad('finishContainer', { body: { finished_at: 'tomorrow' } })();
    await bad('finishContainer', { body: { status: 'discarded' } })();
    await bad('finishContainer', { body: { tenant_id: A } })();
  });
});
