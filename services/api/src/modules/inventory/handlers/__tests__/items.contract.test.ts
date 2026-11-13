// C12.T-07 contract tests for #1-#10 (items, packs, barcodes): permission gate, strict request schemas (400 common.validation_failed), If-Match, no DB access on refusals.
// Spec: 02-TRD §5.1 #1-#10, 05-SCHEMA §2.6-2.8 (CHECKs), contracts/openapi/inventory.yaml (ItemCreate, ItemPatch, pack/barcode bodies, DecimalStringPositive), PRD AC-01.1/01.4, AC-02.2, 07-SECURITY P-1/A12/080.
// Seams: see items.helpers.ts. The tx is DEAD here: a refusal that touches the database fails the test (nothing may be read or written for a stranger or for garbage input).
import { describe, expect, it } from 'vitest';
import { A, MANAGE, PERMISSION, READ, call, deadTx, expectLims, ifm, makeCtx, newItem, newPack, uid } from './items.helpers.js';

const ITEM = uid(2001);
const PACK = uid(2201);
const BC = uid(2401);
const fresh = (permissions?: string[]) => { const tx = deadTx(); return { tx, ...makeCtx(tx, A, permissions) }; };

/** Every operation with a syntactically valid request (used by the gate tests). */
const VALID: Record<string, any> = {
  listInventoryItems: {},
  createInventoryItem: { body: newItem() },
  getInventoryItem: { params: { item_id: ITEM } },
  updateInventoryItem: { params: { item_id: ITEM }, headers: ifm(1), body: { name: 'x' } },
  setInventoryItemActive: { params: { item_id: ITEM }, headers: ifm(1), body: { is_active: false } },
  createInventoryItemPack: { params: { item_id: ITEM }, body: newPack() },
  updateInventoryItemPack: { params: { item_id: ITEM, pack_id: PACK }, headers: ifm(1), body: { label: 'x' } },
  addInventoryItemBarcode: { params: { item_id: ITEM }, body: { barcode_value: 'abc' } },
  deactivateInventoryItemBarcode: { params: { item_id: ITEM, barcode_id: BC }, headers: ifm(1) },
  lookupInventoryBarcode: { body: { barcode_value: 'abc' } },
};

describe('T-07 gate: permission first, nothing else touched (PE-2, REQ-SEC-062)', () => {
  it.each(Object.keys(VALID))('%s without the permission -> 403 auth.forbidden; assertRole({permission}) without branchId; tx untouched', async (op) => {
    const c = fresh([]);
    await expectLims(call(op, c.ctx, VALID[op]), 'auth.forbidden', 403);
    expect(c.roleCalls[0]).toEqual({ permission: PERMISSION[op] });
    expect(c.tx.calls).toEqual([]);
  });
  it('a read-only holder (item.read) cannot write #2 #4-#9 but can pass the gate of #1 #3 #10', async () => {
    for (const op of ['createInventoryItem', 'updateInventoryItem', 'setInventoryItemActive', 'createInventoryItemPack', 'updateInventoryItemPack', 'addInventoryItemBarcode', 'deactivateInventoryItemBarcode']) {
      const c = fresh([READ]);
      await expectLims(call(op, c.ctx, VALID[op]), 'auth.forbidden', 403);
      expect(c.tx.calls).toEqual([]);
    }
    for (const op of ['listInventoryItems', 'getInventoryItem', 'lookupInventoryBarcode']) {
      const c = fresh([READ]);
      await call(op, c.ctx, VALID[op]).catch(() => undefined); // may fail later (dead tx); the gate itself must have passed
      expect(c.roleCalls[0]).toEqual({ permission: READ });
    }
  });
  it('a manager without item.read is still refused on reads (permissions are not implied)', async () => {
    const c = fresh([MANAGE]);
    await expectLims(call('getInventoryItem', c.ctx, VALID['getInventoryItem']), 'auth.forbidden', 403);
  });
  it('a stranger who also sends garbage gets 403, never a validation error', async () => {
    const c = fresh([]);
    await expectLims(call('createInventoryItem', c.ctx, { body: { item_code: 42, x: 1 } }), 'auth.forbidden', 403);
    await expectLims(call('updateInventoryItem', c.ctx, { params: { item_id: 'nope' }, body: 'x' }), 'auth.forbidden', 403);
  });
});

const field = (e: any, name: string) => expect((e.errors ?? []).some((x: any) => String(x.path).includes(name)), `errors[].path should point at ${name}: ${JSON.stringify(e.errors)}`).toBe(true);

describe('T-07 #2 createInventoryItem: ItemCreate is strict (AC-01.1, 05-SCHEMA items CHECKs) -> 400 common.validation_failed, nothing written', () => {
  const bad: [string, Record<string, unknown>, string][] = [
    ['item_code missing', { item_code: undefined }, 'item_code'],
    ['item_code lower case', { item_code: 'glu-r1' }, 'item_code'],
    ['item_code with a space', { item_code: 'GLU R1' }, 'item_code'],
    ['item_code trailing space', { item_code: 'GLU-R1 ' }, 'item_code'],
    ['item_code starts with a dash', { item_code: '-GLU' }, 'item_code'],
    ['item_code 33 chars', { item_code: 'A'.repeat(33) }, 'item_code'],
    ['item_code empty', { item_code: '' }, 'item_code'],
    ['item_code not a string', { item_code: 42 }, 'item_code'],
    ['name missing', { name: undefined }, 'name'],
    ['name empty', { name: '' }, 'name'],
    ['name 201 chars', { name: 'n'.repeat(201) }, 'name'],
    ['category unknown', { category: 'chemical' }, 'category'],
    ['category upper case', { category: 'Reagent' }, 'category'],
    ['base_uom_code missing', { base_uom_code: undefined }, 'base_uom_code'],
    ['base_uom_code upper case', { base_uom_code: 'Test' }, 'base_uom_code'],
    ['base_uom_code with a dash', { base_uom_code: 'my-unit' }, 'base_uom_code'],
    ['manufacturer 121 chars', { manufacturer: 'm'.repeat(121) }, 'manufacturer'],
    ['catalogue_no 65 chars', { catalogue_no: 'c'.repeat(65) }, 'catalogue_no'],
    ['storage_condition unknown', { storage_condition: 'warm' }, 'storage_condition'],
    ['open_stability_days 0', { open_stability_days: 0 }, 'open_stability_days'],
    ['open_stability_days 3651', { open_stability_days: 3651 }, 'open_stability_days'],
    ['open_stability_days 1.5', { open_stability_days: 1.5 }, 'open_stability_days'],
    ['open_stability_days as string', { open_stability_days: '30' }, 'open_stability_days'],
    ['container_qty_base 0 (server also checks > 0)', { container_qty_base: '0' }, 'container_qty_base'],
    ['container_qty_base negative', { container_qty_base: '-1' }, 'container_qty_base'],
    ['container_qty_base 7 decimals', { container_qty_base: '1.1234567' }, 'container_qty_base'],
    ['container_qty_base 13 integer digits', { container_qty_base: '1000000000000' }, 'container_qty_base'],
    ['container_qty_base as a number', { container_qty_base: 5 }, 'container_qty_base'],
    ['container_qty_base exponent', { container_qty_base: '1e3' }, 'container_qty_base'],
    ['hs_code 3 digits', { hs_code: '123' }, 'hs_code'],
    ['hs_code letters', { hs_code: '38AB2200' }, 'hs_code'],
    ['default_tax_code lower case', { default_tax_code: 'vat' }, 'default_tax_code'],
    ['notes 1001 chars', { notes: 'n'.repeat(1001) }, 'notes'],
    ['is_lot_tracked as string', { is_lot_tracked: 'yes' }, 'is_lot_tracked'],
    ['requires_expiry as null (no null on the wire, CV §4.2)', { requires_expiry: null }, 'requires_expiry'],
    ['requires_expiry true on an item that is not lot tracked (DB CHECK items__expiry_requires_lot__ck) is a 400, never a 500', { is_lot_tracked: false, requires_expiry: true }, 'requires_expiry'],
    ['mass assignment: id', { id: uid(1) }, 'id'],
    ['mass assignment: tenant_id', { tenant_id: '01a1a98a-ac40-7000-8000-00000000b001' }, 'tenant_id'],
    ['mass assignment: version', { version: 9 }, 'version'],
    ['mass assignment: is_active', { is_active: false }, 'is_active'],
    ['mass assignment: created_by', { created_by: uid(2) }, 'created_by'],
    ['mass assignment: packs', { packs: [] }, 'packs'],
  ];
  it.each(bad)('%s', async (_l, over, name) => {
    const c = fresh();
    const e = await expectLims(call('createInventoryItem', c.ctx, { body: { ...newItem(), ...over } }), 'common.validation_failed', 400);
    field(e, name);
    expect(c.tx.calls).toEqual([]);
  });
  it.each([undefined, null, 'x', [], 7])('body %j -> 400', async (body) => {
    const c = fresh();
    await expectLims(call('createInventoryItem', c.ctx, { body }), 'common.validation_failed', 400);
    expect(c.tx.calls).toEqual([]);
  });
});

describe('T-07 #4 updateInventoryItem: If-Match + strict ItemPatch', () => {
  it('no If-Match -> 428 common.precondition_required, nothing read', async () => {
    const c = fresh();
    await expectLims(call('updateInventoryItem', c.ctx, { params: { item_id: ITEM }, body: { name: 'x' } }), 'common.precondition_required', 428);
    expect(c.tx.calls).toEqual([]);
  });
  it.each(['1', '"0"', '"-1"', '"abc"', '"1.5"', '"99999999999"', 'W/"1"', '""'])('malformed If-Match %s -> 400', async (h) => {
    const c = fresh();
    await expectLims(call('updateInventoryItem', c.ctx, { params: { item_id: ITEM }, headers: { 'if-match': h }, body: { name: 'x' } }), 'common.validation_failed', 400);
    expect(c.tx.calls).toEqual([]);
  });
  const bad: [string, Record<string, unknown>][] = [
    ['item_code is immutable and not in ItemPatch', { item_code: 'NEW-CODE' }],
    ['is_active has its own operation (#5)', { is_active: false }],
    ['version in the body', { version: 5 }],
    ['tenant_id in the body', { tenant_id: '01a1a98a-ac40-7000-8000-00000000b001' }],
    ['packs in the body', { packs: [] }],
    ['name 201 chars', { name: 'n'.repeat(201) }],
    ['name empty', { name: '' }],
    ['category unknown', { category: 'x' }],
    ['container_qty_base "0"', { container_qty_base: '0' }],
    ['null instead of unset[] (CV §4.2)', { notes: null }],
    ['unset names a required field', { unset: ['name'] }],
    ['unset names item_code', { unset: ['item_code'] }],
    ['unset with 9 entries', { unset: ['manufacturer', 'catalogue_no', 'storage_condition', 'open_stability_days', 'container_qty_base', 'hs_code', 'default_tax_code', 'notes', 'notes'] }],
    ['unset not an array', { unset: 'notes' }],
  ];
  it.each(bad)('%s -> 400 common.validation_failed, nothing read', async (_l, body) => {
    const c = fresh();
    await expectLims(call('updateInventoryItem', c.ctx, { params: { item_id: ITEM }, headers: ifm(1), body }), 'common.validation_failed', 400);
    expect(c.tx.calls).toEqual([]);
  });
});

describe('T-07 #5 setInventoryItemActive', () => {
  it.each([undefined, {}, { is_active: 'false' }, { is_active: null }, { is_active: 0 }, { is_active: true, x: 1 }, 'x', null])('body %j -> 400', async (body) => {
    const c = fresh();
    await expectLims(call('setInventoryItemActive', c.ctx, { params: { item_id: ITEM }, headers: ifm(1), body }), 'common.validation_failed', 400);
    expect(c.tx.calls).toEqual([]);
  });
  it('no If-Match -> 428', async () => {
    const c = fresh();
    await expectLims(call('setInventoryItemActive', c.ctx, { params: { item_id: ITEM }, body: { is_active: false } }), 'common.precondition_required', 428);
  });
});

describe('T-07 #6 createInventoryItemPack: pack body is strict (05-SCHEMA item_packs CHECKs, AC-02.4 shape of quantities)', () => {
  const bad: [string, Record<string, unknown>, string][] = [
    ['pack_code lower case', { pack_code: 'box' }, 'pack_code'],
    ['pack_code 17 chars', { pack_code: 'B'.repeat(17) }, 'pack_code'],
    ['pack_code with a dash', { pack_code: 'BOX-1' }, 'pack_code'],
    ['pack_code empty', { pack_code: '' }, 'pack_code'],
    ['pack_code missing', { pack_code: undefined }, 'pack_code'],
    ['label empty', { label: '' }, 'label'],
    ['label 61 chars', { label: 'l'.repeat(61) }, 'label'],
    ['label missing', { label: undefined }, 'label'],
    ['uom_code upper case', { uom_code: 'Box' }, 'uom_code'],
    ['uom_code missing', { uom_code: undefined }, 'uom_code'],
    ['qty_in_base missing', { qty_in_base: undefined }, 'qty_in_base'],
    ['qty_in_base "0" (> 0 required)', { qty_in_base: '0' }, 'qty_in_base'],
    ['qty_in_base "0.000000"', { qty_in_base: '0.000000' }, 'qty_in_base'],
    ['qty_in_base negative', { qty_in_base: '-5' }, 'qty_in_base'],
    ['qty_in_base 7 decimals', { qty_in_base: '0.0000001' }, 'qty_in_base'],
    ['qty_in_base 13 integer digits', { qty_in_base: '1000000000000' }, 'qty_in_base'],
    ['qty_in_base as a JSON number', { qty_in_base: 400 }, 'qty_in_base'],
    ['qty_in_base text', { qty_in_base: 'abc' }, 'qty_in_base'],
    ['qty_in_base with a comma', { qty_in_base: '1,5' }, 'qty_in_base'],
    ['is_purchase_default as string', { is_purchase_default: 'true' }, 'is_purchase_default'],
    ['mass assignment: item_id', { item_id: uid(2002) }, 'item_id'],
    ['mass assignment: id', { id: uid(5) }, 'id'],
    ['mass assignment: is_active', { is_active: false }, 'is_active'],
  ];
  it.each(bad)('%s -> 400', async (_l, over, name) => {
    const c = fresh();
    const e = await expectLims(call('createInventoryItemPack', c.ctx, { params: { item_id: ITEM }, body: { ...newPack(), ...over } }), 'common.validation_failed', 400);
    field(e, name);
    expect(c.tx.calls).toEqual([]);
  });
});

describe('T-07 #7 updateInventoryItemPack: pack size immutability, layer 1 = the schema (AC-02.2, 07-SECURITY A12)', () => {
  it.each([
    ['qty_in_base (the size)', { qty_in_base: '500' }],
    ['qty_in_base alone, even equal to the stored value', { qty_in_base: '400' }],
    ['qty_in_base next to a valid change', { label: 'ok', qty_in_base: '1' }],
    ['pack_code', { pack_code: 'NEW' }],
    ['item_id', { item_id: uid(2002) }],
    ['version', { version: 3 }],
  ])('%s in the PATCH body -> 400 common.validation_failed, nothing read or written', async (_l, body) => {
    const c = fresh();
    const e = await expectLims(call('updateInventoryItemPack', c.ctx, { params: { item_id: ITEM, pack_id: PACK }, headers: ifm(1), body }), 'common.validation_failed', 400);
    expect((e.errors ?? []).length).toBeGreaterThan(0);
    expect(c.tx.calls).toEqual([]);
  });
  it.each([{ label: '' }, { label: 'l'.repeat(61) }, { uom_code: 'Box' }, { is_active: 'no' }, { is_purchase_default: 1 }])('invalid %j -> 400', async (body) => {
    const c = fresh();
    await expectLims(call('updateInventoryItemPack', c.ctx, { params: { item_id: ITEM, pack_id: PACK }, headers: ifm(1), body }), 'common.validation_failed', 400);
  });
  it('no If-Match -> 428', async () => {
    const c = fresh();
    await expectLims(call('updateInventoryItemPack', c.ctx, { params: { item_id: ITEM, pack_id: PACK }, body: { label: 'x' } }), 'common.precondition_required', 428);
  });
});

describe('T-07 #8 addInventoryItemBarcode: barcode_value shape is checked AFTER upper-casing and is printable ASCII only (05-SCHEMA item_barcodes__ck)', () => {
  const bad: [string, unknown][] = [
    ['empty', ''], ['65 chars', 'A'.repeat(65)], ['space inside', 'AB CD'], ['leading space', ' AB'], ['tab', 'AB\tCD'], ['newline', 'AB\nCD'], ['NUL', 'AB\u0000CD'],
    ['non-ASCII', 'ÄB-1'], ['ß (upper-cases to SS in JS: must not sneak past the ASCII rule)', 'straße'], ['dotless i', 'ıd-1'], ['emoji', 'AB-🙂'], ['not a string', 123], ['null', null],
  ];
  it.each(bad)('barcode_value %s -> 400', async (_l, v) => {
    const c = fresh();
    const e = await expectLims(call('addInventoryItemBarcode', c.ctx, { params: { item_id: ITEM }, body: { barcode_value: v } }), 'common.validation_failed', 400);
    field(e, 'barcode_value');
    expect(c.tx.calls).toEqual([]);
  });
  it.each([
    ['missing barcode_value', {}], ['pack_id not a uuid', { barcode_value: 'AB', pack_id: 'nope' }], ['pack_id null', { barcode_value: 'AB', pack_id: null }],
    ['extra property item_id', { barcode_value: 'AB', item_id: uid(2002) }], ['extra property is_active', { barcode_value: 'AB', is_active: false }],
  ])('%s -> 400', async (_l, body) => {
    const c = fresh();
    await expectLims(call('addInventoryItemBarcode', c.ctx, { params: { item_id: ITEM }, body }), 'common.validation_failed', 400);
  });
});

describe('T-07 #10 lookupInventoryBarcode and #9 deactivate: input shape', () => {
  it.each([undefined, {}, { barcode_value: '' }, { barcode_value: 'A'.repeat(65) }, { barcode_value: 'AB CD' }, { barcode_value: 5 }, { barcode_value: 'AB', x: 1 }])('lookup body %j -> 400', async (body) => {
    const c = fresh();
    await expectLims(call('lookupInventoryBarcode', c.ctx, { body }), 'common.validation_failed', 400);
    expect(c.tx.calls).toEqual([]);
  });
  it('deactivate without If-Match -> 428', async () => {
    const c = fresh();
    await expectLims(call('deactivateInventoryItemBarcode', c.ctx, { params: { item_id: ITEM, barcode_id: BC } }), 'common.precondition_required', 428);
  });
});

describe('T-07 #1 listInventoryItems: query shape (barcode search is #10 only)', () => {
  it.each([
    ['barcode param is not allowed', { barcode: 'ABC' }], ['q 61 chars', { q: 'q'.repeat(61) }], ['category unknown', { category: 'chemical' }], ['sort unknown', { sort: 'item_code; DROP TABLE x' }],
    ['sort -name (only -updated_at is descending)', { sort: '-name' }], ['limit 0', { limit: 0 }], ['limit 201', { limit: 201 }], ['limit 1.5', { limit: 1.5 }],
    ['cursor with illegal characters', { cursor: "x'; --" }], ['unknown parameter', { tenant_id: '01a1a98a-ac40-7000-8000-00000000b001' }],
  ])('%s -> 400', async (_l, query) => {
    const c = fresh();
    await expectLims(call('listInventoryItems', c.ctx, { query }), 'common.validation_failed', 400);
    expect(c.tx.calls).toEqual([]);
  });
});
