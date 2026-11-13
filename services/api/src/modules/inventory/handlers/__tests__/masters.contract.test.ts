// C12.T-08 contract tests for #11-#25 (stores, store item settings, suppliers, supplier items, instrument bindings): permission gate, strict request schemas (400 common.validation_failed),
// If-Match (428 / 400), query validation, no DB access on refusals.
// Spec: 02-TRD §5.1 #11-#25, §6.1, 05-SCHEMA §2.9-2.12 / §2.22 (CHECKs), contracts/openapi/inventory.yaml (request bodies, Store, SupplierCreate, SupplierPatch), PRD AC-03.x / AC-04.1 / AC-17.1,
// 07-SECURITY P-1 / P-B8 / A12.
// Seams: see masters.helpers.ts. The tx is DEAD here: a refusal that touches the database fails the test (nothing may be read or written for a stranger or for garbage input).
// Store-scope operations (#12-#16, #24, #25) cannot be gate-tested without reading the store (404 beats 403, P-B8): their permission / scope order is in masters.integration.test.ts.
import { describe, expect, it } from 'vitest';
import { A, MANAGE, PERMISSION, READ, call, deadTx, expectLims, ifm, makeCtx, newStore, newSupplier, putSetting, putSupplierItemBody, uid } from './masters.helpers.js';

const STORE = uid(1001);
const ITEM = uid(2001);
const PACK = uid(2201);
const SUP = uid(3001);
const INSTR = uid(421);
const fresh = (permissions?: string[]) => { const tx = deadTx(); return { tx, ...makeCtx(tx, A, permissions === undefined ? {} : { permissions }) }; };

/** Every operation with a syntactically valid request. */
const VALID: Record<string, any> = {
  listInventoryStores: {},
  createInventoryStore: { body: newStore() },
  getInventoryStore: { params: { store_id: STORE } },
  updateInventoryStore: { params: { store_id: STORE }, headers: ifm(1), body: { name: 'x' } },
  listStoreItemSettings: { params: { store_id: STORE } },
  putStoreItemSetting: { params: { store_id: STORE, item_id: ITEM }, body: putSetting() },
  listInventorySuppliers: {},
  createInventorySupplier: { body: newSupplier() },
  getInventorySupplier: { params: { supplier_id: SUP } },
  updateInventorySupplier: { params: { supplier_id: SUP }, headers: ifm(1), body: { name: 'x' } },
  listSupplierItems: { params: { supplier_id: SUP } },
  putSupplierItem: { params: { supplier_id: SUP, item_id: ITEM, pack_id: PACK }, body: putSupplierItemBody() },
  listInstrumentBindings: {},
  putInstrumentBinding: { params: { instrument_id: INSTR }, body: { store_id: STORE } },
  deactivateInstrumentBinding: { params: { instrument_id: INSTR }, headers: ifm(1) },
};
/** Operations whose permission gate needs no row: tenant scope (#17-#22) and the visible-branch lists (#11, #23). */
const GATED = ['listInventoryStores', 'listInventorySuppliers', 'getInventorySupplier', 'createInventorySupplier', 'updateInventorySupplier', 'listSupplierItems', 'putSupplierItem', 'listInstrumentBindings'];
const GATED_WRITES = ['createInventorySupplier', 'updateInventorySupplier', 'putSupplierItem'];
const GATED_READS = ['listInventoryStores', 'listInventorySuppliers', 'getInventorySupplier', 'listSupplierItems', 'listInstrumentBindings'];

describe('T-08 gate: permission first, nothing else touched (PE-2, REQ-SEC-062)', () => {
  it.each(GATED)('%s without the permission -> 403 auth.forbidden; assertRole({permission}) without branchId; tx untouched', async (op) => {
    const c = fresh([]);
    await expectLims(call(op, c.ctx, VALID[op]), 'auth.forbidden', 403);
    expect(c.roleCalls[0]).toEqual({ permission: PERMISSION[op] });
    expect(c.tx.calls).toEqual([]);
  });
  it.each(GATED_WRITES)('%s: a read-only holder (item.read) is refused (403), tx untouched', async (op) => {
    const c = fresh([READ]);
    await expectLims(call(op, c.ctx, VALID[op]), 'auth.forbidden', 403);
    expect(c.tx.calls).toEqual([]);
  });
  it.each(GATED_READS)('%s: a manager without item.read is still refused (permissions are not implied)', async (op) => {
    const c = fresh([MANAGE]);
    await expectLims(call(op, c.ctx, VALID[op]), 'auth.forbidden', 403);
    expect(c.roleCalls[0]).toEqual({ permission: READ });
    expect(c.tx.calls).toEqual([]);
  });
  it('a stranger who also sends garbage gets 403, never a validation error (#18 #20 #22 and list queries)', async () => {
    const c = fresh([]);
    await expectLims(call('createInventorySupplier', c.ctx, { body: { supplier_code: 42, x: 1 } }), 'auth.forbidden', 403);
    await expectLims(call('updateInventorySupplier', c.ctx, { params: { supplier_id: 'nope' }, body: 'x' }), 'auth.forbidden', 403);
    await expectLims(call('putSupplierItem', c.ctx, { params: { supplier_id: 'a', item_id: 'b', pack_id: 'c' }, body: [] }), 'auth.forbidden', 403);
    await expectLims(call('listInventoryStores', c.ctx, { query: { purpose: 'bogus', limit: 0 } }), 'auth.forbidden', 403);
    expect(c.tx.calls).toEqual([]);
  });
});

const field = (e: any, name: string) => expect((e.errors ?? []).some((x: any) => String(x.path).includes(name)), `errors[].path should point at ${name}: ${JSON.stringify(e.errors)}`).toBe(true);
type Bad = [string, Record<string, unknown>, string];

/** One strict-body table: every row must be refused with 400 common.validation_failed, pointing at the field, with the tx untouched. */
function strictBody(title: string, op: string, base: () => Record<string, unknown>, extra: Partial<Req2>, bad: Bad[]) {
  describe(title, () => {
    it.each(bad)('%s', async (_l, over, name) => {
      const c = fresh();
      const body = { ...base(), ...over };
      for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
      const e = await expectLims(call(op, c.ctx, { ...extra, body }), 'common.validation_failed', 400);
      field(e, name);
      expect(c.tx.calls).toEqual([]);
    });
    it.each([undefined, null, 'x', [], 7])('body %j -> 400', async (body) => {
      const c = fresh();
      await expectLims(call(op, c.ctx, { ...extra, body }), 'common.validation_failed', 400);
      expect(c.tx.calls).toEqual([]);
    });
  });
}
interface Req2 { params: Record<string, unknown>; headers: Record<string, string> }
const MASS = (names: string[]): Bad[] => names.map((n) => [`mass assignment: ${n}`, { [n]: n === 'is_active' ? false : n === 'version' ? 9 : uid(1) }, n]);

const code = (field_: string): Bad[] => [
  [`${field_} missing`, { [field_]: undefined }, field_], [`${field_} lower case`, { [field_]: 'abc-1' }, field_], [`${field_} with a space`, { [field_]: 'AB C' }, field_],
  [`${field_} trailing space`, { [field_]: 'ABC ' }, field_], [`${field_} starts with a dash`, { [field_]: '-ABC' }, field_], [`${field_} 17 chars`, { [field_]: 'A'.repeat(17) }, field_],
  [`${field_} empty`, { [field_]: '' }, field_], [`${field_} not a string`, { [field_]: 42 }, field_], [`${field_} null (no null on the wire, CV §4.2)`, { [field_]: null }, field_],
];

strictBody('T-08 #12 createInventoryStore: strict body (AC-03.1, 05-SCHEMA §2.9) -> 400 common.validation_failed, nothing written', 'createInventoryStore', () => newStore(), {}, [
  ...code('store_code'),
  ['branch_id missing', { branch_id: undefined }, 'branch_id'], ['branch_id not a uuid', { branch_id: 'nope' }, 'branch_id'], ['branch_id null', { branch_id: null }, 'branch_id'],
  ['name missing', { name: undefined }, 'name'], ['name empty', { name: '' }, 'name'], ['name 121 chars', { name: 'n'.repeat(121) }, 'name'], ['name not a string', { name: 7 }, 'name'],
  ['store_kind missing', { store_kind: undefined }, 'store_kind'], ['store_kind unknown', { store_kind: 'warehouse' }, 'store_kind'], ['store_kind upper case', { store_kind: 'MAIN' }, 'store_kind'],
  ['is_default_consumption as string', { is_default_consumption: 'yes' }, 'is_default_consumption'], ['is_default_consumption null', { is_default_consumption: null }, 'is_default_consumption'],
  ...MASS(['id', 'tenant_id', 'version', 'is_active', 'created_by', 'branch_name']),
]);

describe('T-08 #14 updateInventoryStore: If-Match + strict patch', () => {
  it('no If-Match -> 428 common.precondition_required, nothing read', async () => {
    const c = fresh();
    await expectLims(call('updateInventoryStore', c.ctx, { params: { store_id: STORE }, body: { name: 'x' } }), 'common.precondition_required', 428);
    expect(c.tx.calls).toEqual([]);
  });
  it.each(['1', '"0"', '"-1"', '"abc"', '"1.5"', '"99999999999"', 'W/"1"', '""'])('malformed If-Match %s -> 400', async (h) => {
    const c = fresh();
    await expectLims(call('updateInventoryStore', c.ctx, { params: { store_id: STORE }, headers: { 'if-match': h }, body: { name: 'x' } }), 'common.validation_failed', 400);
    expect(c.tx.calls).toEqual([]);
  });
  const bad: [string, Record<string, unknown>][] = [
    ['store_code is immutable and not in the patch', { store_code: 'NEW-CODE' }], ['branch_id cannot move', { branch_id: BRANCH() }], ['id in the body', { id: uid(1) }], ['version in the body', { version: 5 }],
    ['tenant_id in the body', { tenant_id: '01a1a98a-ac40-7000-8000-00000000b001' }], ['name empty', { name: '' }], ['name 121 chars', { name: 'n'.repeat(121) }], ['store_kind unknown', { store_kind: 'x' }],
    ['is_default_consumption as string', { is_default_consumption: 'true' }], ['is_active null', { is_active: null }], ['is_active as string', { is_active: 'no' }], ['unset[] is not a store field', { unset: ['name'] }],
  ];
  it.each(bad)('%s -> 400 common.validation_failed, nothing read', async (_l, body) => {
    const c = fresh();
    await expectLims(call('updateInventoryStore', c.ctx, { params: { store_id: STORE }, headers: ifm(1), body }), 'common.validation_failed', 400);
    expect(c.tx.calls).toEqual([]);
  });
});
function BRANCH() { return '01a1a98a-ac40-7000-8000-00000000a101'; }

const decimals = (name: string): Bad[] => [
  [`${name} as a number`, { [name]: 5 }, name], [`${name} negative`, { [name]: '-1' }, name], [`${name} exponent`, { [name]: '1e3' }, name], [`${name} 7 decimals`, { [name]: '1.1234567' }, name],
  [`${name} 13 integer digits`, { [name]: '1000000000000' }, name], [`${name} empty`, { [name]: '' }, name], [`${name} with a space`, { [name]: '1 0' }, name], [`${name} null`, { [name]: null }, name],
];
strictBody('T-08 #16 putStoreItemSetting: strict body (05-SCHEMA §2.10, DecimalStringPositive) -> 400', 'putStoreItemSetting', () => putSetting(), { params: { store_id: STORE, item_id: ITEM } }, [
  ['is_stocked missing', { is_stocked: undefined }, 'is_stocked'], ['is_stocked as string', { is_stocked: 'yes' }, 'is_stocked'], ['is_stocked null', { is_stocked: null }, 'is_stocked'],
  ...decimals('reorder_level_base'), ...decimals('reorder_qty_base'), ...decimals('max_level_base'),
  ['reorder_qty_base "0" (> 0 is a server check)', { reorder_qty_base: '0' }, 'reorder_qty_base'], ['reorder_qty_base "0.000000"', { reorder_qty_base: '0.000000' }, 'reorder_qty_base'],
  ['preferred_supplier_id not a uuid', { preferred_supplier_id: 'nope' }, 'preferred_supplier_id'], ['preferred_supplier_id null', { preferred_supplier_id: null }, 'preferred_supplier_id'],
  ...MASS(['id', 'store_id', 'item_id', 'tenant_id', 'version', 'is_active']),
]);

strictBody('T-08 #18 createInventorySupplier: SupplierCreate is strict (AC-04.1, 05-SCHEMA §2.11) -> 400', 'createInventorySupplier', () => newSupplier(), {}, [
  ...code('supplier_code'),
  ['name missing', { name: undefined }, 'name'], ['name empty', { name: '' }, 'name'], ['name 201 chars', { name: 'n'.repeat(201) }, 'name'], ['name not a string', { name: 7 }, 'name'],
  ['pan_text empty', { pan_text: '' }, 'pan_text'], ['pan_text with a dash', { pan_text: 'AB-12' }, 'pan_text'], ['pan_text with a space', { pan_text: 'AB 12' }, 'pan_text'], ['pan_text 21 chars', { pan_text: 'A'.repeat(21) }, 'pan_text'],
  ['pan_text not a string', { pan_text: 42 }, 'pan_text'], ['pan_text null', { pan_text: null }, 'pan_text'],
  ['contact_name 121 chars', { contact_name: 'c'.repeat(121) }, 'contact_name'], ['phone_display 41 chars', { phone_display: '1'.repeat(41) }, 'phone_display'],
  ['email 255 chars', { email: `${'e'.repeat(250)}@x.io` }, 'email'], ['address_text 501 chars', { address_text: 'a'.repeat(501) }, 'address_text'],
  ['payment_terms_days 366', { payment_terms_days: 366 }, 'payment_terms_days'], ['payment_terms_days -1', { payment_terms_days: -1 }, 'payment_terms_days'],
  ['payment_terms_days 1.5', { payment_terms_days: 1.5 }, 'payment_terms_days'], ['payment_terms_days as string', { payment_terms_days: '30' }, 'payment_terms_days'],
  ['payment_terms_days null', { payment_terms_days: null }, 'payment_terms_days'], ['notes 1001 chars', { notes: 'n'.repeat(1001) }, 'notes'],
  ...MASS(['id', 'tenant_id', 'version', 'is_active', 'created_by', 'updated_at']),
]);

describe('T-08 #20 updateInventorySupplier: If-Match + strict SupplierPatch', () => {
  it('no If-Match -> 428 common.precondition_required, nothing read', async () => {
    const c = fresh();
    await expectLims(call('updateInventorySupplier', c.ctx, { params: { supplier_id: SUP }, body: { name: 'x' } }), 'common.precondition_required', 428);
    expect(c.tx.calls).toEqual([]);
  });
  it.each(['1', '"0"', '"abc"', 'W/"1"', '""'])('malformed If-Match %s -> 400', async (h) => {
    const c = fresh();
    await expectLims(call('updateInventorySupplier', c.ctx, { params: { supplier_id: SUP }, headers: { 'if-match': h }, body: { name: 'x' } }), 'common.validation_failed', 400);
    expect(c.tx.calls).toEqual([]);
  });
  const bad: [string, Record<string, unknown>][] = [
    ['supplier_code is immutable and not in SupplierPatch', { supplier_code: 'NEW' }], ['id', { id: uid(1) }], ['version', { version: 5 }], ['tenant_id', { tenant_id: '01a1a98a-ac40-7000-8000-00000000b001' }],
    ['name empty', { name: '' }], ['name 201 chars', { name: 'n'.repeat(201) }], ['pan_text with a space', { pan_text: 'A B' }], ['payment_terms_days 366', { payment_terms_days: 366 }],
    ['phone_display 41 chars', { phone_display: '1'.repeat(41) }], ['null instead of unset[] (CV §4.2)', { contact_name: null }],
    ['unset names a required field', { unset: ['name'] }], ['unset names supplier_code', { unset: ['supplier_code'] }], ['unset names an unknown field', { unset: ['bogus'] }],
    ['unset with 8 entries (max 7)', { unset: ['pan_text', 'contact_name', 'phone_display', 'email', 'address_text', 'payment_terms_days', 'notes', 'notes'] }], ['unset not an array', { unset: 'notes' }],
  ];
  it.each(bad)('%s -> 400 common.validation_failed, nothing read', async (_l, body) => {
    const c = fresh();
    await expectLims(call('updateInventorySupplier', c.ctx, { params: { supplier_id: SUP }, headers: ifm(1), body }), 'common.validation_failed', 400);
    expect(c.tx.calls).toEqual([]);
  });
});

strictBody('T-08 #22 putSupplierItem: strict body (05-SCHEMA §2.12, AC-04.2) -> 400', 'putSupplierItem', () => putSupplierItemBody(), { params: { supplier_id: SUP, item_id: ITEM, pack_id: PACK } }, [
  ['is_active missing', { is_active: undefined }, 'is_active'], ['is_active as string', { is_active: 'yes' }, 'is_active'],
  ['last_unit_price_paisa negative', { last_unit_price_paisa: -1 }, 'last_unit_price_paisa'], ['last_unit_price_paisa 1.5', { last_unit_price_paisa: 1.5 }, 'last_unit_price_paisa'],
  ['last_unit_price_paisa as string', { last_unit_price_paisa: '450000' }, 'last_unit_price_paisa'], ['last_unit_price_paisa above 2^53-1', { last_unit_price_paisa: 9007199254740992 }, 'last_unit_price_paisa'],
  ['last_unit_price_paisa null', { last_unit_price_paisa: null }, 'last_unit_price_paisa'],
  ['lead_time_days -1', { lead_time_days: -1 }, 'lead_time_days'], ['lead_time_days 366', { lead_time_days: 366 }, 'lead_time_days'], ['lead_time_days 7.5', { lead_time_days: 7.5 }, 'lead_time_days'],
  ['lead_time_days as string', { lead_time_days: '7' }, 'lead_time_days'], ['lead_time_days null', { lead_time_days: null }, 'lead_time_days'],
  ['default_tax_code lower case', { default_tax_code: 'vat' }, 'default_tax_code'], ['default_tax_code empty', { default_tax_code: '' }, 'default_tax_code'],
  ['default_tax_code 17 chars', { default_tax_code: 'A'.repeat(17) }, 'default_tax_code'], ['default_tax_code not a string', { default_tax_code: 42 }, 'default_tax_code'],
  ['supplier_item_code 65 chars', { supplier_item_code: 'c'.repeat(65) }, 'supplier_item_code'], ['supplier_item_code not a string', { supplier_item_code: 7 }, 'supplier_item_code'],
  ...MASS(['id', 'supplier_id', 'item_id', 'pack_id', 'tenant_id', 'version']),
]);

strictBody('T-08 #24 putInstrumentBinding: strict body (AC-17.1) -> 400', 'putInstrumentBinding', () => ({ store_id: STORE }), { params: { instrument_id: INSTR } }, [
  ['store_id missing', { store_id: undefined }, 'store_id'], ['store_id not a uuid', { store_id: 'nope' }, 'store_id'], ['store_id null', { store_id: null }, 'store_id'], ['store_id a number', { store_id: 42 }, 'store_id'],
  ...MASS(['instrument_id', 'id', 'tenant_id', 'version', 'is_active']),
]);

describe('T-08 If-Match on the PUT operations (#16 #22 #24): optional (only when the row exists), but when present it must be well formed -> 400, nothing read', () => {
  const puts: [string, any][] = [['putStoreItemSetting', VALID['putStoreItemSetting']], ['putSupplierItem', VALID['putSupplierItem']], ['putInstrumentBinding', VALID['putInstrumentBinding']]];
  for (const [op, req] of puts) {
    it.each(['1', '"0"', '"-1"', '"abc"', 'W/"1"', '""'])(`${op}: malformed If-Match %s -> 400`, async (h) => {
      const c = fresh();
      await expectLims(call(op, c.ctx, { ...req, headers: { 'if-match': h } }), 'common.validation_failed', 400);
      expect(c.tx.calls).toEqual([]);
    });
  }
});

describe('T-08 #25 deactivateInstrumentBinding: If-Match is required', () => {
  it('no If-Match -> 428 common.precondition_required, nothing read', async () => {
    const c = fresh();
    await expectLims(call('deactivateInstrumentBinding', c.ctx, { params: { instrument_id: INSTR } }), 'common.precondition_required', 428);
    expect(c.tx.calls).toEqual([]);
  });
  it.each(['1', '"0"', '"abc"', 'W/"1"', '""'])('malformed If-Match %s -> 400', async (h) => {
    const c = fresh();
    await expectLims(call('deactivateInstrumentBinding', c.ctx, { params: { instrument_id: INSTR }, headers: { 'if-match': h } }), 'common.validation_failed', 400);
    expect(c.tx.calls).toEqual([]);
  });
});

describe('T-08 list queries are validated before any read (only the contract parameters; limit 1..200; typed values)', () => {
  const lists: [string, Record<string, unknown>, [string, Record<string, unknown>][]][] = [
    ['listInventoryStores', {}, [['purpose unknown', { purpose: 'bogus' }], ['store_kind unknown', { store_kind: 'warehouse' }], ['branch_id not a uuid', { branch_id: 'nope' }], ['is_active not a boolean', { is_active: 'yes' }],
      ['unknown parameter tenant_id', { tenant_id: uid(1) }], ['unknown parameter q', { q: 'x' }]]],
    ['listStoreItemSettings', { params: { store_id: STORE } }, [['below_reorder not a boolean', { below_reorder: 'x' }], ['item_id not a uuid', { item_id: 'nope' }], ['unknown parameter', { sort: 'name' }]]],
    ['listInventorySuppliers', {}, [['is_active not a boolean', { is_active: 'yes' }], ['q not a string', { q: 42 }], ['unknown parameter', { tenant_id: uid(1) }]]],
    ['listSupplierItems', { params: { supplier_id: SUP } }, [['item_id not a uuid', { item_id: 'nope' }], ['unknown parameter', { pack_id: PACK }]]],
    ['listInstrumentBindings', {}, [['store_id not a uuid', { store_id: 'nope' }], ['unknown parameter', { instrument_id: INSTR }]]],
  ];
  for (const [op, base, bad] of lists) {
    const common: [string, Record<string, unknown>][] = [['limit 0', { limit: 0 }], ['limit 201', { limit: 201 }], ['limit 1.5', { limit: 1.5 }], ['limit as a string', { limit: '5' }], ['cursor with illegal characters', { cursor: 'a b!' }]];
    it.each([...bad, ...common])(`${op}: %s -> 400 common.validation_failed, nothing read`, async (_l, query) => {
      const c = fresh();
      await expectLims(call(op, c.ctx, { ...base, query }), 'common.validation_failed', 400);
      expect(c.tx.calls).toEqual([]);
    });
  }
});
