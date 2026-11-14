// C12.T-10 contract tests for #40-#48 (container discard + stock documents): permission gates, strict request schemas (400 common.validation_failed), If-Match on #40 (428 / 400), no DB access on refusals.
// Spec: 02-TRD §5.2 #40, §5.3 #41-#48, §5.11, contracts/openapi/inventory.yaml (query / body schemas), 07-SECURITY P-B1 / P-B2 / P-B8, PE-1. Seams: documents.helpers.ts.
// The tx is DEAD here: a refusal that touches the database fails the test. Row-dependent gates (404 / 403 by branch, reasons, lots, stock) live in documents.integration.test.ts.
import { describe, expect, it } from 'vitest';
import { A, ADJUST, BENCH, MANAGE, PERMISSION, READ, adjustBody, aLine, call, dLine, deadTx, discardBody, expectLims, ifm, issueBody, makeDocCtx, rej, returnBody, supplierReturnBody, uid, wastageBody, writeoffBody, type LotOpts }
  from './documents.helpers.js';

const STORE = uid(1001), ITEM = uid(2001), LOT = uid(4001), PACK = uid(2201), SUP = uid(3001), GRN = uid(8002), DOC = uid(9001), CONT = uid(9301), DEPT = uid(15900), INSTR = uid(421);
const fresh = (o: LotOpts = {}) => { const tx = deadTx(); return { tx, ...makeDocCtx(tx, A, o) }; };

const VALID: Record<string, any> = {
  discardContainer: { params: { container_id: CONT }, headers: ifm(1), body: discardBody('1') },
  listStockDocuments: {},
  getStockDocument: { params: { document_id: DOC } },
  createStockIssue: { body: issueBody(STORE, [dLine(ITEM, '10', LOT)]) },
  createStoreReturn: { body: returnBody(STORE, [dLine(ITEM, '2', LOT)]) },
  createSupplierReturn: { body: supplierReturnBody(STORE, SUP, [dLine(ITEM, '1', LOT, { pack_id: PACK })], { grn_id: GRN }) },
  recordWastage: { body: wastageBody(STORE, [dLine(ITEM, '1', LOT)]) },
  writeOffExpiredStock: { body: writeoffBody(STORE, [LOT]) },
  createStockAdjustment: { body: adjustBody(STORE, [aLine(ITEM, 'out', '1', LOT)]) },
};
const WRITES = ['discardContainer', 'createStockIssue', 'createStoreReturn', 'createSupplierReturn', 'recordWastage', 'writeOffExpiredStock', 'createStockAdjustment'];
const LINE_OPS = ['createStockIssue', 'createStoreReturn', 'createSupplierReturn', 'recordWastage', 'createStockAdjustment'];
const REASON_OPS = ['createSupplierReturn', 'recordWastage', 'createStockAdjustment'];
const bodyOf = (op: string, patch: (b: any) => any) => patch(JSON.parse(JSON.stringify(VALID[op].body)));
const badBody = (op: string, body: unknown, code = 'common.validation_failed', status = 400) => async () => {
  const c = fresh(); await expectLims(call(op, c.ctx, { ...VALID[op], body }), code, status); expect(c.tx.calls).toEqual([]);
};

describe('T-10 #41 listStockDocuments: permission first when no store_id, strict query', () => {
  it('without inventory.item.read and without store_id -> 403; assertRole({permission}) without branchId; tx untouched', async () => {
    const c = fresh({ permissions: [] });
    await expectLims(call('listStockDocuments', c.ctx, VALID['listStockDocuments']), 'auth.forbidden', 403);
    expect(c.roleCalls[0]).toEqual({ permission: PERMISSION['listStockDocuments'] });
    expect(c.tx.calls).toEqual([]);
  });
  it('permission before validation: a stranger with a bad query learns nothing (403, not 400)', async () => {
    const c = fresh({ permissions: [] });
    await expectLims(call('listStockDocuments', c.ctx, { query: { doc_kind: 'banana' } }), 'auth.forbidden', 403);
    expect(c.tx.calls).toEqual([]);
  });
  it('with store_id the store is read first (404 beats 403): the tx is touched, no assertRole before the row', async () => {
    const c = fresh({ permissions: [] });
    const e = await rej(call('listStockDocuments', c.ctx, { query: { store_id: STORE } }));
    expect((e as { message?: string }).message).toMatch(/tx touched/);
    expect(c.roleCalls).toEqual([]);
  });
  const bad = (query: Record<string, unknown>) => async () => { const c = fresh({ permissions: [READ] }); await expectLims(call('listStockDocuments', c.ctx, { query }), 'common.validation_failed', 400); expect(c.tx.calls).toEqual([]); };
  it('doc_kind outside the six kinds', bad({ doc_kind: 'transfer' }));
  it('store_id must be a uuid', bad({ store_id: 'MAIN-A' }));
  it('occurred_at_from / _to must be ISO UTC instants', async () => { await bad({ occurred_at_from: '2026-11-02' })(); await bad({ occurred_at_to: 'yesterday' })(); });
  it('unknown query key (tenant_id smuggle)', bad({ tenant_id: A }));
  it('limit 0 and limit 201', async () => { await bad({ limit: 0 })(); await bad({ limit: 201 })(); });
});

describe('T-10 #42 getStockDocument', () => {
  it('document_id must be a uuid -> 400, tx untouched', async () => {
    const c = fresh();
    await expectLims(call('getStockDocument', c.ctx, { params: { document_id: 'SD260000001' } }), 'common.validation_failed', 400);
    expect(c.tx.calls).toEqual([]);
  });
});

describe('T-10 #43-#48 shared body rules (strict; validation runs before any read)', () => {
  it.each(WRITES.filter((o) => o !== 'discardContainer'))('%s: a stranger with a bad body gets 400 (the permission needs the store row, which is never read for invalid input)', async (op) => {
    const c = fresh({ permissions: [] });
    await expectLims(call(op, c.ctx, { body: { lines: [] } }), 'common.validation_failed', 400);
    expect(c.tx.calls).toEqual([]);
  });
  it.each(WRITES.filter((o) => o !== 'discardContainer'))('%s: store_id is required and must be a uuid', async (op) => {
    await badBody(op, bodyOf(op, (b) => { delete b.store_id; return b; }))();
    await badBody(op, bodyOf(op, (b) => ({ ...b, store_id: 'MAIN-A' })))();
  });
  it.each(WRITES.filter((o) => o !== 'discardContainer'))('%s: unknown body keys (tenant_id, doc_no, doc_kind, status, version, id) are refused', async (op) => {
    for (const k of ['tenant_id', 'doc_no', 'doc_kind', 'status', 'version', 'id']) await badBody(op, bodyOf(op, (b) => ({ ...b, [k]: 'x' })))();
  });
  it.each(WRITES.filter((o) => o !== 'discardContainer'))('%s: a body that is not an object (array / string / null / missing)', async (op) => {
    for (const b of [[], 'x', null, undefined]) await badBody(op, b)();
  });
  it.each(['createStockIssue', 'createStoreReturn', 'recordWastage', 'createStockAdjustment'])('%s: occurred_at must be an ISO UTC instant', async (op) => {
    for (const v of ['2026-11-02', 'yesterday', 5, null]) await badBody(op, bodyOf(op, (b) => ({ ...b, occurred_at: v })))();
  });
  it.each(['createSupplierReturn', 'writeOffExpiredStock'])('%s: occurred_at is NOT in the contract body (additionalProperties: false) -> 400', async (op) => {
    await badBody(op, bodyOf(op, (b) => ({ ...b, occurred_at: new Date().toISOString() })))();
  });
  it.each(['createStockIssue', 'createStoreReturn', ...REASON_OPS])('%s: reason_text longer than 500 chars / not a string', async (op) => {
    await badBody(op, bodyOf(op, (b) => ({ ...b, reason_text: 'x'.repeat(501) })))(); await badBody(op, bodyOf(op, (b) => ({ ...b, reason_text: 5 })))();
  });
});

describe('T-10 #43-#46, #48 lines (strict)', () => {
  const lineBad = (op: string, line: unknown) => badBody(op, bodyOf(op, (b) => ({ ...b, lines: [line] })));
  it.each(LINE_OPS)('%s: lines missing, empty, more than 200, not an array', async (op) => {
    await badBody(op, bodyOf(op, (b) => { delete b.lines; return b; }))();
    await badBody(op, bodyOf(op, (b) => ({ ...b, lines: [] })))();
    await badBody(op, bodyOf(op, (b) => ({ ...b, lines: Array.from({ length: 201 }, () => b0(op)) })))();
    await badBody(op, bodyOf(op, (b) => ({ ...b, lines: 'x' })))();
  });
  const b0 = (op: string) => VALID[op].body.lines[0];
  it.each(LINE_OPS)('%s: qty 0, negative, signed, > 6 decimals, > 12 digits, not a number, a JSON number, empty, null', async (op) => {
    for (const q of ['0', '0.000000', '-1', '+1', '1.1234567', '1234567890123', 'ten', '', 10, null]) await lineBad(op, { ...b0(op), qty: q })();
  });
  it.each(LINE_OPS)('%s: qty missing, item_id missing / not a uuid, lot_id not a uuid, pack_id not a uuid', async (op) => {
    const { qty: _q, ...noQty } = b0(op); const { item_id: _i, ...noItem } = b0(op);
    await lineBad(op, noQty)(); await lineBad(op, noItem)(); await lineBad(op, { ...b0(op), item_id: 'GLU-R1' })(); await lineBad(op, { ...b0(op), lot_id: 'L-001' })(); await lineBad(op, { ...b0(op), pack_id: 'BOX' })();
  });
  it.each(LINE_OPS)('%s: unknown line keys (qty_base, value_paisa, line_no, id, removed_at)', async (op) => {
    for (const k of ['qty_base', 'value_paisa', 'line_no', 'id', 'removed_at']) await lineBad(op, { ...b0(op), [k]: 1 })();
  });
  it('#45 lot_id is REQUIRED on every line (a supplier return names the lot)', async () => {
    const { lot_id: _l, ...noLot } = VALID['createSupplierReturn'].body.lines[0];
    await badBody('createSupplierReturn', bodyOf('createSupplierReturn', (b) => ({ ...b, lines: [noLot] })))();
  });
  it('#48 direction is required and is exactly "in" or "out"', async () => {
    const { direction: _d, ...noDir } = b0('createStockAdjustment');
    await lineBad('createStockAdjustment', noDir)();
    for (const d of ['IN', 'Out', 'inbound', '', 1, null]) await lineBad('createStockAdjustment', { ...b0('createStockAdjustment'), direction: d })();
  });
  it('#43 / #44 / #46 have no direction on the line (the kind decides it)', async () => {
    for (const op of ['createStockIssue', 'createStoreReturn', 'recordWastage']) await lineBad(op, { ...b0(op), direction: 'out' })();
  });
  it('#46 the optional per-line reason_code is a well-formed code (spaces / upper case / 33 chars / number)', async () => {
    for (const r of ['Not A Code', 'SPILLAGE', 'a'.repeat(33), 5]) await lineBad('recordWastage', { ...b0('recordWastage'), reason_code: r })();
  });
  it('#43 / #44 / #45 / #48 have no per-line reason_code (only #46 has)', async () => {
    for (const op of ['createStockIssue', 'createStoreReturn', 'createSupplierReturn', 'createStockAdjustment']) await lineBad(op, { ...b0(op), reason_code: 'spillage' })();
  });
  it('the exact 200-line boundary with the smallest quantity is valid for the schema (reaches the tx: the dead tx is touched, never a 400)', async () => {
    for (const op of ['createStockIssue', 'createStoreReturn', 'recordWastage']) {
      const c = fresh();
      const e = await rej(call(op, c.ctx, { body: bodyOf(op, (b) => ({ ...b, lines: Array.from({ length: 200 }, () => dLine(ITEM, '0.000001', LOT)) })) }));
      expect((e as { code?: string }).code).not.toBe('common.validation_failed');
    }
  });
});

describe('T-10 #43 createStockIssue target (issued_to_kind)', () => {
  const L = [dLine(ITEM, '1', LOT)];
  it('issued_to_kind is required and one of department | instrument | general', async () => {
    await badBody('createStockIssue', { store_id: STORE, lines: L })();
    for (const k of ['ward', 'Department', '', null, 1]) await badBody('createStockIssue', issueBody(STORE, L, { issued_to_kind: k }))();
  });
  it('department needs department_id; instrument needs instrument_id (the DB CHECK is never the first line of defence)', async () => {
    await badBody('createStockIssue', issueBody(STORE, L, { issued_to_kind: 'department' }))();
    await badBody('createStockIssue', issueBody(STORE, L, { issued_to_kind: 'instrument' }))();
  });
  it('department_id / instrument_id must be uuids', async () => {
    await badBody('createStockIssue', issueBody(STORE, L, { issued_to_kind: 'department', department_id: 'Biochemistry' }))();
    await badBody('createStockIssue', issueBody(STORE, L, { issued_to_kind: 'instrument', instrument_id: 'IN-A1' }))();
  });
  it('department / instrument targets with ids are valid for the schema (reach the tx)', async () => {
    for (const body of [issueBody(STORE, L, { issued_to_kind: 'department', department_id: DEPT }), issueBody(STORE, L, { issued_to_kind: 'instrument', instrument_id: INSTR })]) {
      const c = fresh(); const e = await rej(call('createStockIssue', c.ctx, { body }));
      expect((e as { code?: string }).code).not.toBe('common.validation_failed');
    }
  });
});

describe('T-10 #44-#46, #48 header fields', () => {
  it('#44 has no reason_code / issued_to_kind / supplier_id on the document (strict)', async () => {
    for (const k of ['reason_code', 'issued_to_kind', 'supplier_id']) await badBody('createStoreReturn', bodyOf('createStoreReturn', (b) => ({ ...b, [k]: 'x' })))();
  });
  it('#45 supplier_id is required and a uuid; grn_id a uuid', async () => {
    await badBody('createSupplierReturn', bodyOf('createSupplierReturn', (b) => { delete b.supplier_id; return b; }))();
    await badBody('createSupplierReturn', bodyOf('createSupplierReturn', (b) => ({ ...b, supplier_id: 'SUP-01' })))();
    await badBody('createSupplierReturn', bodyOf('createSupplierReturn', (b) => ({ ...b, grn_id: 'GR260000002' })))();
  });
  it.each(REASON_OPS)('%s: a MALFORMED reason_code (spaces, upper case, 33 chars, a number) is 400 (an OMITTED one is 422 inventory.reason_required, integration tests)', async (op) => {
    for (const r of ['Not A Code', 'DAMAGED', 'a'.repeat(33), 5]) await badBody(op, bodyOf(op, (b) => ({ ...b, reason_code: r })))();
  });
  it('#46 / #45 / #48 do not accept issued_to_kind / department_id / instrument_id', async () => {
    for (const op of REASON_OPS) for (const k of ['issued_to_kind', 'department_id', 'instrument_id']) await badBody(op, bodyOf(op, (b) => ({ ...b, [k]: 'general' })))();
  });
});

describe('T-10 #47 writeOffExpiredStock body', () => {
  it('lot_ids: missing, empty, more than 200, not an array, a non-uuid member', async () => {
    await badBody('writeOffExpiredStock', { store_id: STORE })();
    await badBody('writeOffExpiredStock', writeoffBody(STORE, []))();
    await badBody('writeOffExpiredStock', writeoffBody(STORE, Array.from({ length: 201 }, (_, i) => uid(30000 + i))))();
    await badBody('writeOffExpiredStock', { store_id: STORE, lot_ids: LOT })();
    await badBody('writeOffExpiredStock', writeoffBody(STORE, ['L-001']))();
  });
  it('the same lot id twice in one request (it would write the lot off twice)', badBody('writeOffExpiredStock', writeoffBody(STORE, [LOT, LOT])));
  it('no lines / reason_code / reason_text on the request (the server reads the full balance)', async () => {
    for (const k of ['lines', 'reason_code', 'reason_text', 'qty']) await badBody('writeOffExpiredStock', writeoffBody(STORE, [LOT], { [k]: 'x' }))();
  });
  it('200 lot ids exactly is valid for the schema (reaches the tx)', async () => {
    const c = fresh();
    const e = await rej(call('writeOffExpiredStock', c.ctx, { body: writeoffBody(STORE, Array.from({ length: 200 }, (_, i) => uid(30000 + i))) }));
    expect((e as { code?: string }).code).not.toBe('common.validation_failed');
  });
});

describe('T-10 #40 discardContainer: path id, If-Match, strict body', () => {
  it('container_id must be a uuid -> 400, tx untouched', async () => {
    const c = fresh();
    await expectLims(call('discardContainer', c.ctx, { ...VALID['discardContainer'], params: { container_id: 'C-9301' } }), 'common.validation_failed', 400);
    expect(c.tx.calls).toEqual([]);
  });
  it('without If-Match -> 428 common.precondition_required, tx untouched', async () => {
    const c = fresh();
    await expectLims(call('discardContainer', c.ctx, { ...VALID['discardContainer'], headers: {} }), 'common.precondition_required', 428);
    expect(c.tx.calls).toEqual([]);
  });
  it('a malformed If-Match (banana, W/"1", "0", 1, "") -> 400, tx untouched', async () => {
    for (const v of ['banana', 'W/"1"', '"0"', '1', '""']) {
      const c = fresh();
      await expectLims(call('discardContainer', c.ctx, { ...VALID['discardContainer'], headers: { 'if-match': v } }), 'common.validation_failed', 400);
      expect(c.tx.calls).toEqual([]);
    }
  });
  const bad = (body: unknown) => async () => { const c = fresh(); await expectLims(call('discardContainer', c.ctx, { ...VALID['discardContainer'], body }), 'common.validation_failed', 400); expect(c.tx.calls).toEqual([]); };
  it('qty_base is required: missing, 0, negative, signed, 7 decimals, 13 digits, not a number, a JSON number, null', async () => {
    await bad({ reason_code: 'spillage' })();
    for (const q of ['0', '0.000000', '-1', '+1', '1.1234567', '1234567890123', 'all', '', 5, null]) await bad(discardBody(q as string))();
  });
  it('a MALFORMED reason_code is 400 (spaces / upper case / 33 chars / number); an omitted one is 422 (integration)', async () => {
    for (const r of ['Not A Code', 'SPILLAGE', 'a'.repeat(33), 5]) await bad(discardBody('1', { reason_code: r }))();
  });
  it('reason_text > 500 / not a string; unknown keys (status, lot_id, store_id, version, document_id)', async () => {
    await bad(discardBody('1', { reason_text: 'x'.repeat(501) }))(); await bad(discardBody('1', { reason_text: 5 }))();
    for (const k of ['status', 'lot_id', 'store_id', 'version', 'document_id', 'tenant_id']) await bad(discardBody('1', { [k]: 'x' }))();
  });
  it('a body that is not an object (array / string / null / missing)', async () => { for (const b of [[], 'x', null, undefined]) await bad(b)(); });
  it('6-decimal quantity and 500-char reason_text are valid for the schema (reach the tx)', async () => {
    const c = fresh();
    const e = await rej(call('discardContainer', c.ctx, { ...VALID['discardContainer'], body: discardBody('0.000001', { reason_text: 'x'.repeat(500) }) }));
    expect((e as { code?: string }).code).not.toBe('common.validation_failed');
  });
});

describe('T-10 writes: the permission is asserted per branch, never tenant-wide, once a row is loaded (P-B8)', () => {
  it.each([...WRITES, 'getStockDocument'])('%s with a valid request touches the tx (the scope read) before any permission decision', async (op) => {
    const c = fresh({ permissions: [] });
    const e = await rej(call(op, c.ctx, VALID[op]));
    expect((e as { message?: string }).message).toMatch(/tx touched/); // 404 beats 403: no assertRole may precede the row read
    expect(c.roleCalls).toEqual([]);
  });
  it('the permission map the integration tests rely on is the TRD one', () => {
    expect(PERMISSION).toMatchObject({ createStockIssue: MANAGE, createStockAdjustment: ADJUST, discardContainer: BENCH });
  });
});
