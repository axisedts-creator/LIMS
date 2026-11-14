// C12.T-12 contract tests for #49-#55 (goods receipts + CSV export): permission gates, strict request schemas (400 common.validation_failed), If-Match (428 / 400), no DB access on refusals,
// x-idempotency / x-permission declarations (P-8), access log untouched on refusals. Spec: 02-TRD §4.2 / §5.4 / §5.10, contracts/openapi/inventory.yaml, 07-SECURITY P-B8 / PE-1. Seams: receipts.helpers.ts.
// The tx is DEAD here: a refusal that touches the database fails the test. Row-dependent gates (404 / 403 by branch, state machine, lots, PO, ledger) live in receipts.integration.test.ts.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { A, EXPORT, MANAGE, PERMISSION, READ, COST, call, cancelGrnBody, deadTx, expectLims, gLine, hdr, idem, ifm, makeGrnCtx, newGrn, openingGrn, rej, replaceBody, uid, window, type PoOpts } from './receipts.helpers.js';

const SUP = uid(3001), STORE = uid(1001), ITEM = uid(2001), PACK = uid(2201), GRN = uid(8001), POL = uid(8501), PO = uid(8301);
const fresh = (o: PoOpts = {}) => { const tx = deadTx(); return { tx, ...makeGrnCtx(tx, A, o) }; };
const L = [gLine(ITEM, PACK, '1')];

const VALID: Record<string, any> = {
  listGoodsReceipts: {},
  createGoodsReceipt: { headers: idem(), body: newGrn(STORE, L, { supplier_id: SUP }) },
  getGoodsReceipt: { params: { grn_id: GRN } },
  replaceGoodsReceiptDraft: { params: { grn_id: GRN }, headers: ifm(1), body: replaceBody(L, { supplier_id: SUP }) },
  postGoodsReceipt: { params: { grn_id: GRN }, headers: hdr(1) },
  cancelGoodsReceipt: { params: { grn_id: GRN }, headers: hdr(1), body: cancelGrnBody() },
  exportGoodsReceiptsCsv: { query: window() },
};
const WRITES = ['createGoodsReceipt', 'replaceGoodsReceiptDraft', 'postGoodsReceipt', 'cancelGoodsReceipt'];
const IF_MATCH_OPS = ['replaceGoodsReceiptDraft', 'postGoodsReceipt', 'cancelGoodsReceipt'];
const PATH_OPS = ['getGoodsReceipt', ...IF_MATCH_OPS];
const badBody = (op: string, body: unknown) => async () => { const c = fresh(); await expectLims(call(op, c.ctx, { ...VALID[op], body }), 'common.validation_failed', 400); expect(c.tx.calls).toEqual([]); };
const path = (e: any, p: string) => expect(JSON.stringify(e.errors ?? e.detail ?? ''), `errors should point at ${p}`).toContain(p);
const yaml = readFileSync(fileURLToPath(new URL('../../../../../../../contracts/openapi/inventory.yaml', import.meta.url)), 'utf8');
const block = (op: string) => { const m = new RegExp(`operationId: ${op}\\r?\\n`).exec(yaml); if (!m) throw new Error(`no operation ${op} in inventory.yaml`); const j = yaml.indexOf('operationId:', m.index + 10); return yaml.slice(m.index, j < 0 ? undefined : j); };

describe('T-12 contract declarations (x-idempotency P-8, x-permission P-10, error codes)', () => {
  it('#50 and #53 declare x-idempotency: required (the C0 core refuses a missing key); #54 optional; #49 #51 #52 #55 none', () => {
    for (const op of ['createGoodsReceipt', 'postGoodsReceipt']) expect(block(op)).toMatch(/x-idempotency: required/);
    expect(block('cancelGoodsReceipt')).toMatch(/x-idempotency: optional/);
    for (const op of ['listGoodsReceipts', 'getGoodsReceipt', 'replaceGoodsReceiptDraft', 'exportGoodsReceiptsCsv']) expect(block(op)).toMatch(/x-idempotency: none/);
  });
  it.each(Object.entries(PERMISSION))('%s x-permission is %s', (op, p) => { expect(block(op)).toContain(`x-permission: ${p}`); });
  it('the error codes the algorithm can return are declared per operation', () => {
    for (const c of ['inventory.po_invalid_transition', 'catalog.tax_config_missing', 'auth.mfa_required']) expect(block('createGoodsReceipt')).toContain(c);
    for (const c of ['inventory.document_invalid_transition', 'catalog.tax_config_missing', 'common.version_conflict']) expect(block('replaceGoodsReceiptDraft')).toContain(c);
    for (const c of ['inventory.document_invalid_transition', 'inventory.over_receipt', 'inventory.lot_expired', 'inventory.store_locked_for_count', 'auth.mfa_required']) expect(block('postGoodsReceipt')).toContain(c);
    for (const c of ['inventory.export_too_large', 'auth.mfa_required']) expect(block('exportGoodsReceiptsCsv')).toContain(c);
  });
});

describe('T-12 #49 listGoodsReceipts: permission first (no branchId), strict query', () => {
  it('without inventory.item.read -> 403 auth.forbidden; assertRole({permission}) without branchId; tx untouched', async () => {
    const c = fresh({ permissions: [] });
    await expectLims(call('listGoodsReceipts', c.ctx, {}), 'auth.forbidden', 403);
    expect(c.roleCalls[0]).toEqual({ permission: READ });
    expect(c.tx.calls).toEqual([]);
  });
  it('permission before validation (403, not 400)', async () => {
    const c = fresh({ permissions: [] });
    await expectLims(call('listGoodsReceipts', c.ctx, { query: { status: 'banana' } }), 'auth.forbidden', 403);
    expect(c.tx.calls).toEqual([]);
  });
  const bad = (query: Record<string, unknown>) => async () => { const c = fresh({ permissions: [READ] }); await expectLims(call('listGoodsReceipts', c.ctx, { query }), 'common.validation_failed', 400); expect(c.tx.calls).toEqual([]); };
  it('status outside draft|posted|cancelled', bad({ status: 'received' }));
  it('store_id / supplier_id / po_id must be uuids', async () => { await bad({ store_id: 'MAIN' })(); await bad({ supplier_id: 'SUP-01' })(); await bad({ po_id: 'PO260000001' })(); });
  it('received_at_from / received_at_to must be timestamps', async () => { await bad({ received_at_from: 'yesterday' })(); await bad({ received_at_to: '31/12/2026' })(); });
  it('unknown query key (tenant_id smuggle, branch_id)', async () => { await bad({ tenant_id: A })(); await bad({ branch_id: uid(1) })(); });
  it('limit 0 and limit 201', async () => { await bad({ limit: 0 })(); await bad({ limit: 201 })(); });
  it('with a valid store_id the store is read (tx touched) BEFORE any permission decision (404 beats 403, P-B8)', async () => {
    const c = fresh({ permissions: [] });
    const e = await rej(call('listGoodsReceipts', c.ctx, { query: { store_id: STORE } }));
    expect((e as { message?: string }).message).toMatch(/tx touched/);
    expect(c.roleCalls).toEqual([]);
  });
});

describe('T-12 #50 createGoodsReceipt body (strict; validation runs before any read; AC-06.1 server authority)', () => {
  const bad = (body: unknown) => badBody('createGoodsReceipt', body);
  it('a stranger with a bad body gets 400 (the permission needs the store row, which is never read for invalid input)', async () => {
    const c = fresh({ permissions: [] });
    await expectLims(call('createGoodsReceipt', c.ctx, { headers: idem(), body: { lines: [] } }), 'common.validation_failed', 400);
    expect(c.tx.calls).toEqual([]);
  });
  it('kind and store_id and lines are required; kind is purchase|opening_balance; store_id is a uuid', async () => {
    await bad({ store_id: STORE, lines: L })(); await bad({ kind: 'purchase', lines: L })(); await bad({ kind: 'purchase', store_id: STORE })();
    for (const k of ['transfer', 'PURCHASE', '', 5, null]) await bad(newGrn(STORE, L, { kind: k, supplier_id: SUP }))();
    await bad(newGrn('MAIN', L, { supplier_id: SUP }))();
  });
  it('supplier_id / po_id must be uuids', async () => { await bad(newGrn(STORE, L, { supplier_id: 'SUP-01' }))(); await bad(newGrn(STORE, L, { po_id: 'PO260000001' }))(); });
  it('lines: empty, more than 200', async () => { await bad(newGrn(STORE, [], { supplier_id: SUP }))(); await bad(newGrn(STORE, Array.from({ length: 201 }, () => gLine(ITEM, PACK, '1')), { supplier_id: SUP }))(); });
  it('qty_packs: 0, 0.000, negative, signed, > 3 decimals, > 9 integer digits, not a number, a JSON number, empty, null', async () => {
    for (const q of ['0', '0.000', '-1', '+1', '1.0001', '1234567890', 'two', '', 2, null]) await bad(newGrn(STORE, [{ item_id: ITEM, pack_id: PACK, qty_packs: q }], { supplier_id: SUP }))();
  });
  it('item_id / pack_id / qty_packs missing or not uuids', async () => {
    const b = (lines: Record<string, unknown>[]) => bad(newGrn(STORE, lines, { supplier_id: SUP }))();
    await b([{ pack_id: PACK, qty_packs: '1' }]); await b([{ item_id: ITEM, qty_packs: '1' }]); await b([{ item_id: ITEM, pack_id: PACK }]);
    await b([gLine('GLU-R1', PACK, '1')]); await b([gLine(ITEM, 'BOX', '1')]); await b([gLine(ITEM, PACK, '1', { po_line_id: 'LINE-1' })]);
  });
  it('lot_no: space, control char, non-ASCII, 65 chars, empty, a number', async () => {
    for (const v of ['L 001', 'L\t001', 'लट-1', 'L'.repeat(65), '', 5, null]) await bad(newGrn(STORE, [gLine(ITEM, PACK, '1', { lot_no: v })], { supplier_id: SUP }))();
  });
  it('expiry_on / manufactured_on must be calendar dates', async () => {
    for (const k of ['expiry_on', 'manufactured_on']) for (const v of ['tomorrow', '2026-13-01', '2026-02-30', '31-12-2026', 5, null]) await bad(newGrn(STORE, [gLine(ITEM, PACK, '1', { [k]: v })], { supplier_id: SUP }))();
  });
  it('unit_price_paisa / discount_paisa: negative, fractional, string, above 2^53-1, null', async () => {
    for (const k of ['unit_price_paisa', 'discount_paisa']) for (const v of [-1, 1.5, '100', 9007199254740992, null]) await bad(newGrn(STORE, [gLine(ITEM, PACK, '1', { [k]: v })], { supplier_id: SUP }))();
  });
  it('tax_code: lower case, 17 chars, empty, a number, and null (no null on the wire; exempt is is_exempt)', async () => {
    for (const t of ['vat', 'A'.repeat(17), '', 5, null, 'V-AT']) await bad(newGrn(STORE, [gLine(ITEM, PACK, '1', { tax_code: t })], { supplier_id: SUP }))();
  });
  it('is_exempt must be a boolean', async () => { for (const v of ['true', 1, null]) await bad(newGrn(STORE, [gLine(ITEM, PACK, '1', { is_exempt: v })], { supplier_id: SUP }))(); });
  it('is_exempt true together with a tax_code -> 400 at /lines/1/tax_code, nothing read, no tax call (D-70)', async () => {
    const c = fresh();
    const e: any = await rej(call('createGoodsReceipt', c.ctx, { headers: idem(), body: newGrn(STORE, [gLine(ITEM, PACK, '1'), gLine(ITEM, PACK, '1', { is_exempt: true, tax_code: 'VAT' })], { supplier_id: SUP }) }));
    expect(e.code).toBe('common.validation_failed'); expect(e.statusCode).toBe(400); path(e, '/lines/1/tax_code');
    expect(c.tx.calls).toEqual([]); expect(c.taxCalls).toEqual([]);
  });
  it('server-authority fields are NOT in the schema: header (grn_no, status, totals, net / vat / subtotal / discount / total, invoice_total_mismatch_paisa, posted_at, posted_by, version, created_by, tenant_id) and line (lot_id, capitalised_value_paisa, net_paisa, vat_paisa, line_total_paisa, tax_rate_bp, qty_base, line_no, id, removed_at)', async () => {
    for (const k of ['grn_no', 'status', 'total_paisa', 'subtotal_paisa', 'net_paisa', 'vat_paisa', 'discount_paisa', 'invoice_total_mismatch_paisa', 'posted_at', 'posted_by', 'version', 'created_by', 'tenant_id', 'cancelled_at', 'branch_id'])
      await bad(newGrn(STORE, L, { supplier_id: SUP, [k]: 1 }))();
    for (const k of ['lot_id', 'capitalised_value_paisa', 'net_paisa', 'vat_paisa', 'line_total_paisa', 'tax_rate_bp', 'qty_base', 'line_no', 'id', 'removed_at', 'qty_in_base_snapshot'])
      await bad(newGrn(STORE, [gLine(ITEM, PACK, '1', { [k]: 1 })], { supplier_id: SUP }))();
  });
  it('supplier_invoice_no <= 64 chars and a string; supplier_invoice_total_paisa a non-negative integer; supplier_invoice_on a date; received_at a timestamp; notes <= 1000 and a string', async () => {
    const o = (over: Record<string, unknown>) => bad(newGrn(STORE, L, { supplier_id: SUP, ...over }))();
    await o({ supplier_invoice_no: 'x'.repeat(65) }); await o({ supplier_invoice_no: 5 });
    for (const v of [-1, 1.5, '100', 9007199254740992, null]) await o({ supplier_invoice_total_paisa: v });
    for (const v of ['tomorrow', '2026-02-30', 5]) await o({ supplier_invoice_on: v });
    for (const v of ['yesterday', '2026-11-02', 5]) await o({ received_at: v });
    await o({ notes: 'x'.repeat(1001) }); await o({ notes: 5 });
  });
  it('a body that is not an object (array / string / null / missing)', async () => { for (const b of [[], 'x', null, undefined]) await bad(b)(); });
  it('the exact 200-line, 1000-char-notes, 64-char-lot boundary is valid for the schema (reaches the tx, never a 400)', async () => {
    const lines = Array.from({ length: 200 }, () => gLine(ITEM, PACK, '0.001', { lot_no: 'L'.repeat(64), expiry_on: '2027-06-30' }));
    const e = await rej(call('createGoodsReceipt', fresh().ctx, { headers: idem(), body: newGrn(STORE, lines, { supplier_id: SUP, notes: 'x'.repeat(1000), supplier_invoice_no: 'x'.repeat(64) }) }));
    expect((e as { code: string }).code).not.toBe('common.validation_failed');
  });
  it('an opening_balance body with no supplier and a purchase body with a po_id (and no supplier) are valid for the schema (reach the tx)', async () => {
    for (const body of [openingGrn(STORE, L), newGrn(STORE, [gLine(ITEM, PACK, '1', { po_line_id: POL })], { po_id: PO })]) {
      const e = await rej(call('createGoodsReceipt', fresh().ctx, { headers: idem(), body }));
      expect((e as { code: string }).code).not.toBe('common.validation_failed');
    }
  });
});

describe('T-12 #51-#54 path id and If-Match', () => {
  it.each(PATH_OPS)('%s: grn_id must be a uuid -> 400, tx untouched', async (op) => {
    const c = fresh();
    await expectLims(call(op, c.ctx, { ...VALID[op], params: { grn_id: 'GR260000001' } }), 'common.validation_failed', 400);
    expect(c.tx.calls).toEqual([]);
  });
  it.each(IF_MATCH_OPS)('%s without If-Match -> 428 common.precondition_required, tx untouched', async (op) => {
    const c = fresh();
    await expectLims(call(op, c.ctx, { ...VALID[op], headers: idem() }), 'common.precondition_required', 428);
    expect(c.tx.calls).toEqual([]);
  });
  it.each(IF_MATCH_OPS)('%s with a malformed If-Match (banana, W/"1", "0", 1, "") -> 400 common.validation_failed, tx untouched', async (op) => {
    for (const v of ['banana', 'W/"1"', '"0"', '1', '""']) {
      const c = fresh();
      await expectLims(call(op, c.ctx, { ...VALID[op], headers: { ...idem(), 'if-match': v } }), 'common.validation_failed', 400);
      expect(c.tx.calls).toEqual([]);
    }
  });
});

describe('T-12 #52 replaceGoodsReceiptDraft body: GrnDraft minus kind and store_id (lines as create)', () => {
  const bad = (body: unknown) => badBody('replaceGoodsReceiptDraft', body);
  it('lines required, 1..200; qty_packs rules as create', async () => {
    await bad({ supplier_id: SUP })(); await bad(replaceBody([]))(); await bad(replaceBody(Array.from({ length: 201 }, () => gLine(ITEM, PACK, '1'))))();
    for (const q of ['0', '-3', '1.0001', '1234567890']) await bad(replaceBody([gLine(ITEM, PACK, q)]))();
  });
  it('kind and store_id are NOT in the replace schema (the store and the kind never change)', async () => {
    await bad(replaceBody(L, { kind: 'purchase' }))(); await bad(replaceBody(L, { store_id: STORE }))();
  });
  it('unknown keys (status, version, total_paisa, grn_no, line id, tax_rate_bp, lot_id, capitalised_value_paisa)', async () => {
    for (const k of ['status', 'version', 'total_paisa', 'grn_no', 'posted_at']) await bad(replaceBody(L, { [k]: 'x' }))();
    for (const k of ['id', 'tax_rate_bp', 'net_paisa', 'removed_at', 'lot_id', 'capitalised_value_paisa']) await bad(replaceBody([gLine(ITEM, PACK, '1', { [k]: 1 })]))();
  });
  it('is_exempt true with tax_code -> 400 /lines/0/tax_code, nothing read, no tax call', async () => {
    const c = fresh();
    const e: any = await rej(call('replaceGoodsReceiptDraft', c.ctx, { ...VALID['replaceGoodsReceiptDraft'], body: replaceBody([gLine(ITEM, PACK, '1', { is_exempt: true, tax_code: 'VAT' })]) }));
    expect(e.code).toBe('common.validation_failed'); path(e, '/lines/0/tax_code'); expect(c.tx.calls).toEqual([]); expect(c.taxCalls).toEqual([]);
  });
  it('lot_no / dates / money rules as create', async () => {
    for (const v of ['L 001', 'L'.repeat(65), '']) await bad(replaceBody([gLine(ITEM, PACK, '1', { lot_no: v })]))();
    await bad(replaceBody([gLine(ITEM, PACK, '1', { expiry_on: '2026-02-30' })]))(); await bad(replaceBody([gLine(ITEM, PACK, '1', { unit_price_paisa: -1 })]))();
  });
});

describe('T-12 #53 post takes no body; #54 cancel body (strict)', () => {
  it('post: a body with keys is refused 400 (nothing to smuggle: status, lot_id, total_paisa, posted_by)', async () => {
    for (const body of [{ status: 'posted' }, { total_paisa: 1 }, { posted_by: SUP }]) { const c = fresh(); await expectLims(call('postGoodsReceipt', c.ctx, { ...VALID['postGoodsReceipt'], body }), 'common.validation_failed', 400); expect(c.tx.calls).toEqual([]); }
  });
  const cancel = (body: unknown) => badBody('cancelGoodsReceipt', body);
  it('cancel: reason_text is required, a string, at most 500 chars', async () => {
    await cancel({})(); await cancel(cancelGrnBody({ reason_text: 'x'.repeat(501) }))(); await cancel(cancelGrnBody({ reason_text: 5 }))(); await cancel(cancelGrnBody({ reason_text: null }))();
  });
  it('cancel: unknown keys (status, cancelled_by, version, reason_code)', async () => { for (const k of ['status', 'cancelled_by', 'version', 'reason_code']) await cancel(cancelGrnBody({ [k]: 'x' }))(); });
  it('cancel: a body that is not an object', async () => { for (const b of [[], 'x', null, undefined]) await cancel(b)(); });
  it('cancel: a 500-char reason is valid for the schema (reaches the tx)', async () => {
    const e = await rej(call('cancelGoodsReceipt', fresh().ctx, { ...VALID['cancelGoodsReceipt'], body: cancelGrnBody({ reason_text: 'x'.repeat(500) }) }));
    expect((e as { code: string }).code).not.toBe('common.validation_failed');
  });
});

describe('T-12 #55 exportGoodsReceiptsCsv: both permissions first (no branchId), strict query, no access-log row on a refusal', () => {
  it('without inventory.report.export -> 403 auth.forbidden; first assertRole is the export permission without branchId; tx untouched; no access log', async () => {
    const c = fresh({ permissions: [READ, MANAGE, COST] });
    await expectLims(call('exportGoodsReceiptsCsv', c.ctx, VALID['exportGoodsReceiptsCsv']), 'auth.forbidden', 403);
    expect(c.roleCalls[0]).toEqual({ permission: EXPORT });
    expect(c.tx.calls).toEqual([]); expect(c.audit).toEqual([]);
  });
  it('without inventory.cost.read -> 403 auth.forbidden even with the export permission (the export is money-only); tx untouched; no access log', async () => {
    const c = fresh({ permissions: [READ, MANAGE, EXPORT] });
    await expectLims(call('exportGoodsReceiptsCsv', c.ctx, VALID['exportGoodsReceiptsCsv']), 'auth.forbidden', 403);
    expect(c.roleCalls.map((r) => r.permission)).toContain(COST);
    expect(c.roleCalls.every((r) => r.branchId === undefined)).toBe(true);
    expect(c.tx.calls).toEqual([]); expect(c.audit).toEqual([]);
  });
  it('at aal1 the privileged export is refused 403 auth.mfa_required (PE-1); tx untouched; no access log', async () => {
    const c = fresh({ aal: 'aal1' });
    await expectLims(call('exportGoodsReceiptsCsv', c.ctx, VALID['exportGoodsReceiptsCsv']), 'auth.mfa_required', 403);
    expect(c.tx.calls).toEqual([]); expect(c.audit).toEqual([]);
  });
  it('permission before validation (403, not 400)', async () => {
    const c = fresh({ permissions: [] });
    await expectLims(call('exportGoodsReceiptsCsv', c.ctx, { query: { posted_at_from: 'x' } }), 'auth.forbidden', 403);
    expect(c.tx.calls).toEqual([]);
  });
  const bad = (query: Record<string, unknown>) => async () => { const c = fresh(); await expectLims(call('exportGoodsReceiptsCsv', c.ctx, { query }), 'common.validation_failed', 400); expect(c.tx.calls).toEqual([]); expect(c.audit).toEqual([]); };
  it('posted_at_from and posted_at_to are required timestamps', async () => {
    await bad({})(); await bad({ posted_at_from: window().posted_at_from })(); await bad({ posted_at_to: window().posted_at_to })();
    for (const v of ['yesterday', '2026-03-01', '31/03/2026', 5, '']) { await bad(window({ posted_at_from: v }))(); await bad(window({ posted_at_to: v }))(); }
  });
  it('store_id must be a uuid; unknown keys (tenant_id, branch_id, status, limit) are refused', async () => {
    await bad(window({ store_id: 'MAIN' }))();
    for (const k of ['tenant_id', 'branch_id', 'status', 'limit', 'format']) await bad(window({ [k]: A }))();
  });
  it('a range over 366 days is refused (400 validation_failed or 422 range / export too large), tx untouched, no access log; exactly 366 days reaches the tx', async () => {
    const c = fresh();
    const e = await rej(call('exportGoodsReceiptsCsv', c.ctx, { query: { posted_at_from: '2026-01-01T00:00:00.000Z', posted_at_to: '2027-01-03T00:00:00.000Z' } })); // 367 days
    expect([400, 422]).toContain((e as { statusCode?: number }).statusCode);
    expect(['common.validation_failed', 'inventory.range_too_large', 'inventory.export_too_large']).toContain((e as { code: string }).code);
    expect(c.tx.calls).toEqual([]); expect(c.audit).toEqual([]);
    const ok = await rej(call('exportGoodsReceiptsCsv', fresh().ctx, { query: { posted_at_from: '2026-01-01T00:00:00.000Z', posted_at_to: '2027-01-02T00:00:00.000Z' } })); // 366 days
    expect((ok as { message?: string }).message).toMatch(/tx touched/);
  });
  it('a reversed range (to before from) is refused 400, tx untouched', async () => { await bad({ posted_at_from: '2026-04-01T00:00:00.000Z', posted_at_to: '2026-03-01T00:00:00.000Z' })(); });
});

describe('T-12 writes: the permission is asserted per branch, never tenant-wide, once a row is loaded (404 beats 403, P-B8)', () => {
  it.each(WRITES)('%s with a valid request touches the tx (the scope read) before any permission decision', async (op) => {
    const c = fresh({ permissions: [] });
    const e = await rej(call(op, c.ctx, VALID[op]));
    expect((e as { message?: string }).message).toMatch(/tx touched/);
    expect(c.roleCalls).toEqual([]);
  });
  it('createGoodsReceipt of kind opening_balance also reads the store first (the adjust permission is per branch)', async () => {
    const c = fresh({ permissions: [] });
    const e = await rej(call('createGoodsReceipt', c.ctx, { headers: idem(), body: openingGrn(STORE, L) }));
    expect((e as { message?: string }).message).toMatch(/tx touched/);
    expect(c.roleCalls).toEqual([]);
  });
  it('getGoodsReceipt reads the GRN before the permission decision too', async () => {
    const c = fresh({ permissions: [] });
    const e = await rej(call('getGoodsReceipt', c.ctx, VALID['getGoodsReceipt']));
    expect((e as { message?: string }).message).toMatch(/tx touched/);
    expect(c.roleCalls).toEqual([]);
  });
});
