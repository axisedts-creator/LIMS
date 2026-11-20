// T0B-REGAPI-2 done_when (6): ICD master, coupons and custom field definitions: list, create, update with permission checks using EXISTING codes (no new code):
// list of ICD codes and custom field definitions = frontdesk.registration.create (the registration screen reads them); list of coupons and every create / update = frontdesk.settings.manage
// (privileged: aal2). Operations: list/create/updateIcdCode, list/create/updateCoupon, list/create/updateCustomFieldDefinition.
// PINNED PICKS (no contract text): a duplicate code / field_key in the tenant is 400 common.validation_failed with the key's path (errors.yaml has no 409 for it, T0C-REGPARITY-2 impl note);
// PATCH needs If-Match (absent 428 common.precondition_required, stale 409 common.version_conflict) and bumps version by 1; keys outside the update schema (code, field_key, field_type,
// percent, amount_paisa, used_count) are 400 (they never change); nothing is ever deleted, is_active=false deactivates; lists are ordered by code / field_key ascending (custom fields: sort_order, then field_key).
// Custom field values on a patient are checked against ACTIVE definitions of the tenant: a number must be numeric, a date ISO, a choice one of choices; a required one must be present.
// A code without a definition is left alone (REGAPI-1 tests store free custom fields).
import { describe, expect, it } from 'vitest';
import { call, newPatient, fails, req as preq } from '../patients/helpers.js';
import { T, TENANT_A, TENANT_B, as, codeOf, fire, forbidden, fresh, icd, idem, ifm, notFound, ok, ownerRows, rejected, req, schemaErrors, seed, superTx, tag, uid, upper, without } from './helpers.js';

const REG_ONLY = (w = fresh()) => without(w, 'frontdesk.settings.manage');
const AAL1 = (w = fresh()) => as(w, { mfa: 'aal1' });

// ------------------------------------------------------------------ ICD
const createIcd = (b: object, who = fresh()) => fire('createIcdCode', req({ headers: idem(), body: b }), who);
const updateIcd = (id: string, b: object, version: number | null, who = fresh()) => fire('updateIcdCode', req({ params: { icd_code_id: id }, headers: version === null ? {} : ifm(version), body: b }), who);
const listIcd = (query: object = {}, who = fresh()) => fire('listIcdCodes', req({ query: { limit: '200', ...query } }), who);

describe('ICD master (createIcdCode, updateIcdCode, listIcdCodes)', () => {
  it('create: 201 IcdCode (schema valid), active, version 1, stored for the tenant; duplicate code => 400 /code; the same code in tenant B is fine', { timeout: T }, async () => {
    const code = icd();
    const b = ok(await createIcd({ code, description: 'Synthetic infectious gastroenteritis' }), 201);
    expect(schemaErrors('IcdCode', b)).toEqual([]);
    expect(b).toMatchObject({ code, description: 'Synthetic infectious gastroenteritis', is_active: true, version: 1 });
    expect((await ownerRows('frontdesk.icd_codes', 'id = $1', [b.id]))[0]).toMatchObject({ tenant_id: TENANT_A, code });
    rejected(await createIcd({ code, description: 'again' }), 'common.validation_failed', '/code');
    ok(await createIcd({ code, description: 'tenant B copy' }, as(fresh(), { tenant: TENANT_B, centreIds: [], allCentres: true })), 201);
    expect(await ownerRows('frontdesk.icd_codes', 'tenant_id = $1 AND code = $2', [TENANT_A, code])).toHaveLength(1);
  });
  it('create validation: lower case / bad shape / empty / too long code and description, unknown key => 400', { timeout: T }, async () => {
    for (const body of [{ code: 'a09', description: 'x' }, { code: '', description: 'x' }, { code: 'A'.repeat(17), description: 'x' }, { code: '.A09', description: 'x' }, { code: icd() },
      { code: icd(), description: '' }, { code: icd(), description: 'x'.repeat(501) }, { code: icd(), description: 'x', extra: 1 }]) rejected(await createIcd(body));
    expect((await ownerRows('frontdesk.icd_codes', "description = 'x'")).length).toBe(0);
  });
  it('update: description and is_active change, version + 1, code stays; missing If-Match 428; stale 409; code in the body 400; unknown id 404', { timeout: T }, async () => {
    const c = ok(await createIcd({ code: icd(), description: 'before' }), 201);
    const u = ok(await updateIcd(c.id, { description: 'after', is_active: false }, 1));
    expect(u).toMatchObject({ id: c.id, code: c.code, description: 'after', is_active: false, version: 2 });
    rejected(await updateIcd(c.id, { description: 'x' }, null), 'common.precondition_required');
    rejected(await updateIcd(c.id, { description: 'x' }, 1), 'common.version_conflict');
    rejected(await updateIcd(c.id, { code: icd() }, 2));
    rejected(await updateIcd(c.id, {}, 2));
    notFound(await updateIcd(uid(), { description: 'x' }, 1));
    expect((await ownerRows('frontdesk.icd_codes', 'id = $1', [c.id]))[0]).toMatchObject({ code: c.code, description: 'after', is_active: false });
  });
  it('list: ordered by code, q matches a code prefix or description words, is_active filters; deactivated codes are still listed unfiltered', { timeout: T }, async () => {
    const p = `Q${String(Date.now() % 1e5)}`;
    const a = ok(await createIcd({ code: `${p}.B`, description: 'Synthetic zebra fever' }), 201); ok(await createIcd({ code: `${p}.A`, description: 'Synthetic yak fever' }), 201);
    await updateIcd(a.id, { is_active: false }, 1);
    const all = ok(await listIcd({ q: p }));
    expect(schemaErrors('IcdCodePage', all)).toEqual([]);
    expect(all.data.map((x: any) => x.code)).toEqual([`${p}.A`, `${p}.B`]);
    expect(ok(await listIcd({ q: p, is_active: 'false' })).data.map((x: any) => x.code)).toEqual([`${p}.B`]);
    expect(ok(await listIcd({ q: p, is_active: 'true' })).data.map((x: any) => x.code)).toEqual([`${p}.A`]);
    expect(ok(await listIcd({ q: 'zebra' })).data.map((x: any) => x.code)).toContain(`${p}.B`);
  });
  it('permissions: list needs registration.create only; create / update need settings.manage at aal2 (no new permission code)', { timeout: T }, async () => {
    const c = ok(await createIcd({ code: icd(), description: 'perm' }), 201);
    ok(await listIcd({}, REG_ONLY()));
    forbidden(await listIcd({}, without(fresh(), 'frontdesk.registration.create')));
    forbidden(await createIcd({ code: icd(), description: 'x' }, REG_ONLY()));
    forbidden(await updateIcd(c.id, { description: 'x' }, 1, REG_ONLY()));
    expect(codeOf(await createIcd({ code: icd(), description: 'x' }, AAL1()))).toBe('auth.mfa_required');
    expect(codeOf(await updateIcd(c.id, { description: 'x' }, 1, AAL1()))).toBe('auth.mfa_required');
    expect((await ownerRows('frontdesk.icd_codes', 'id = $1', [c.id]))[0].description).toBe('perm');
  });
});

// ------------------------------------------------------------------ coupons
const createCoupon = (b: object, who = fresh()) => fire('createCoupon', req({ headers: idem(), body: b }), who);
const updateCoupon = (id: string, b: object, version: number | null, who = fresh()) => fire('updateCoupon', req({ params: { coupon_id: id }, headers: version === null ? {} : ifm(version), body: b }), who);
const listCoupons = (query: object = {}, who = fresh()) => fire('listCoupons', req({ query: { limit: '200', ...query } }), who);
const cc = () => `CP${upper()}`;

describe('coupons (createCoupon, updateCoupon, listCoupons)', () => {
  it('create percent coupon and amount coupon: 201 Coupon (schema valid), used_count 0, active, version 1; duplicate code => 400 /code', { timeout: T }, async () => {
    const code = cc();
    const p = ok(await createCoupon({ code, percent: 10, valid_from: '2026-01-01', valid_to: '2027-12-31', usage_limit: 5 }), 201);
    expect(schemaErrors('Coupon', p)).toEqual([]);
    expect(p).toMatchObject({ code, percent: 10, valid_from: '2026-01-01', valid_to: '2027-12-31', usage_limit: 5, used_count: 0, is_active: true, version: 1 });
    const a = ok(await createCoupon({ code: cc(), amount_paisa: 5000 }), 201);
    expect(a).toMatchObject({ amount_paisa: 5000, used_count: 0 });
    expect(a).not.toHaveProperty('percent');
    rejected(await createCoupon({ code, percent: 5 }), 'common.validation_failed', '/code');
    expect(await ownerRows('frontdesk.coupons', 'tenant_id = $1 AND code = $2', [TENANT_A, code])).toHaveLength(1);
  });
  it('create validation: exactly one of percent / amount_paisa, percent 1..100, amount > 0, valid_to >= valid_from, usage_limit > 0, upper case code, no unknown key', { timeout: T }, async () => {
    const bad = [{ code: cc() }, { code: cc(), percent: 10, amount_paisa: 100 }, { code: cc(), percent: 0 }, { code: cc(), percent: 101 }, { code: cc(), amount_paisa: 0 }, { code: cc(), amount_paisa: -5 },
      { code: cc(), percent: 5, valid_from: '2026-05-02', valid_to: '2026-05-01' }, { code: cc(), percent: 5, usage_limit: 0 }, { code: cc().toLowerCase(), percent: 5 }, { code: '', percent: 5 },
      { code: cc(), percent: 5, used_count: 3 }, { code: cc(), percent: 5, valid_from: '2026-02-30' }, { code: cc(), percent: 5.5 }];
    for (const b of bad) rejected(await createCoupon(b));
    expect((await ownerRows('frontdesk.coupons', "tenant_id = $1 AND code = ANY($2)", [TENANT_A, bad.map((b) => b.code)])).length).toBe(0);
  });
  it('update: validity, usage_limit, is_active change and version + 1; value / code / used_count are immutable (400); usage_limit below used_count => 400; If-Match rules; unknown id 404', { timeout: T }, async () => {
    const c = ok(await createCoupon({ code: cc(), percent: 10, usage_limit: 10 }), 201);
    const u = ok(await updateCoupon(c.id, { valid_to: '2030-01-01', usage_limit: 20, is_active: false }, 1));
    expect(u).toMatchObject({ valid_to: '2030-01-01', usage_limit: 20, is_active: false, version: 2, code: c.code, percent: 10 });
    for (const b of [{ code: cc() }, { percent: 50 }, { amount_paisa: 100 }, { used_count: 0 }, {}]) rejected(await updateCoupon(c.id, b, 2));
    rejected(await updateCoupon(c.id, { usage_limit: 5 }, null), 'common.precondition_required');
    rejected(await updateCoupon(c.id, { usage_limit: 5 }, 1), 'common.version_conflict');
    notFound(await updateCoupon(uid(), { usage_limit: 5 }, 1));
    await superTx(async (tx) => { await tx.query('UPDATE frontdesk.coupons SET used_count = 4 WHERE id = $1', [c.id]); });
    rejected(await updateCoupon(c.id, { usage_limit: 3 }, 2), 'common.validation_failed', '/usage_limit');
    expect((await ownerRows('frontdesk.coupons', 'id = $1', [c.id]))[0]).toMatchObject({ usage_limit: 20, used_count: 4 });
  });
  it('list: ordered by code, is_active filter, never exposes another tenant\'s coupon', { timeout: T }, async () => {
    const p = `LST${upper()}`;
    const x = ok(await createCoupon({ code: `${p}B`, percent: 5 }), 201); ok(await createCoupon({ code: `${p}A`, percent: 5 }), 201);
    await updateCoupon(x.id, { is_active: false }, 1);
    await seed('frontdesk.coupons', { id: uid(), tenant_id: TENANT_B, code: `${p}Z`, percent: 5 });
    const all = ok(await listCoupons({}));
    expect(schemaErrors('CouponPage', all)).toEqual([]);
    const mine = all.data.filter((d: any) => d.code.startsWith(p)).map((d: any) => d.code);
    expect(mine).toEqual([`${p}A`, `${p}B`]);
    expect(ok(await listCoupons({ is_active: 'false' })).data.filter((d: any) => d.code.startsWith(p)).map((d: any) => d.code)).toEqual([`${p}B`]);
  });
  it('permissions: every coupon operation needs settings.manage at aal2 (registration.create alone is forbidden, aal1 is mfa_required)', { timeout: T }, async () => {
    const c = ok(await createCoupon({ code: cc(), percent: 5 }), 201);
    forbidden(await listCoupons({}, REG_ONLY())); forbidden(await createCoupon({ code: cc(), percent: 5 }, REG_ONLY())); forbidden(await updateCoupon(c.id, { usage_limit: 5 }, 1, REG_ONLY()));
    for (const o of [await listCoupons({}, AAL1()), await createCoupon({ code: cc(), percent: 5 }, AAL1()), await updateCoupon(c.id, { usage_limit: 5 }, 1, AAL1())]) expect(codeOf(o)).toBe('auth.mfa_required');
    expect((await ownerRows('frontdesk.coupons', 'id = $1', [c.id]))[0]).toMatchObject({ version: 1, usage_limit: null });
  });
});

// ------------------------------------------------------------------ custom field definitions
const createDef = (b: object, who = fresh()) => fire('createCustomFieldDefinition', req({ headers: idem(), body: b }), who);
const updateDef = (id: string, b: object, version: number | null, who = fresh()) => fire('updateCustomFieldDefinition', req({ params: { definition_id: id }, headers: version === null ? {} : ifm(version), body: b }), who);
const listDefs = (query: object = {}, who = fresh()) => fire('listCustomFieldDefinitions', req({ query: { limit: '200', ...query } }), who);
const fk = () => `cf_${tag()}`;

describe('custom field definitions (createCustomFieldDefinition, updateCustomFieldDefinition, listCustomFieldDefinitions)', () => {
  it('create text / number / date / choice: 201 (schema valid) with defaults required=false, is_active=true, version 1; choice keeps its choices; duplicate field_key => 400 /field_key', { timeout: T }, async () => {
    const key = fk();
    const t = ok(await createDef({ field_key: key, label: 'Synthetic text', field_type: 'text' }), 201);
    expect(schemaErrors('CustomFieldDefinition', t)).toEqual([]);
    expect(t).toMatchObject({ field_key: key, field_type: 'text', required: false, is_active: true, version: 1 });
    for (const field_type of ['number', 'date'] as const) expect(ok(await createDef({ field_key: fk(), label: field_type, field_type }), 201).field_type).toBe(field_type);
    const c = ok(await createDef({ field_key: fk(), label: 'Choice', field_type: 'choice', choices: ['A', 'B'], sort_order: 3, required: true, is_active: false }), 201);
    expect(c).toMatchObject({ choices: ['A', 'B'], sort_order: 3, required: true, is_active: false });
    rejected(await createDef({ field_key: key, label: 'dup', field_type: 'text' }), 'common.validation_failed', '/field_key');
  });
  it('create validation: key shape, type, choice needs 1..50 choices, choices only for type choice, sort_order 0..1000, label 1..100, no unknown key', { timeout: T }, async () => {
    const bad = [{ field_key: 'Upper', label: 'x', field_type: 'text' }, { field_key: '1abc', label: 'x', field_type: 'text' }, { field_key: 'a'.repeat(65), label: 'x', field_type: 'text' },
      { field_key: fk(), label: 'x', field_type: 'blob' }, { field_key: fk(), label: 'x', field_type: 'choice' }, { field_key: fk(), label: 'x', field_type: 'choice', choices: [] },
      { field_key: fk(), label: 'x', field_type: 'choice', choices: Array.from({ length: 51 }, (_, i) => `c${i}`) }, { field_key: fk(), label: 'x', field_type: 'text', choices: ['A'] },
      { field_key: fk(), label: 'x', field_type: 'text', sort_order: 1001 }, { field_key: fk(), label: '', field_type: 'text' }, { field_key: fk(), label: 'x'.repeat(101), field_type: 'text' },
      { field_key: fk(), label: 'x', field_type: 'text', extra: true }];
    for (const b of bad) rejected(await createDef(b));
    expect((await ownerRows('frontdesk.custom_field_definitions', 'tenant_id = $1 AND field_key = ANY($2)', [TENANT_A, bad.map((b) => b.field_key)])).length).toBe(0);
  });
  it('update: label, required, is_active, choices, sort_order change (version + 1); field_key and field_type never change (400); choices on a non-choice field 400; If-Match rules', { timeout: T }, async () => {
    const d = ok(await createDef({ field_key: fk(), label: 'Before', field_type: 'choice', choices: ['A'] }), 201);
    const u = ok(await updateDef(d.id, { label: 'After', required: true, is_active: false, choices: ['A', 'B'], sort_order: 9 }, 1));
    expect(u).toMatchObject({ label: 'After', required: true, is_active: false, choices: ['A', 'B'], sort_order: 9, version: 2, field_key: d.field_key, field_type: 'choice' });
    for (const b of [{ field_key: fk() }, { field_type: 'text' }, {}]) rejected(await updateDef(d.id, b, 2));
    const t = ok(await createDef({ field_key: fk(), label: 'Plain', field_type: 'text' }), 201);
    rejected(await updateDef(t.id, { choices: ['A'] }, 1));
    rejected(await updateDef(d.id, { label: 'x' }, null), 'common.precondition_required');
    rejected(await updateDef(d.id, { label: 'x' }, 1), 'common.version_conflict');
    notFound(await updateDef(uid(), { label: 'x' }, 1));
  });
  it('list: needs registration.create only (the registration screen), is_active filter, ordered by sort_order then field_key, tenant B definitions never shown', { timeout: T }, async () => {
    const p = `ord${tag()}`;
    ok(await createDef({ field_key: `${p}_b`, label: 'b', field_type: 'text', sort_order: 2 }), 201);
    ok(await createDef({ field_key: `${p}_a`, label: 'a', field_type: 'text', sort_order: 2 }), 201);
    const off = ok(await createDef({ field_key: `${p}_c`, label: 'c', field_type: 'text', sort_order: 1, is_active: false }), 201);
    await seed('frontdesk.custom_field_definitions', { id: uid(), tenant_id: TENANT_B, field_key: `${p}_bb`, label: 'b only', field_type: 'text' });
    const all = ok(await listDefs({}, REG_ONLY()));
    expect(schemaErrors('CustomFieldDefinitionPage', all)).toEqual([]);
    expect(all.data.filter((d: any) => d.field_key.startsWith(p)).map((d: any) => d.field_key)).toEqual([`${p}_c`, `${p}_a`, `${p}_b`]);
    expect(ok(await listDefs({ is_active: 'false' })).data.filter((d: any) => d.field_key.startsWith(p)).map((d: any) => d.id)).toEqual([off.id]);
    forbidden(await listDefs({}, without(fresh(), 'frontdesk.registration.create')));
  });
  it('create / update need settings.manage at aal2', { timeout: T }, async () => {
    const d = ok(await createDef({ field_key: fk(), label: 'perm', field_type: 'text' }), 201);
    forbidden(await createDef({ field_key: fk(), label: 'x', field_type: 'text' }, REG_ONLY())); forbidden(await updateDef(d.id, { label: 'x' }, 1, REG_ONLY()));
    expect(codeOf(await createDef({ field_key: fk(), label: 'x', field_type: 'text' }, AAL1()))).toBe('auth.mfa_required');
    expect(codeOf(await updateDef(d.id, { label: 'x' }, 1, AAL1()))).toBe('auth.mfa_required');
    expect((await ownerRows('frontdesk.custom_field_definitions', 'id = $1', [d.id]))[0]).toMatchObject({ label: 'perm', version: 1 });
  });
});

describe('patient custom_fields are validated against the ACTIVE definitions of the tenant', () => {
  const create = (custom_fields: unknown) => call('createPatient', preq({ body: newPatient({ custom_fields }), headers: { 'idempotency-key': `k-${uid()}` } }));
  const createFails = (custom_fields: unknown) => fails('createPatient', preq({ body: newPatient({ custom_fields }), headers: { 'idempotency-key': `k-${uid()}` } }));
  it('number must be numeric, date must be ISO, choice must be one of choices; a deactivated definition is no longer enforced', { timeout: T }, async () => {
    const n = fk(); const d = fk(); const c = fk();
    const defs = [ok(await createDef({ field_key: n, label: 'n', field_type: 'number' }), 201), ok(await createDef({ field_key: d, label: 'd', field_type: 'date' }), 201),
      ok(await createDef({ field_key: c, label: 'c', field_type: 'choice', choices: ['red', 'blue'] }), 201)];
    try {
      expect((await create([{ code: n, value: '12.5' }, { code: d, value: '2026-11-10' }, { code: c, value: 'red' }])).status).toBe(201);
      for (const bad of [[{ code: n, value: 'abc' }], [{ code: d, value: '10/11/2026' }], [{ code: d, value: '2026-02-30' }], [{ code: c, value: 'green' }]]) {
        const e = await createFails(bad);
        expect(e.code, JSON.stringify(bad)).toBe('common.validation_failed');
        expect(JSON.stringify(e.errors ?? [])).toContain('/custom_fields');
      }
      await updateDef(defs[2].id, { is_active: false }, 1);
      expect((await create([{ code: c, value: 'green' }])).status, 'inactive definitions are not enforced').toBe(201);
    } finally { for (const x of defs) await superTx(async (tx) => { await tx.query('UPDATE frontdesk.custom_field_definitions SET is_active = false WHERE id = $1', [x.id]); }); }
  });
  it('a required active definition makes the value mandatory (400 /custom_fields when missing, 201 when given)', { timeout: T }, async () => {
    const k = fk();
    const def = ok(await createDef({ field_key: k, label: 'req', field_type: 'text', required: true }), 201);
    try {
      const e = await createFails([{ code: `${k}_other`, value: 'x' }]);
      expect(e.code).toBe('common.validation_failed');
      expect(JSON.stringify(e.errors ?? [])).toContain('/custom_fields');
      expect((await create([{ code: k, value: 'given' }])).status).toBe(201);
    } finally { await superTx(async (tx) => { await tx.query('UPDATE frontdesk.custom_field_definitions SET is_active = false WHERE id = $1', [def.id]); }); }
  });
});
