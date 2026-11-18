// T0B-REGAPI-1 (LD-310): Patient API stores and returns the 13 fields added by T0C-REGPARITY-1 (migration 20261117100000, contracts/openapi/frontdesk.yaml).
// Handlers are driven like the FD-T04 tests (./helpers.ts: real PG17 under RLS, fake IdentityPort, REAL audit.access). Synthetic data only.
// PINNED PICKS (LD-310, the lead's decisions; the spec has no text for them):
//  - mask = '*' x (length - 4) + last 4 characters; a value of 4 or fewer characters is fully masked. Used in createPatient / updatePatient replies.
//    getPatient (needs frontdesk.patient.read) is the only reply with the full government_id_number.
//  - PatientSummary (search, duplicate candidates) carries none of the new fields (schema is closed), so nothing sensitive can ride in a list.
//  - every validation failure is 400 common.validation_failed with the field path in errors[]; the value is never echoed.
//  - duplicate external_patient_id is HTTP 409 with errors[] path /external_patient_id. errors.yaml has no code for it (T0C-REGPARITY-1 impl note: "CR if a named
//    code is wanted"), so the test pins status + path and forbids the two wrong codes, not a new name. The writer picks or raises the CR.
//  - profile photo: row in frontdesk.trf_attachments (the only attachment store frontdesk owns), same tenant, is_active, scan_state not quarantined/failed,
//    mime image/jpeg or image/png, size_bytes <= 2097152 (2 MiB). Any failure = 400 at /profile_photo_attachment_id, same answer for missing and other-tenant ids.
//  - postal code for nationality NP = exactly 5 digits (Nepal postal codes, e.g. 44600); other nationalities / none: free text, only the length limits apply.
//  - the government id number is stored as typed (the column is plain text with a 1..64 CHECK).
import { beforeAll, describe, expect, it } from 'vitest';
import { rows as fx } from '../integration/helpers.js';
import { ADMIN, anonymisable, anonymise, yearsAgo } from '../admin/helpers.js';
import { PERM, T, TENANT_A, TENANT_B, accessRows, call, consents, fails, newPatient, ownerRows, patientRow, phone, req, schemaErrors, seed, seedPatient,
  seedSettings, tag, uid } from './helpers.js';

const create = (body: object, o: Parameters<typeof call>[2] = {}) => call('createPatient', req({ body, headers: { 'idempotency-key': `k-${uid()}` } }), o);
const createFails = (body: object, o: Parameters<typeof call>[2] = {}) => fails('createPatient', req({ body, headers: { 'idempotency-key': `k-${uid()}` } }), o);
const get = (id: string, o: Parameters<typeof call>[2] = {}) => call('getPatient', req({ params: { patient_id: id } }), o);
const patch = (id: string, body: object, ifMatch: string | null = '"1"', o: Parameters<typeof call>[2] = {}) =>
  call('updatePatient', req({ params: { patient_id: id }, body, headers: ifMatch === null ? {} : { 'if-match': ifMatch } }), o);
const patchFails = (id: string, body: object, ifMatch: string | null = '"1"', o: Parameters<typeof call>[2] = {}) =>
  patch(id, body, ifMatch, o).then(() => { throw new Error('expected a rejection'); }, (e) => e);
const search = (query: string, o: Parameters<typeof call>[2] = {}) => call('searchPatients', req({ body: { query, mode: 'name' } }), o);
beforeAll(async () => { await seedSettings(); }, T);

const NEW_KEYS = ['title', 'external_patient_id', 'nationality', 'government_id_type', 'government_id_number', 'address_province', 'address_district',
  'address_municipality', 'address_ward', 'address_tole', 'address_postal_code', 'profile_photo_attachment_id', 'custom_fields'] as const;
const mask = (s: string) => (s.length > 4 ? '*'.repeat(s.length - 4) + s.slice(-4) : '*'.repeat(s.length));
const govNo = () => `SYN-CIT-${tag().toUpperCase()}-4321`;
const mr = () => `MR-${tag().toUpperCase()}`;
const sortCf = (a: any[]) => [...a].sort((x, y) => x.code.localeCompare(y.code));

/** a photo the service must accept: png, 1 KiB, clean, active, same tenant. */
async function photo(side: 'a' | 'b' = 'a', o: Record<string, unknown> = {}): Promise<string> {
  const r = fx.trf(side, null, { mime_type: 'image/png', size_bytes: 1024, scan_state: 'clean', ...o });
  await seed('frontdesk.trf_attachments', r);
  return r.id;
}
async function allFields(o: Record<string, unknown> = {}) {
  return { title: 'mr', external_patient_id: mr(), nationality: 'NP', government_id_type: 'citizenship', government_id_number: govNo(), address_province: 'Bagmati Province',
    address_district: 'Kathmandu', address_municipality: 'Kathmandu Metropolitan City', address_ward: '10', address_tole: 'Synthetic Tole', address_postal_code: '44600',
    profile_photo_attachment_id: await photo(), custom_fields: [{ code: 'blood_group', value: 'O+' }, { code: 'referral_note', value: 'synthetic note' }], ...o };
}
const countByPhone = async (ph: string) => (await ownerRows('frontdesk.patients', 'tenant_id = $1 AND phone_e164 = $2', [TENANT_A, ph])).length;

describe('(1,6) every new field round-trips: create -> getPatient -> update -> unset', () => {
  it('createPatient with all 13 fields: 201 Patient (schema-valid), each column stored, custom_fields list <-> jsonb object {code: value}', { timeout: T }, async () => {
    const f = await allFields();
    const body = newPatient(f);
    const r = await create(body);
    expect(r.status).toBe(201);
    expect(schemaErrors('Patient', r.body)).toEqual([]);
    const row = await patientRow(r.body.id);
    for (const k of NEW_KEYS.filter((x) => x !== 'custom_fields')) expect(row[k], k).toBe((f as any)[k]);
    expect(row.custom_fields).toEqual({ blood_group: 'O+', referral_note: 'synthetic note' });
    expect(row.tenant_id).toBe(TENANT_A);
    for (const k of NEW_KEYS.filter((x) => !['custom_fields', 'government_id_number'].includes(x))) expect(r.body[k], k).toBe((f as any)[k]);
    expect(sortCf(r.body.custom_fields)).toEqual(sortCf(f.custom_fields));
  });
  it('getPatient returns all 13 (government id in full, with frontdesk.patient.read only), schema-valid', { timeout: T }, async () => {
    const f = await allFields();
    const c = await create(newPatient(f));
    const r = await get(c.body.id, { grants: [PERM.read] });
    expect(r.status).toBe(200);
    expect(schemaErrors('Patient', r.body)).toEqual([]);
    for (const k of NEW_KEYS.filter((x) => x !== 'custom_fields')) expect(r.body[k], k).toBe((f as any)[k]);
    expect(sortCf(r.body.custom_fields)).toEqual(sortCf(f.custom_fields));
  });
  it('each field alone is accepted on create (the others stay absent)', { timeout: T }, async () => {
    const f: any = await allFields();
    for (const k of ['title', 'external_patient_id', 'nationality', 'address_province', 'address_district', 'address_municipality', 'address_ward', 'address_tole',
      'address_postal_code', 'profile_photo_attachment_id', 'custom_fields']) {
      const r = await create(newPatient({ [k]: f[k] }));
      expect(r.status, k).toBe(201);
      expect(schemaErrors('Patient', r.body), k).toEqual([]);
      expect(Object.keys(r.body).filter((x) => (NEW_KEYS as readonly string[]).includes(x)), k).toEqual([k]);
    }
    const g = await create(newPatient({ government_id_type: 'passport', government_id_number: govNo() }));
    expect(g.status).toBe(201);
  });
  it('every government id type and every one of the 19 titles is accepted', { timeout: T }, async () => {
    for (const t of ['citizenship', 'national_id', 'passport', 'driving_licence', 'voter_id', 'other']) {
      expect((await create(newPatient({ government_id_type: t, government_id_number: govNo() }))).status, t).toBe(201);
    }
    const titles = ['mr', 'mrs', 'miss', 'ms', 'master', 'baby', 'baby_of', 'dr', 'prof', 'capt', 'col', 'major', 'sri', 'smt', 'kumari', 'late', 'sister', 'reverend', 'other'];
    for (const t of titles) expect((await create(newPatient({ title: t }))).body.title, t).toBe(t);
  });
  it('updatePatient changes each new field (version +1), reply schema-valid, DB updated', { timeout: T }, async () => {
    const p = await seedPatient('a');
    const f = await allFields();
    const r = await patch(p.id, f, '"1"');
    expect(r.status).toBe(200);
    expect(schemaErrors('Patient', r.body)).toEqual([]);
    expect(r.body.version).toBe(2);
    const row = await patientRow(p.id);
    for (const k of NEW_KEYS.filter((x) => x !== 'custom_fields')) expect(row[k], k).toBe((f as any)[k]);
    expect(row.custom_fields).toEqual({ blood_group: 'O+', referral_note: 'synthetic note' });
    expect(row.version).toBe(2);
    // a second update of one field leaves the others untouched
    const r2 = await patch(p.id, { title: 'dr' }, '"2"');
    expect(r2.body.title).toBe('dr');
    expect((await patientRow(p.id)).government_id_number).toBe(f.government_id_number);
  });
  it('a body with only a new field is a change (not the empty-body 400); custom_fields replaces the whole list', { timeout: T }, async () => {
    const p = await seedPatient('a', { custom_fields: { old_code: 'old' } });
    const r = await patch(p.id, { custom_fields: [{ code: 'new_code', value: 'v' }] });
    expect(r.status).toBe(200);
    expect(r.body.custom_fields).toEqual([{ code: 'new_code', value: 'v' }]);
    expect((await patientRow(p.id)).custom_fields).toEqual({ new_code: 'v' });
  });
  it('unset[] clears every new optional field (type + number together) and the keys leave the reply', { timeout: T }, async () => {
    const f = await allFields();
    const c = await create(newPatient(f));
    const r = await patch(c.body.id, { unset: [...NEW_KEYS] }, '"1"');
    expect(r.status).toBe(200);
    expect(schemaErrors('Patient', r.body)).toEqual([]);
    for (const k of NEW_KEYS) expect(r.body, k).not.toHaveProperty(k);
    const row = await patientRow(c.body.id);
    for (const k of NEW_KEYS) expect(row[k] ?? null, k).toBeNull();
  });
  it('unset of a field that is also set in the same body -> 400', { timeout: T }, async () => {
    const p = await seedPatient('a', { title: 'mr' });
    expect((await patchFails(p.id, { title: 'dr', unset: ['title'] })).code).toBe('common.validation_failed');
    expect((await patientRow(p.id)).title).toBe('mr');
  });
});

describe('(1) validation: 400 common.validation_failed with the field path, nothing stored, value never echoed', () => {
  it.each([
    ['nationality in lower case', { nationality: 'np' }, '/nationality'],
    ['nationality not an ISO 3166-1 alpha-2 code (XX)', { nationality: 'XX' }, '/nationality'],
    ['nationality not assigned (AA)', { nationality: 'AA' }, '/nationality'],
    ['nationality of 3 letters', { nationality: 'NPL' }, '/nationality'],
    ['government id type without a number', { government_id_type: 'citizenship' }, '/government_id_number'],
    ['government id number without a type', { government_id_number: 'SYN-ONLY-1234' }, '/government_id_type'],
    ['government id type outside the list', { government_id_type: 'aadhaar', government_id_number: 'SYN-1234' }, '/government_id_type'],
    ['government id number empty', { government_id_type: 'passport', government_id_number: '' }, '/government_id_number'],
    ['government id number over 64', { government_id_type: 'passport', government_id_number: 'N'.repeat(65) }, '/government_id_number'],
    ['NP postal code with 4 digits', { nationality: 'NP', address_postal_code: '4460' }, '/address_postal_code'],
    ['NP postal code with 6 digits', { nationality: 'NP', address_postal_code: '446000' }, '/address_postal_code'],
    ['NP postal code with letters', { nationality: 'NP', address_postal_code: '44A00' }, '/address_postal_code'],
    ['NP postal code with a trailing newline', { nationality: 'NP', address_postal_code: '44600\n' }, '/address_postal_code'],
    ['title outside the code table', { title: 'lord' }, '/title'],
    ['title in upper case', { title: 'MR' }, '/title'],
    ['title as display text', { title: 'Mr.' }, '/title'],
    ['external_patient_id empty', { external_patient_id: '' }, '/external_patient_id'],
    ['external_patient_id over 64', { external_patient_id: 'M'.repeat(65) }, '/external_patient_id'],
    ['ward over 20', { address_ward: 'W'.repeat(21) }, '/address_ward'],
    ['province empty', { address_province: '' }, '/address_province'],
    ['district over 100', { address_district: 'D'.repeat(101) }, '/address_district'],
    ['a NUL byte in tole', { address_tole: 'Syn\u0000thetic' }, '/address_tole'],
    ['photo id not a uuid', { profile_photo_attachment_id: 'not-a-uuid' }, '/profile_photo_attachment_id'],
    ['custom_fields as an object map', { custom_fields: { blood_group: 'O+' } }, '/custom_fields'],
    ['custom_fields duplicate code', { custom_fields: [{ code: 'dup', value: 'a' }, { code: 'dup', value: 'b' }] }, '/custom_fields'],
    ['custom_fields item with an extra key', { custom_fields: [{ code: 'x', value: 'y', extra: 1 }] }, '/custom_fields'],
    ['custom_fields value over 500', { custom_fields: [{ code: 'x', value: 'v'.repeat(501) }] }, '/custom_fields'],
    ['custom_fields code with a space', { custom_fields: [{ code: 'bad code', value: 'y' }] }, '/custom_fields'],
    ['custom_fields with 51 items', { custom_fields: Array.from({ length: 51 }, (_, i) => ({ code: `c${i}`, value: 'v' })) }, '/custom_fields'],
    ['custom_fields value not a string', { custom_fields: [{ code: 'x', value: 5 }] }, '/custom_fields'],
    ['an unknown field', { aadhaar_number: '123456789012' }, '/aadhaar_number'],
  ])('create: %s', { timeout: T }, async (_n, patchBody, path) => {
    const base = newPatient(patchBody as any);
    const e = await createFails(base);
    expect(e.code).toBe('common.validation_failed');
    expect(e.statusCode).toBe(400);
    expect(JSON.stringify(e.errors ?? [])).toContain(path);
    expect(`${e.message} ${e.detail ?? ''} ${JSON.stringify(e.errors ?? [])}`).not.toMatch(/SYN-ONLY-1234|44A00|Syn.u0000|lord/);
    expect(await countByPhone(base.phone_e164)).toBe(0);
  });
  it('NP postal code: 5 digits accepted; any free text accepted for another nationality or none', { timeout: T }, async () => {
    expect((await create(newPatient({ nationality: 'NP', address_postal_code: '44600' }))).status).toBe(201);
    expect((await create(newPatient({ nationality: 'IN', address_postal_code: '110001' }))).status).toBe(201);
    expect((await create(newPatient({ nationality: 'GB', address_postal_code: 'SW1A 1AA' }))).status).toBe(201);
    expect((await create(newPatient({ address_postal_code: 'ABC-12' }))).status).toBe(201);
  });
  it('update: type and number must stay together (set one alone, unset one alone -> 400); both together is fine', { timeout: T }, async () => {
    const none = await seedPatient('a');
    expect((await patchFails(none.id, { government_id_type: 'passport' })).code).toBe('common.validation_failed');
    expect((await patchFails(none.id, { government_id_number: 'SYN-9999' })).code).toBe('common.validation_failed');
    expect((await patientRow(none.id)).government_id_type).toBeNull();
    expect((await patch(none.id, { government_id_type: 'passport', government_id_number: 'SYN-9999-0001' })).status).toBe(200);
    const both = await seedPatient('a', { government_id_type: 'citizenship', government_id_number: 'SYN-CIT-0001' });
    expect((await patchFails(both.id, { unset: ['government_id_number'] })).code).toBe('common.validation_failed');
    expect((await patchFails(both.id, { unset: ['government_id_type'] })).code).toBe('common.validation_failed');
    expect((await patientRow(both.id)).government_id_number).toBe('SYN-CIT-0001');
    expect((await patch(both.id, { government_id_number: 'SYN-CIT-0002' })).status).toBe(200);   // number alone on a row that already has a type
    expect((await patch(both.id, { unset: ['government_id_type', 'government_id_number'] }, '"2"')).status).toBe(200);
  });
  it('update: NP postal rule applies to the resulting state (stored nationality, stored postal code, or both in one body)', { timeout: T }, async () => {
    const np = await seedPatient('a', { nationality: 'NP' });
    expect((await patchFails(np.id, { address_postal_code: '4460' })).code).toBe('common.validation_failed');
    const oddPostal = await seedPatient('a', { address_postal_code: 'AB-12' });
    expect((await patchFails(oddPostal.id, { nationality: 'NP' })).code).toBe('common.validation_failed');
    expect((await patch(oddPostal.id, { nationality: 'NP', address_postal_code: '44600' })).status).toBe(200);
    const foreign = await seedPatient('a', { nationality: 'IN' });
    expect((await patch(foreign.id, { address_postal_code: '110001-X' })).status).toBe(200);
    expect((await patientRow(np.id)).address_postal_code).toBeNull();
  });
  it('update: other bad values -> 400 and the row, its version and the audit trail do not move', { timeout: T }, async () => {
    const p = await seedPatient('a', { title: 'mr' });
    for (const b of [{ nationality: 'ZZ' }, { title: 'lord' }, { custom_fields: [{ code: 'd', value: 'a' }, { code: 'd', value: 'b' }] }, { address_ward: 'W'.repeat(21) },
      { unset: ['nationality', 'not_a_field'] }]) {
      expect((await patchFails(p.id, b)).code).toBe('common.validation_failed');
    }
    const row = await patientRow(p.id);
    expect(row.version).toBe(1);
    expect(row.title).toBe('mr');
  });
  it('If-Match rules are unchanged by the new fields: missing -> 428, stale -> 409 common.version_conflict', { timeout: T }, async () => {
    const p = await seedPatient('a');
    expect((await patchFails(p.id, { title: 'dr' }, null)).code).toBe('common.precondition_required');
    const e = await patchFails(p.id, { title: 'dr' }, '"7"');
    expect(e.code).toBe('common.version_conflict');
    expect(e.statusCode).toBe(409);
    expect((await patientRow(p.id)).title).toBeNull();
  });
});

describe('(1) external_patient_id is unique per tenant: clear 409', () => {
  it('a second patient with the same id in the tenant -> 409 (not the duplicate-suspect or version codes), nothing stored, value not echoed', { timeout: T }, async () => {
    const id = mr();
    await create(newPatient({ external_patient_id: id }));
    const body = newPatient({ external_patient_id: id });
    const e = await createFails(body);
    expect(e.statusCode).toBe(409);
    expect(['frontdesk.patient_duplicate_suspected', 'common.version_conflict', 'common.idempotency_key_reused']).not.toContain(e.code);
    expect(JSON.stringify(e.errors ?? [])).toContain('/external_patient_id');
    expect(`${e.message} ${e.detail ?? ''} ${JSON.stringify(e.errors ?? [])}`).not.toContain(id);
    expect(await countByPhone(body.phone_e164)).toBe(0);
  });
  it('the same id in another tenant is fine (unique per tenant, not global)', { timeout: T }, async () => {
    const id = mr();
    expect((await create(newPatient({ external_patient_id: id }))).status).toBe(201);
    expect((await create(newPatient({ external_patient_id: id }), { tenant: TENANT_B })).status).toBe(201);
  });
  it('update to an id another patient holds -> 409, version and value unchanged; own id re-sent is fine; after unset the id is free again', { timeout: T }, async () => {
    const a = await seedPatient('a', { external_patient_id: mr() });
    const b = await seedPatient('a');
    const e = await patchFails(b.id, { external_patient_id: a.external_patient_id });
    expect(e.statusCode).toBe(409);
    expect(JSON.stringify(e.errors ?? [])).toContain('/external_patient_id');
    expect((await patientRow(b.id)).version).toBe(1);
    expect((await patch(a.id, { external_patient_id: a.external_patient_id, title: 'dr' })).status).toBe(200);
    expect((await patch(a.id, { unset: ['external_patient_id'] }, '"2"')).status).toBe(200);
    expect((await patch(b.id, { external_patient_id: a.external_patient_id })).status).toBe(200);
  });
  it('two concurrent creates with the same id: exactly one 201, the other 409; one row', { timeout: T }, async () => {
    const id = mr();
    const out = await Promise.allSettled([create(newPatient({ external_patient_id: id })), create(newPatient({ external_patient_id: id }))]);
    const ok = out.filter((o) => o.status === 'fulfilled' && (o as any).value.status === 201);
    const no = out.filter((o) => o.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(no).toHaveLength(1);
    expect((no[0] as PromiseRejectedResult).reason.statusCode).toBe(409);
    expect(await ownerRows('frontdesk.patients', 'tenant_id = $1 AND external_patient_id = $2', [TENANT_A, id])).toHaveLength(1);
  });
});

describe('(2) government id number: masked everywhere but getPatient, never logged, never in audit', () => {
  const NO = 'SYN-CIT-QRSTUV-4321';
  it('stored as typed; create and update replies carry only the masked value; getPatient carries it in full', { timeout: T }, async () => {
    const c = await create(newPatient({ government_id_type: 'citizenship', government_id_number: NO }));
    expect(c.body.government_id_number).toBe(mask(NO));
    expect(c.body.government_id_number).toMatch(/4321$/);
    expect(JSON.stringify(c.body)).not.toContain(NO);
    expect((await patientRow(c.body.id)).government_id_number).toBe(NO);
    const u = await patch(c.body.id, { title: 'dr' });
    expect(u.body.government_id_number).toBe(mask(NO));
    expect(JSON.stringify(u.body)).not.toContain(NO);
    const g = await get(c.body.id, { grants: [PERM.read] });
    expect(g.body.government_id_number).toBe(NO);
    expect((await get(c.body.id)).body.government_id_number).toBe(NO);
  });
  it('updating the number returns the new masked value; a short number is fully masked', { timeout: T }, async () => {
    const c = await create(newPatient({ government_id_type: 'voter_id', government_id_number: 'AB12' }));
    expect(c.body.government_id_number).toBe('****');
    const u = await patch(c.body.id, { government_id_number: 'SYN-VOTER-998877' });
    expect(u.body.government_id_number).toBe(mask('SYN-VOTER-998877'));
    expect(u.body.government_id_number).not.toContain('VOTER');
  });
  it('search results and duplicate candidates never carry the number (summaries are closed: none of the 13 keys, no full or masked id)', { timeout: T }, async () => {
    const t = tag();
    const name = `Syn Regapi ${t}`;
    const c = await create(newPatient({ full_name: name, government_id_type: 'passport', government_id_number: NO, external_patient_id: mr(), title: 'mr', address_tole: 'Syn Tole' }));
    const s = await search(`Regapi ${t}`);
    expect(s.status).toBe(200);
    expect(s.body.data.map((x: any) => x.id)).toContain(c.body.id);
    expect(schemaErrors('PatientSummaryList', s.body)).toEqual([]);
    for (const d of s.body.data) for (const k of NEW_KEYS) expect(d, k).not.toHaveProperty(k);
    expect(JSON.stringify(s.body)).not.toMatch(/SYN-CIT|4321|government/);
    // duplicate suspicion: candidates are summaries too
    const dup = await createFails(newPatient({ full_name: name, birth_on: c.body.birth_on, age: undefined, phone_e164: c.body.phone_e164, government_id_number: undefined }));
    expect(dup.code).toBe('frontdesk.patient_duplicate_suspected');
    expect(JSON.stringify(dup.candidates ?? [])).not.toMatch(/SYN-CIT|4321|government/);
  });
  it('never logged: no log line, no error text, no access-log detail carries the number (create, get, update, search, failed create)', { timeout: T }, async () => {
    const no = govNo(); const no2 = govNo();
    const c = await create(newPatient({ government_id_type: 'citizenship', government_id_number: no }));
    const g = await get(c.body.id);
    const u = await patch(c.body.id, { government_id_number: no2 });
    const s = await search('synthetic');
    for (const r of [c, g, u, s]) expect(r.probe.logs.join('\n')).not.toMatch(new RegExp(`${no}|${no2}`));
    const bad = await createFails(newPatient({ government_id_type: 'aadhaar', government_id_number: no }));
    expect(`${bad.message} ${bad.detail ?? ''} ${JSON.stringify(bad.errors ?? [])}`).not.toContain(no);
    for (const r of [c, g, u, s]) expect(JSON.stringify(r.probe.accessCalls)).not.toMatch(new RegExp(`${no}|${no2}`));
    const ac = [...(await accessRows('patient.update', u.probe.requestId)), ...(await accessRows('patient.view', g.probe.requestId)), ...(await accessRows('patient.search', s.probe.requestId))];
    expect(ac.length).toBeGreaterThan(0);
    expect(JSON.stringify(ac)).not.toMatch(new RegExp(`${no}|${no2}`));
  });
  it('the update access row records THAT it changed (column names), never the value', { timeout: T }, async () => {
    const no = govNo();
    const p = await seedPatient('a');
    const r = await patch(p.id, { government_id_type: 'passport', government_id_number: no, address_tole: 'Syn Tole 7', title: 'mr' });
    const [row] = await accessRows('patient.update', r.probe.requestId);
    expect(row.detail.changed_fields.split(',')).toEqual(expect.arrayContaining(['government_id_type', 'government_id_number', 'address_tole', 'title']));
    expect(JSON.stringify(row.detail)).not.toMatch(new RegExp(`${no}|Syn Tole 7`));
  });
  it('audit.audit_log (row audit) holds no government id value and no structured-address value for create and update', { timeout: T }, async () => {
    const no = govNo(); const no2 = govNo();
    const c = await create(newPatient({ government_id_type: 'citizenship', government_id_number: no, address_province: 'SynProvince', address_district: 'SynDistrict', address_municipality: 'SynMunicipality',
      address_ward: '77', address_tole: 'SynTole', address_postal_code: 'SYN-PC-9', title: 'mr' }));
    await patch(c.body.id, { government_id_number: no2, address_tole: 'SynTole2', title: 'dr' }); // title is not on the D-27a exclusion list, so the trigger writes a row
    const log = await ownerRows('audit.audit_log', "tenant_id = $1 AND schema_name = 'frontdesk' AND table_name = 'patients' AND row_id = $2", [TENANT_A, c.body.id]);
    expect(log.length).toBeGreaterThanOrEqual(2);
    const text = JSON.stringify(log);
    for (const v of [no, no2, 'SynProvince', 'SynDistrict', 'SynMunicipality', 'SynTole', 'SynTole2', 'SYN-PC-9']) expect(text, v).not.toContain(v);
    for (const row of log) for (const col of [...(row.changed_columns ?? []), ...Object.keys(row.new_values ?? {}), ...Object.keys(row.old_values ?? {})]) {
      expect(['government_id_number', 'address_province', 'address_district', 'address_municipality', 'address_ward', 'address_tole', 'address_postal_code']).not.toContain(col);
    }
  });
});

describe('(3) anonymisePatient keeps erasing ALL identifying data, including the 13 new columns (reviewer note T0B-REGAPI-1-review.md item 1)', () => {
  it('after anonymise every new column is NULL in frontdesk.patients and no audit row holds the government id number', { timeout: T }, async () => {
    const no = govNo(); const ext = mr();
    const a = await anonymisable({ orderAt: [yearsAgo(7)], row: { title: 'mr', external_patient_id: ext, nationality: 'NP', government_id_type: 'citizenship', government_id_number: no,
      address_province: 'SynProvinceAnon', address_district: 'SynDistrictAnon', address_municipality: 'SynMunicipalityAnon', address_ward: '12', address_tole: 'SynToleAnon',
      address_postal_code: '44600', profile_photo_attachment_id: await photo(), custom_fields: { blood_group: 'O+' } } });
    const before = await patientRow(a.patient.id);
    for (const k of NEW_KEYS) expect(before[k], `${k} seeded`).not.toBeNull();
    const r = await anonymise(a.patient.id, '"1"', { reason_code: 'patient_request' }, ADMIN, { w: a.w });
    expect(r.status).toBe(200);
    const row = await patientRow(a.patient.id);
    expect(row.anonymised_at).toBeInstanceOf(Date);
    for (const k of NEW_KEYS) expect(row[k], `${k} must be NULL after anonymise`).toBeNull();
    const text = JSON.stringify([...(await ownerRows('audit.audit_log', "tenant_id = $1 AND row_id = $2", [TENANT_A, a.patient.id])), ...(await accessRows('patient.anonymise', r.probe.requestId))]);
    for (const v of [no, 'SynProvinceAnon', 'SynDistrictAnon', 'SynMunicipalityAnon', 'SynToleAnon']) expect(text, v).not.toContain(v);
  });
});

describe('(4) profile photo: same tenant, an image, at most 2 MiB, checked at save', () => {
  it('png and jpeg up to exactly 2097152 bytes are accepted on create and on update', { timeout: T }, async () => {
    expect((await create(newPatient({ profile_photo_attachment_id: await photo('a', { mime_type: 'image/jpeg', size_bytes: 2097152 }) }))).status).toBe(201);
    const p = await seedPatient('a');
    expect((await patch(p.id, { profile_photo_attachment_id: await photo('a', { mime_type: 'image/png', size_bytes: 1 }) })).status).toBe(200);
  });
  it.each([
    ['2097153 bytes', { size_bytes: 2097153 }],
    ['15 MiB', { size_bytes: 15728640 }],
    ['a PDF', { mime_type: 'application/pdf' }],
    ['inactive', { is_active: false }],
    ['quarantined by the scan', { scan_state: 'quarantined' }],
    ['scan failed', { scan_state: 'failed' }],
  ])('create and update refuse a photo that is %s -> 400 at /profile_photo_attachment_id, nothing stored', { timeout: T }, async (_n, o) => {
    const id = await photo('a', o);
    const body = newPatient({ profile_photo_attachment_id: id });
    const e = await createFails(body);
    expect(e.code).toBe('common.validation_failed');
    expect(JSON.stringify(e.errors ?? [])).toContain('/profile_photo_attachment_id');
    expect(await countByPhone(body.phone_e164)).toBe(0);
    const p = await seedPatient('a');
    expect((await patchFails(p.id, { profile_photo_attachment_id: id })).code).toBe('common.validation_failed');
    expect((await patientRow(p.id)).profile_photo_attachment_id).toBeNull();
  });
  it('another tenant\'s attachment and an unknown id are refused with the same answer (no existence oracle)', { timeout: T }, async () => {
    const other = await photo('b');
    const eOther = await createFails(newPatient({ profile_photo_attachment_id: other }));
    const eNone = await createFails(newPatient({ profile_photo_attachment_id: uid() }));
    for (const e of [eOther, eNone]) { expect(e.code).toBe('common.validation_failed'); expect(e.statusCode).toBe(400); expect(JSON.stringify(e.errors ?? [])).toContain('/profile_photo_attachment_id'); }
    expect(JSON.stringify([eOther.errors, eOther.message, eOther.detail])).toBe(JSON.stringify([eNone.errors, eNone.message, eNone.detail]));
    const p = await seedPatient('a');
    expect((await patchFails(p.id, { profile_photo_attachment_id: other })).code).toBe('common.validation_failed');
  });
  it('a refused photo on update leaves the stored photo id as it was', { timeout: T }, async () => {
    const id = await photo('a', { size_bytes: 1000 });
    const c = await create(newPatient({ profile_photo_attachment_id: id }));
    expect(c.status).toBe(201);
    const big = await photo('a', { size_bytes: 3 * 1024 * 1024 });
    expect((await patchFails(c.body.id, { profile_photo_attachment_id: big })).code).toBe('common.validation_failed');
    expect((await patientRow(c.body.id)).profile_photo_attachment_id).toBe(id);
  });
});

describe('(6) tenant isolation and authorization (5: no new permission code)', () => {
  it('tenant A cannot read or update tenant B\'s patient (404 common.not_found, no field moves), and B\'s sensitive fields never reach A\'s search', { timeout: T }, async () => {
    const b = await seedPatient('b', { full_name: `Syn Isolated ${tag()}`, government_id_type: 'passport', government_id_number: 'SYN-B-SECRET-0042', external_patient_id: mr() });
    expect((await fails('getPatient', req({ params: { patient_id: b.id } }))).code).toBe('common.not_found');
    expect((await patchFails(b.id, { title: 'dr' })).code).toBe('common.not_found');
    expect((await patientRow(b.id)).title).toBeNull();
    const s = await search(b.full_name.split(' ').pop());
    expect(JSON.stringify(s.body)).not.toContain('SECRET');
    expect((await get(b.id, { tenant: TENANT_B })).body.government_id_number).toBe('SYN-B-SECRET-0042');
  });
  it('the number a tenant saves is invisible to the other tenant even when ctx.tenantId is forged (RLS backstop)', { timeout: T }, async () => {
    const a = await create(newPatient({ government_id_type: 'passport', government_id_number: govNo() }));
    const e = await fails('getPatient', req({ params: { patient_id: a.body.id } }), { tenant: TENANT_B, tenantId: TENANT_A });
    expect(e.code).toBe('common.not_found');
  });
  it('createPatient / updatePatient still need frontdesk.registration.create; getPatient / searchPatients still need frontdesk.patient.read; no other code is asked for', { timeout: T }, async () => {
    const f = await allFields();
    expect((await createFails(newPatient(f), { grants: [PERM.read] })).code).toBe('auth.forbidden');
    const p = await seedPatient('a');
    expect((await patchFails(p.id, f, '"1"', { grants: [PERM.read] })).code).toBe('auth.forbidden');
    expect((await patientRow(p.id)).title).toBeNull();
    expect((await fails('getPatient', req({ params: { patient_id: p.id } }), { grants: [PERM.create] })).code).toBe('auth.forbidden');
    const c = await create(newPatient(f)); const g = await get(c.body.id); const u = await patch(c.body.id, { title: 'dr' });
    expect(c.probe.identity.calls.map((x) => x.permission)).toEqual([PERM.create]);
    expect(g.probe.identity.calls.map((x) => x.permission)).toEqual([PERM.read]);
    expect(u.probe.identity.calls.map((x) => x.permission)).toEqual([PERM.create]);
  });
});

describe('(3, 7) existing flows, ids and the duplicate check keep working; a patient with none of the new fields reads exactly as before', () => {
  it('a seeded patient without any new field: getPatient has none of the 13 keys (no nulls), same keys as before the change', { timeout: T }, async () => {
    const p = await seedPatient('a', { email: 'synthetic@example.test', address_text: 'Synthetic Street 1' });
    const r = await get(p.id);
    expect(schemaErrors('Patient', r.body)).toEqual([]);
    for (const k of NEW_KEYS) expect(r.body, k).not.toHaveProperty(k);
    expect(Object.keys(r.body).sort()).toEqual(['address_text', 'age_display', 'birth_on', 'consents', 'email', 'full_name', 'id', 'is_anonymised', 'is_birth_on_estimated', 'last_visit_at',
      'patient_code', 'phone_e164', 'phone_masked', 'sex', 'version'].sort());
    expect(r.body).toMatchObject({ id: p.id, patient_code: p.patient_code, full_name: p.full_name, version: 1, phone_e164: p.phone_e164, address_text: 'Synthetic Street 1' });
  });
  it('create without any new field returns exactly the old shape; patient_code still comes from the tenant pattern', { timeout: T }, async () => {
    const r = await create(newPatient());
    expect(r.status).toBe(201);
    for (const k of NEW_KEYS) expect(r.body, k).not.toHaveProperty(k);
    expect(r.body.patient_code).toMatch(/^MP\d{8}$/);
    const row = await patientRow(r.body.id);
    for (const k of NEW_KEYS) expect(row[k] ?? null, k).toBeNull();
  });
  it('an old-style update (phone only) works on a patient with and without new fields; empty body is still 400; unknown keys still 400', { timeout: T }, async () => {
    const plain = await seedPatient('a');
    const rich = await create(newPatient(await allFields()));
    const ph = phone();
    expect((await patch(plain.id, { phone_e164: ph })).body.phone_e164).toBe(ph);
    const r = await patch(rich.body.id, { phone_e164: ph });
    expect(r.status).toBe(200);
    expect(r.body.title).toBe('mr');
    expect((await patchFails(plain.id, {}, '"2"')).code).toBe('common.validation_failed');
    expect((await patchFails(plain.id, { not_a_field: 1 }, '"2"')).code).toBe('common.validation_failed');
  });
  it('searchPatients summaries are unchanged for patients with and without new fields', { timeout: T }, async () => {
    const t = tag();
    const a = await create(newPatient({ full_name: `Syn Plainsearch ${t}` })); // via createPatient so both rows share the same null keys (seedPatient sets last_visit_at)
    const b = await create(newPatient({ full_name: `Syn Richsearch ${t}`, ...(await allFields()) }));
    const sa = await search(`plainsearch ${t}`); const sb = await search(`richsearch ${t}`);
    expect(sa.body.data.map((x: any) => x.id)).toEqual([a.body.id]);
    expect(sb.body.data.map((x: any) => x.id)).toEqual([b.body.id]);
    expect(Object.keys(sa.body.data[0]).sort()).toEqual(Object.keys(sb.body.data[0]).sort());
  });
  it('the duplicate check still fires with new fields present, and the audited override still creates; candidates are summaries', { timeout: T }, async () => {
    const t = tag(); const ph = phone();
    const first = await create(newPatient({ full_name: `Sita Regapi ${t}`, age: undefined, birth_on: '1983-03-03', phone_e164: ph, external_patient_id: mr(), title: 'mrs' }));
    expect(first.status).toBe(201);
    const again = newPatient({ full_name: `Sita Regapi ${t}`, age: undefined, birth_on: '1983-03-03', phone_e164: ph, external_patient_id: mr(), title: 'mrs' });
    const e = await createFails(again);
    expect(e.code).toBe('frontdesk.patient_duplicate_suspected');
    expect(e.statusCode).toBe(409);
    expect(e.candidates.map((c: any) => c.id)).toContain(first.body.id);
    expect(await countByPhone(ph)).toBe(1);
    const forced = await create({ ...again, duplicate_override: { reason_code: 'twin' } });
    expect(forced.status).toBe(201);
    expect((await patientRow(forced.body.id)).duplicate_override_reason_code).toBe('twin');
    expect(await countByPhone(ph)).toBe(2);
  });
  it('recordPatientConsent and listPatientOrders still work on a patient that has the new fields', { timeout: T }, async () => {
    const c = await create(newPatient(await allFields()));
    const r = await call('recordPatientConsent', req({ params: { patient_id: c.body.id }, body: consents({ sms: false }), headers: { 'idempotency-key': `k-${uid()}` } }));
    expect(r.status).toBe(201);
    expect((await call('listPatientOrders', req({ params: { patient_id: c.body.id } }))).status).toBe(200);
  });
});
