// C12.T-13 contract tests for #56-#62 (transfers): permission gate on the list, strict request schemas (400 common.validation_failed), If-Match (428 / 400), no DB access on refusals.
// Spec: 02-TRD §5.5 #56-#62, §5.11, contracts/openapi/inventory.yaml (query / body schemas), 07-SECURITY P-B3 / P-B8. Seams: transfers.helpers.ts.
// The tx is DEAD here: a refusal that touches the database fails the test. Row-dependent gates (404 / 403 by branch) live in transfers.integration.test.ts.
import { describe, expect, it } from 'vitest';
import { A, PERMISSION, READ, call, cancelBody, deadTx, expectLims, ifm, makeTrCtx, newTransfer, recvBody, rej, replaceBody, trLine, uid, type LotOpts } from './transfers.helpers.js';

const FROM = uid(1001), TO = uid(1002), ITEM = uid(2001), LOT = uid(4001), TR = uid(8701), LINE = uid(8711), PACK = uid(2201);
const fresh = (o: LotOpts = {}) => { const tx = deadTx(); return { tx, ...makeTrCtx(tx, A, o) }; };

const VALID: Record<string, any> = {
  listTransfers: {},
  createTransfer: { body: newTransfer(FROM, TO, [trLine(ITEM, '10', LOT)]) },
  getTransfer: { params: { transfer_id: TR } },
  replaceTransferDraft: { params: { transfer_id: TR }, headers: ifm(1), body: replaceBody([trLine(ITEM, '10', LOT)]) },
  dispatchTransfer: { params: { transfer_id: TR }, headers: ifm(1) },
  receiveTransfer: { params: { transfer_id: TR }, headers: ifm(1), body: recvBody([{ line_id: LINE, received_qty_base: '10' }]) },
  cancelTransfer: { params: { transfer_id: TR }, headers: ifm(1), body: cancelBody() },
};
const WRITES = ['createTransfer', 'replaceTransferDraft', 'dispatchTransfer', 'receiveTransfer', 'cancelTransfer'];
const IF_MATCH_OPS = ['replaceTransferDraft', 'dispatchTransfer', 'receiveTransfer', 'cancelTransfer'];
const PATH_OPS = ['getTransfer', ...IF_MATCH_OPS];

describe('T-13 #56 listTransfers: permission first (no branchId), strict query', () => {
  it('without inventory.item.read -> 403 auth.forbidden; assertRole({permission}) without branchId; tx untouched', async () => {
    const c = fresh({ permissions: [] });
    await expectLims(call('listTransfers', c.ctx, VALID['listTransfers']), 'auth.forbidden', 403);
    expect(c.roleCalls[0]).toEqual({ permission: PERMISSION['listTransfers'] });
    expect(c.tx.calls).toEqual([]);
  });
  it('permission before validation: a stranger with a bad query learns nothing (403, not 400)', async () => {
    const c = fresh({ permissions: [] });
    await expectLims(call('listTransfers', c.ctx, { query: { status: 'banana' } }), 'auth.forbidden', 403);
    expect(c.tx.calls).toEqual([]);
  });
  const bad = (query: Record<string, unknown>) => async () => { const c = fresh({ permissions: [READ] }); await expectLims(call('listTransfers', c.ctx, { query }), 'common.validation_failed', 400); expect(c.tx.calls).toEqual([]); };
  it('status outside draft|dispatched|received|cancelled', bad({ status: 'in_transit' }));
  it('from_store_id / to_store_id must be uuids', async () => { await bad({ from_store_id: 'MAIN-A' })(); await bad({ to_store_id: 'x' })(); });
  it('unknown query key (tenant_id smuggle)', bad({ tenant_id: A }));
  it('limit 0 and limit 201', async () => { await bad({ limit: 0 })(); await bad({ limit: 201 })(); });
});

describe('T-13 #57 createTransfer body (strict; validation runs before any read)', () => {
  const badBody = (body: unknown) => async () => { const c = fresh(); await expectLims(call('createTransfer', c.ctx, { body }), 'common.validation_failed', 400); expect(c.tx.calls).toEqual([]); };
  const L = [trLine(ITEM, '10', LOT)];
  it('a stranger with a bad body gets 400 (the permission needs the store row, which is never read for invalid input)', async () => {
    const c = fresh({ permissions: [] });
    await expectLims(call('createTransfer', c.ctx, { body: { lines: [] } }), 'common.validation_failed', 400);
    expect(c.tx.calls).toEqual([]);
  });
  it('from_store_id / to_store_id / lines are required', async () => {
    await badBody({ to_store_id: TO, lines: L })(); await badBody({ from_store_id: FROM, lines: L })(); await badBody({ from_store_id: FROM, to_store_id: TO })();
  });
  it('from and to must differ (the DB CHECK is never the first line of defence)', badBody(newTransfer(FROM, FROM, L)));
  it('store ids must be uuids', async () => { await badBody(newTransfer('MAIN-A', TO, L))(); await badBody(newTransfer(FROM, 'BENCH-A', L))(); });
  it('lines: empty, more than 200', async () => { await badBody(newTransfer(FROM, TO, []))(); await badBody(newTransfer(FROM, TO, Array.from({ length: 201 }, () => trLine(ITEM, '1', LOT))))(); });
  it('qty: 0, negative, signed, > 6 decimals, > 12 digits, not a number, a JSON number, empty', async () => {
    for (const q of ['0', '0.000000', '-1', '+1', '1.1234567', '1234567890123', 'ten', '', 10, null]) await badBody(newTransfer(FROM, TO, [{ item_id: ITEM, lot_id: LOT, qty: q }]))();
  });
  it('qty missing, item_id missing / not a uuid, lot_id not a uuid, pack_id not a uuid', async () => {
    await badBody(newTransfer(FROM, TO, [{ item_id: ITEM, lot_id: LOT }]))();
    await badBody(newTransfer(FROM, TO, [{ qty: '1' }]))();
    await badBody(newTransfer(FROM, TO, [trLine('GLU-R1', '1')]))();
    await badBody(newTransfer(FROM, TO, [trLine(ITEM, '1', 'L-001')]))();
    await badBody(newTransfer(FROM, TO, [trLine(ITEM, '1', LOT, { pack_id: 'BOX' })]))();
  });
  it('unknown keys: body (tenant_id, status, transfer_no, dispatched_value_paisa) and line (qty_base, dispatched_value_paisa, line_no)', async () => {
    for (const k of ['tenant_id', 'status', 'transfer_no', 'version']) await badBody(newTransfer(FROM, TO, L, { [k]: 'x' }))();
    for (const k of ['qty_base', 'dispatched_value_paisa', 'line_no', 'removed_at']) await badBody(newTransfer(FROM, TO, [trLine(ITEM, '1', LOT, { [k]: 1 })]))();
  });
  it('notes longer than 1000 chars; notes not a string', async () => { await badBody(newTransfer(FROM, TO, L, { notes: 'x'.repeat(1001) }))(); await badBody(newTransfer(FROM, TO, L, { notes: 5 }))(); });
  it('a body that is not an object (array / string / null / missing)', async () => { for (const b of [[], 'x', null, undefined]) await badBody(b)(); });
  it('the exact 200-line, 1000-char-notes boundary is valid for the schema (reaches the tx: the dead tx is touched, never a 400)', async () => {
    const c = fresh();
    const e = await rej(call('createTransfer', c.ctx, { body: newTransfer(FROM, TO, Array.from({ length: 200 }, () => trLine(ITEM, '0.000001', LOT)), { notes: 'x'.repeat(1000) }) }));
    expect((e as { code: string }).code).not.toBe('common.validation_failed');
  });
});

describe('T-13 #58-#62 path id and If-Match', () => {
  it.each(PATH_OPS)('%s: transfer_id must be a uuid -> 400, tx untouched', async (op) => {
    const c = fresh();
    await expectLims(call(op, c.ctx, { ...VALID[op], params: { transfer_id: 'TR260000001' } }), 'common.validation_failed', 400);
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

describe('T-13 #59 replaceTransferDraft body: "as create minus stores"', () => {
  const badBody = (body: unknown) => async () => { const c = fresh(); await expectLims(call('replaceTransferDraft', c.ctx, { ...VALID['replaceTransferDraft'], body }), 'common.validation_failed', 400); expect(c.tx.calls).toEqual([]); };
  const L = [trLine(ITEM, '10', LOT)];
  it('from_store_id / to_store_id are not part of the body (a draft cannot change its stores)', async () => {
    await badBody(replaceBody(L, { from_store_id: FROM }))(); await badBody(replaceBody(L, { to_store_id: TO }))();
  });
  it('lines: missing, empty, > 200; qty 0 / negative / 7 decimals', async () => {
    await badBody({})(); await badBody(replaceBody([]))(); await badBody(replaceBody(Array.from({ length: 201 }, () => trLine(ITEM, '1', LOT))))();
    for (const q of ['0', '-3', '1.1234567']) await badBody(replaceBody([trLine(ITEM, q, LOT)]))();
  });
  it('unknown keys (status, version, line id)', async () => {
    await badBody(replaceBody(L, { status: 'dispatched' }))(); await badBody(replaceBody(L, { version: 3 }))(); await badBody(replaceBody([trLine(ITEM, '1', LOT, { id: LINE })]))();
  });
  it('notes > 1000 chars', badBody(replaceBody(L, { notes: 'x'.repeat(1001) })));
  it('pack_id is part of the line schema (valid shape)', async () => {
    const c = fresh();
    const e = await rej(call('replaceTransferDraft', c.ctx, { ...VALID['replaceTransferDraft'], body: replaceBody([trLine(ITEM, '2', null, { pack_id: PACK })]) }));
    expect((e as { code: string }).code).not.toBe('common.validation_failed');
  });
});

describe('T-13 #60 dispatchTransfer takes no body', () => {
  it('a body with keys is refused 400 (strict: nothing to smuggle)', async () => {
    const c = fresh();
    await expectLims(call('dispatchTransfer', c.ctx, { ...VALID['dispatchTransfer'], body: { lines: [] } }), 'common.validation_failed', 400);
    expect(c.tx.calls).toEqual([]);
  });
});

describe('T-13 #61 receiveTransfer body (strict)', () => {
  const badBody = (body: unknown) => async () => { const c = fresh(); await expectLims(call('receiveTransfer', c.ctx, { ...VALID['receiveTransfer'], body }), 'common.validation_failed', 400); expect(c.tx.calls).toEqual([]); };
  const ok = { line_id: LINE, received_qty_base: '10' };
  it('lines missing / empty / > 200', async () => { await badBody({})(); await badBody(recvBody([]))(); await badBody(recvBody(Array.from({ length: 201 }, () => ok)))(); });
  it('line_id missing / not a uuid; received_qty_base missing', async () => {
    await badBody({ lines: [{ received_qty_base: '1' }] })(); await badBody({ lines: [{ line_id: 'L1', received_qty_base: '1' }] })(); await badBody({ lines: [{ line_id: LINE }] })();
  });
  it('received_qty_base: negative, signed, 7 decimals, 13 digits, not a number, a JSON number, null', async () => {
    for (const q of ['-1', '+1', '1.1234567', '1234567890123', 'all', '', 10, null]) await badBody({ lines: [{ line_id: LINE, received_qty_base: q }] })();
  });
  it('discrepancy_reason_code: spaces / upper case / 33 chars / a number', async () => {
    for (const r of ['Transit Loss', 'TRANSIT', 'a'.repeat(33), 5]) await badBody({ lines: [{ ...ok, discrepancy_reason_code: r }] })();
  });
  it('unknown keys: body (status) and line (qty_base, dispatched_value_paisa)', async () => {
    await badBody({ lines: [ok], status: 'received' })();
    for (const k of ['qty_base', 'dispatched_value_paisa', 'received_value_paisa']) await badBody({ lines: [{ ...ok, [k]: 1 }] })();
  });
  it('the same line_id twice in one request', badBody(recvBody([ok, ok])));
  it('received_qty_base "0" is VALID (a total transit loss is received as 0 with a reason, 03-APP-FLOW §3.3): it reaches the tx', async () => {
    const c = fresh();
    const e = await rej(call('receiveTransfer', c.ctx, { ...VALID['receiveTransfer'], body: recvBody([{ line_id: LINE, received_qty_base: '0', discrepancy_reason_code: 'transit_loss' }]) }));
    expect((e as { code: string }).code).not.toBe('common.validation_failed');
  });
});

describe('T-13 #62 cancelTransfer body (strict)', () => {
  const badBody = (body: unknown) => async () => { const c = fresh(); await expectLims(call('cancelTransfer', c.ctx, { ...VALID['cancelTransfer'], body }), 'common.validation_failed', 400); expect(c.tx.calls).toEqual([]); };
  it('reason_text is required, a non-empty string, at most 500 chars', async () => {
    await badBody({})(); await badBody(cancelBody({ reason_text: '' }))(); await badBody(cancelBody({ reason_text: '   ' }))(); await badBody(cancelBody({ reason_text: 'x'.repeat(501) }))();
    await badBody(cancelBody({ reason_text: 7 }))(); await badBody(cancelBody({ reason_text: null }))();
  });
  it('unknown keys (status, version, tenant_id)', async () => { for (const k of ['status', 'version', 'tenant_id']) await badBody(cancelBody({ [k]: 'x' }))(); });
  it('500 chars exactly is valid (reaches the tx)', async () => {
    const c = fresh();
    const e = await rej(call('cancelTransfer', c.ctx, { ...VALID['cancelTransfer'], body: cancelBody({ reason_text: 'x'.repeat(500) }) }));
    expect((e as { code: string }).code).not.toBe('common.validation_failed');
  });
});

describe('T-13 writes: the permission is asserted per branch, never tenant-wide, once a row is loaded', () => {
  it.each(WRITES)('%s with a valid request touches the tx (the scope read) before any permission decision', async (op) => {
    const c = fresh({ permissions: [] });
    const e = await rej(call(op, c.ctx, VALID[op]));
    expect((e as { message?: string }).message).toMatch(/tx touched/); // 404 beats 403 (P-B8): no assertRole may precede the row read
    expect(c.roleCalls).toEqual([]);
  });
});
