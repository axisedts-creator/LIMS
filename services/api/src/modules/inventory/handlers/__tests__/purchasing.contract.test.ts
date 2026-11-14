// C12.T-11 contract tests for #80-#89 (purchase orders): permission gate on the list, strict request schemas (400 common.validation_failed), If-Match (428 / 400), no DB access on refusals,
// Idempotency-Key declaration (P-8). Spec: 02-TRD §4.2 / §5.5 #80-#89, contracts/openapi/inventory.yaml, 07-SECURITY P-B8 / PE-1. Seams: purchasing.helpers.ts.
// The tx is DEAD here: a refusal that touches the database fails the test. Row-dependent gates (404 / 403 by branch, state machine) live in purchasing.integration.test.ts.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { A, PERMISSION, READ, call, cancelBody, closeBody, deadTx, expectLims, hdr, idem, ifm, makePoCtx, newPo, poLine, reorderBody, rej, sentBody, uid, type PoOpts } from './purchasing.helpers.js';

const SUP = uid(3001), STORE = uid(1001), ITEM = uid(2001), PACK = uid(2201), PO = uid(8301);
const fresh = (o: PoOpts = {}) => { const tx = deadTx(); return { tx, ...makePoCtx(tx, A, o) }; };
const L = [poLine(ITEM, PACK, '1')];

const VALID: Record<string, any> = {
  listPurchaseOrders: {},
  createPurchaseOrder: { headers: idem(), body: newPo(SUP, STORE, L) },
  getPurchaseOrder: { params: { po_id: PO } },
  replacePurchaseOrderDraft: { params: { po_id: PO }, headers: ifm(1), body: newPo(SUP, STORE, L) },
  approvePurchaseOrder: { params: { po_id: PO }, headers: hdr(1) },
  markPurchaseOrderSent: { params: { po_id: PO }, headers: ifm(1), body: sentBody() },
  cancelPurchaseOrder: { params: { po_id: PO }, headers: hdr(1), body: cancelBody() },
  closePurchaseOrder: { params: { po_id: PO }, headers: hdr(1), body: closeBody() },
  createPurchaseOrdersFromReorder: { headers: idem(), body: reorderBody(STORE) },
  getPurchaseOrderPrintView: { params: { po_id: PO } },
};
const WRITES = ['createPurchaseOrder', 'replacePurchaseOrderDraft', 'approvePurchaseOrder', 'markPurchaseOrderSent', 'cancelPurchaseOrder', 'closePurchaseOrder', 'createPurchaseOrdersFromReorder'];
const IF_MATCH_OPS = ['replacePurchaseOrderDraft', 'approvePurchaseOrder', 'markPurchaseOrderSent', 'cancelPurchaseOrder', 'closePurchaseOrder'];
const PATH_OPS = ['getPurchaseOrder', 'getPurchaseOrderPrintView', ...IF_MATCH_OPS];
const IDEM_REQUIRED_HANDLER = ['approvePurchaseOrder', 'cancelPurchaseOrder', 'closePurchaseOrder']; // brief: "Idempotency-Key required on #84/#86/#87 (P-8)"
const badBody = (op: string, body: unknown) => async () => { const c = fresh(); await expectLims(call(op, c.ctx, { ...VALID[op], body }), 'common.validation_failed', 400); expect(c.tx.calls).toEqual([]); };
const path = (e: any, p: string) => expect(JSON.stringify(e.errors ?? e.detail ?? ''), `errors should point at ${p}`).toContain(p);

describe('T-11 Idempotency-Key (P-8): x-idempotency in the contract, and the key is mandatory on #84 / #86 / #87', () => {
  const yaml = readFileSync(fileURLToPath(new URL('../../../../../../../contracts/openapi/inventory.yaml', import.meta.url)), 'utf8');
  const block = (op: string) => { const m = new RegExp(`operationId: ${op}\\r?\\n`).exec(yaml); if (!m) throw new Error(`no operation ${op} in inventory.yaml`); const j = yaml.indexOf('operationId:', m.index + 10); return yaml.slice(m.index, j < 0 ? undefined : j); };
  it.each(['createPurchaseOrder', 'approvePurchaseOrder', 'cancelPurchaseOrder', 'closePurchaseOrder', 'createPurchaseOrdersFromReorder'])('%s declares x-idempotency: required (the C0 core refuses a missing key)', (op) => {
    expect(block(op)).toMatch(/x-idempotency: required/);
  });
  it('markPurchaseOrderSent is optional, replacePurchaseOrderDraft and the reads are none', () => {
    expect(block('markPurchaseOrderSent')).toMatch(/x-idempotency: optional/);
    for (const op of ['replacePurchaseOrderDraft', 'listPurchaseOrders', 'getPurchaseOrder', 'getPurchaseOrderPrintView']) expect(block(op)).toMatch(/x-idempotency: none/);
  });
  it.each(IDEM_REQUIRED_HANDLER)('%s without an Idempotency-Key header -> 400 common.idempotency_key_required, tx untouched (the handler never runs a money / state change unkeyed)', async (op) => {
    const c = fresh();
    await expectLims(call(op, c.ctx, { ...VALID[op], headers: ifm(1) }), 'common.idempotency_key_required', 400);
    expect(c.tx.calls).toEqual([]);
    const d = fresh();
    await expectLims(call(op, d.ctx, { ...VALID[op], headers: { ...ifm(1), 'idempotency-key': '' } }), 'common.idempotency_key_required', 400);
    expect(d.tx.calls).toEqual([]);
  });
  it('markPurchaseOrderSent without a key is NOT refused for the key (optional): it reaches the tx', async () => {
    const e = await rej(call('markPurchaseOrderSent', fresh().ctx, { ...VALID['markPurchaseOrderSent'], headers: ifm(1) }));
    expect((e as { code: string }).code).not.toBe('common.idempotency_key_required');
  });
});

describe('T-11 #80 listPurchaseOrders: permission first (no branchId), strict query', () => {
  it('without inventory.item.read -> 403 auth.forbidden; assertRole({permission}) without branchId; tx untouched', async () => {
    const c = fresh({ permissions: [] });
    await expectLims(call('listPurchaseOrders', c.ctx, {}), 'auth.forbidden', 403);
    expect(c.roleCalls[0]).toEqual({ permission: PERMISSION['listPurchaseOrders'] });
    expect(c.tx.calls).toEqual([]);
  });
  it('permission before validation (403, not 400)', async () => {
    const c = fresh({ permissions: [] });
    await expectLims(call('listPurchaseOrders', c.ctx, { query: { status: 'banana' } }), 'auth.forbidden', 403);
    expect(c.tx.calls).toEqual([]);
  });
  const bad = (query: Record<string, unknown>) => async () => { const c = fresh({ permissions: [READ] }); await expectLims(call('listPurchaseOrders', c.ctx, { query }), 'common.validation_failed', 400); expect(c.tx.calls).toEqual([]); };
  it('status outside the PO enum', bad({ status: 'in_transit' }));
  it('supplier_id / branch_id must be uuids', async () => { await bad({ supplier_id: 'SUP-01' })(); await bad({ branch_id: 'BR1' })(); });
  it('created_at_from / created_at_to must be timestamps', async () => { await bad({ created_at_from: 'yesterday' })(); await bad({ created_at_to: '31/12/2026' })(); });
  it('unknown query key (tenant_id smuggle)', bad({ tenant_id: A }));
  it('limit 0 and limit 201', async () => { await bad({ limit: 0 })(); await bad({ limit: 201 })(); });
});

describe('T-11 #81 createPurchaseOrder body (strict; validation runs before any read; AC-05.1 "a client-sent total is not accepted")', () => {
  const bad = (body: unknown) => badBody('createPurchaseOrder', body);
  it('a stranger with a bad body gets 400 (the permission needs the store row, which is never read for invalid input)', async () => {
    const c = fresh({ permissions: [] });
    await expectLims(call('createPurchaseOrder', c.ctx, { headers: idem(), body: { lines: [] } }), 'common.validation_failed', 400);
    expect(c.tx.calls).toEqual([]);
  });
  it('supplier_id / store_id / lines are required; ids must be uuids', async () => {
    await bad({ store_id: STORE, lines: L })(); await bad({ supplier_id: SUP, lines: L })(); await bad({ supplier_id: SUP, store_id: STORE })();
    await bad(newPo('SUP-01', STORE, L))(); await bad(newPo(SUP, 'BR1-MAIN', L))();
  });
  it('lines: empty, more than 200', async () => { await bad(newPo(SUP, STORE, []))(); await bad(newPo(SUP, STORE, Array.from({ length: 201 }, () => poLine(ITEM, PACK, '1'))))(); });
  it('qty_packs: 0, 0.000, negative, signed, > 3 decimals, > 9 integer digits, not a number, a JSON number, empty, null', async () => {
    for (const q of ['0', '0.000', '-1', '+1', '1.0001', '1234567890', 'two', '', 2, null]) await bad(newPo(SUP, STORE, [{ item_id: ITEM, pack_id: PACK, qty_packs: q }]))();
  });
  it('item_id / pack_id / qty_packs missing or not uuids', async () => {
    await bad(newPo(SUP, STORE, [{ pack_id: PACK, qty_packs: '1' }]))(); await bad(newPo(SUP, STORE, [{ item_id: ITEM, qty_packs: '1' }]))(); await bad(newPo(SUP, STORE, [{ item_id: ITEM, pack_id: PACK }]))();
    await bad(newPo(SUP, STORE, [poLine('GLU-R1', PACK, '1')]))(); await bad(newPo(SUP, STORE, [poLine(ITEM, 'BOX', '1')]))();
  });
  it('unit_price_paisa / discount_paisa: negative, fractional, string, above 2^53-1, null', async () => {
    for (const k of ['unit_price_paisa', 'discount_paisa']) for (const v of [-1, 1.5, '100', 9007199254740992, null]) await bad(newPo(SUP, STORE, [poLine(ITEM, PACK, '1', { [k]: v })]))();
  });
  it('tax_code: lower case, 17 chars, empty, a number, and null (no null on the wire; exempt is is_exempt)', async () => {
    for (const t of ['vat', 'A'.repeat(17), '', 5, null, 'V-AT']) await bad(newPo(SUP, STORE, [poLine(ITEM, PACK, '1', { tax_code: t })]))();
  });
  it('is_exempt must be a boolean', async () => { for (const v of ['true', 1, null]) await bad(newPo(SUP, STORE, [poLine(ITEM, PACK, '1', { is_exempt: v })]))(); });
  it('is_exempt true together with a tax_code -> 400 at /lines/1/tax_code, nothing read (D-70)', async () => {
    const c = fresh();
    const e: any = await rej(call('createPurchaseOrder', c.ctx, { headers: idem(), body: newPo(SUP, STORE, [poLine(ITEM, PACK, '1'), poLine(ITEM, PACK, '1', { is_exempt: true, tax_code: 'VAT' })]) }));
    expect(e.code).toBe('common.validation_failed'); expect(e.statusCode).toBe(400); path(e, '/lines/1/tax_code');
    expect(c.tx.calls).toEqual([]); expect(c.taxCalls).toEqual([]);
  });
  it('server-authority fields are NOT in the schema: body (total_paisa, subtotal_paisa, net_paisa, vat_paisa, discount_paisa, status, po_no, source, branch_id, version, approved_by) and line (net_paisa, vat_paisa, line_total_paisa, tax_rate_bp, qty_base, line_no, received_qty_base, removed_at, id)', async () => {
    for (const k of ['total_paisa', 'subtotal_paisa', 'net_paisa', 'vat_paisa', 'discount_paisa', 'status', 'po_no', 'source', 'branch_id', 'version', 'approved_by', 'tenant_id']) await bad(newPo(SUP, STORE, L, { [k]: 1 }))();
    for (const k of ['net_paisa', 'vat_paisa', 'line_total_paisa', 'tax_rate_bp', 'qty_base', 'line_no', 'received_qty_base', 'removed_at', 'id']) await bad(newPo(SUP, STORE, [poLine(ITEM, PACK, '1', { [k]: 1 })]))();
  });
  it('expected_on must be a calendar date; notes at most 1000 chars and a string', async () => {
    for (const v of ['tomorrow', '2026-13-01', '2026-02-30', '31-12-2026', 5]) await bad(newPo(SUP, STORE, L, { expected_on: v }))();
    await bad(newPo(SUP, STORE, L, { notes: 'x'.repeat(1001) }))(); await bad(newPo(SUP, STORE, L, { notes: 5 }))();
  });
  it('a body that is not an object (array / string / null / missing)', async () => { for (const b of [[], 'x', null, undefined]) await bad(b)(); });
  it('the exact 200-line, 1000-char-notes boundary is valid for the schema (reaches the tx, never a 400)', async () => {
    const e = await rej(call('createPurchaseOrder', fresh().ctx, { headers: idem(), body: newPo(SUP, STORE, Array.from({ length: 200 }, () => poLine(ITEM, PACK, '0.001')), { notes: 'x'.repeat(1000), expected_on: '2026-12-31' }) }));
    expect((e as { code: string }).code).not.toBe('common.validation_failed');
  });
});

describe('T-11 #82-#89 path id and If-Match', () => {
  it.each(PATH_OPS)('%s: po_id must be a uuid -> 400, tx untouched', async (op) => {
    const c = fresh();
    await expectLims(call(op, c.ctx, { ...VALID[op], params: { po_id: 'PO260000001' } }), 'common.validation_failed', 400);
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

describe('T-11 #83 replacePurchaseOrderDraft body: "as create" (store and supplier changeable in draft)', () => {
  const bad = (body: unknown) => badBody('replacePurchaseOrderDraft', body);
  it('supplier_id / store_id / lines required; lines 1..200; qty_packs rules as create', async () => {
    await bad({ lines: L })(); await bad({ supplier_id: SUP, store_id: STORE })(); await bad(newPo(SUP, STORE, []))(); await bad(newPo(SUP, STORE, Array.from({ length: 201 }, () => poLine(ITEM, PACK, '1'))))();
    for (const q of ['0', '-3', '1.0001']) await bad(newPo(SUP, STORE, [poLine(ITEM, PACK, q)]))();
  });
  it('unknown keys (status, version, total_paisa, line id, tax_rate_bp)', async () => {
    for (const k of ['status', 'version', 'total_paisa', 'po_no']) await bad(newPo(SUP, STORE, L, { [k]: 'x' }))();
    for (const k of ['id', 'tax_rate_bp', 'net_paisa', 'removed_at']) await bad(newPo(SUP, STORE, [poLine(ITEM, PACK, '1', { [k]: 1 })]))();
  });
  it('is_exempt true with tax_code -> 400 /lines/0/tax_code', async () => {
    const c = fresh();
    const e: any = await rej(call('replacePurchaseOrderDraft', c.ctx, { ...VALID['replacePurchaseOrderDraft'], body: newPo(SUP, STORE, [poLine(ITEM, PACK, '1', { is_exempt: true, tax_code: 'VAT' })]) }));
    expect(e.code).toBe('common.validation_failed'); path(e, '/lines/0/tax_code'); expect(c.tx.calls).toEqual([]); expect(c.taxCalls).toEqual([]);
  });
});

describe('T-11 #84 approve takes no body; #85 mark-sent / #86 cancel / #87 close bodies (strict)', () => {
  it('approve: a body with keys is refused 400 (nothing to smuggle: approved_by, total_paisa)', async () => {
    for (const body of [{ approved_by: SUP }, { total_paisa: 1 }]) { const c = fresh(); await expectLims(call('approvePurchaseOrder', c.ctx, { ...VALID['approvePurchaseOrder'], body }), 'common.validation_failed', 400); expect(c.tx.calls).toEqual([]); }
  });
  const sent = (body: unknown) => badBody('markPurchaseOrderSent', body);
  it('mark-sent: sent_channel required and one of email|phone|in_person|portal|other; reference <= 120 chars, a string', async () => {
    await sent({})(); await sent({ sent_reference: 'x' })(); await sent(sentBody({ sent_channel: 'fax' }))(); await sent(sentBody({ sent_channel: 'EMAIL' }))(); await sent(sentBody({ sent_channel: 5 }))();
    await sent(sentBody({ sent_reference: 'x'.repeat(121) }))(); await sent(sentBody({ sent_reference: 5 }))();
  });
  it('mark-sent: unknown keys (status, sent_at, sent_by)', async () => { for (const k of ['status', 'sent_at', 'sent_by']) await sent(sentBody({ [k]: 'x' }))(); });
  it('mark-sent: all five channels and a 120-char reference are valid (reach the tx)', async () => {
    for (const ch of ['email', 'phone', 'in_person', 'portal', 'other']) {
      const e = await rej(call('markPurchaseOrderSent', fresh().ctx, { ...VALID['markPurchaseOrderSent'], body: sentBody({ sent_channel: ch, sent_reference: 'x'.repeat(120) }) }));
      expect((e as { code: string }).code).not.toBe('common.validation_failed');
    }
  });
  it('mark-sent without a reference is valid (optional)', async () => {
    const e = await rej(call('markPurchaseOrderSent', fresh().ctx, { ...VALID['markPurchaseOrderSent'], body: { sent_channel: 'phone' } }));
    expect((e as { code: string }).code).not.toBe('common.validation_failed');
  });
  const cancel = (body: unknown) => badBody('cancelPurchaseOrder', body);
  it('cancel: reason_code required, code shape ^[a-z][a-z0-9_]{0,31}$; reason_text <= 500, a string', async () => {
    await cancel({})(); await cancel({ reason_text: 'x' })();
    for (const r of ['No Longer', 'NO_LONGER', 'a'.repeat(33), '1abc', '', 5, null]) await cancel(cancelBody({ reason_code: r }))();
    await cancel(cancelBody({ reason_text: 'x'.repeat(501) }))(); await cancel(cancelBody({ reason_text: 5 }))();
  });
  it('cancel: unknown keys (status, cancelled_by, version)', async () => { for (const k of ['status', 'cancelled_by', 'version']) await cancel(cancelBody({ [k]: 'x' }))(); });
  const close = (body: unknown) => badBody('closePurchaseOrder', body);
  it('close: reason_code (optional) shape; reason_text <= 500; unknown keys', async () => {
    for (const r of ['Short Supply', 'a'.repeat(33), '', 5, null]) await close(closeBody({ reason_code: r }))();
    await close(closeBody({ reason_text: 'x'.repeat(501) }))(); await close(closeBody({ status: 'closed' }))(); await close(closeBody({ is_closed_short: true }))();
  });
  it('close: an empty body is valid for the schema (the reason is required only when open quantity > 0, a row-dependent rule): reaches the tx', async () => {
    const e = await rej(call('closePurchaseOrder', fresh().ctx, { ...VALID['closePurchaseOrder'], body: {} }));
    expect((e as { code: string }).code).not.toBe('common.validation_failed');
  });
});

describe('T-11 #88 createPurchaseOrdersFromReorder body (strict)', () => {
  const bad = (body: unknown) => badBody('createPurchaseOrdersFromReorder', body);
  it('store_id required, a uuid; item_ids an array of at most 200 uuids; unknown keys', async () => {
    await bad({})(); await bad({ store_id: 'BR1-MAIN' })(); await bad(reorderBody(STORE, { item_ids: 'x' }))(); await bad(reorderBody(STORE, { item_ids: ['GLU-R1'] }))();
    await bad(reorderBody(STORE, { item_ids: Array.from({ length: 201 }, () => ITEM) }))(); await bad(reorderBody(STORE, { supplier_id: SUP }))(); await bad(reorderBody(STORE, { lines: [] }))();
  });
  it('200 item ids and an absent item_ids are valid (reach the tx)', async () => {
    for (const body of [reorderBody(STORE, { item_ids: Array.from({ length: 200 }, () => ITEM) }), reorderBody(STORE)]) {
      const e = await rej(call('createPurchaseOrdersFromReorder', fresh().ctx, { ...VALID['createPurchaseOrdersFromReorder'], body }));
      expect((e as { code: string }).code).not.toBe('common.validation_failed');
    }
  });
});

describe('T-11 writes: the permission is asserted per branch, never tenant-wide, once a row is loaded', () => {
  it.each(WRITES)('%s with a valid request touches the tx (the scope read) before any permission decision', async (op) => {
    const c = fresh({ permissions: [] });
    const e = await rej(call(op, c.ctx, VALID[op]));
    expect((e as { message?: string }).message).toMatch(/tx touched/); // 404 beats 403 (P-B8): no assertRole may precede the row read
    expect(c.roleCalls).toEqual([]);
  });
  it.each(['getPurchaseOrder', 'getPurchaseOrderPrintView'])('%s reads the PO before the permission decision too (P-B8)', async (op) => {
    const c = fresh({ permissions: [] });
    const e = await rej(call(op, c.ctx, VALID[op]));
    expect((e as { message?: string }).message).toMatch(/tx touched/);
    expect(c.roleCalls).toEqual([]);
  });
});
