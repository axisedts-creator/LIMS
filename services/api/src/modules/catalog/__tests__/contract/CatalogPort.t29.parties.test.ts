// T-29 (C3) — REAL CatalogPort.getReferrer / getCreditParty (CR-C3-001).
// Spec: 02-TRD §6.1 (interfaces + method rows `getReferrer`, `getCreditParty`), §14 contract cases (14) (15) (24); 01-PRD AC-11.3, AC-11.4, AC-12.2;
//       07-SECURITY AB-19 (contact / billing reads only for user|system actors; device/portal/patient/partner -> auth.forbidden), S-1 (tenant), S-6 (binds only), REQ-SEC (no PII in errors).
// Shapes: ReferrerProfile / CreditPartyProfile of contracts/ports/CatalogPort.ts (optional keys are OMITTED, never null/undefined-valued). Interface + seams: helpers/t29.ts.
// Assumptions beyond the spec (see .orchestra/notes/C3.T-29-tests.md): `code` = doctors.doctor_code / credit_parties.party_code; `priceListId` = the list in the party's
// price_list_assignments row (owner_kind credit_party) when that list is active; `display` from a non-staff actor is allowed (only notification/billing are forbidden).
import { describe, expect, it } from 'vitest';
import { cp } from '../helpers/creditPartiesDb.js';
import { ID } from '../helpers/mastersDb.js';
import { defaultList, doc, passign, plist, pver } from '../helpers/pricingDb.js';
import { NON_STAFF, STAFF, T, TENANT_A, TENANT_B, WRITE, asActor, codeOf, keysOf, refEnv, rejection } from '../helpers/t29.js';

const A = TENANT_A, B = TENANT_B;
const PHONE = '+9779800000101', EMAIL = 'suite-ref1@example.com', NOTE = 'private note: do not leak';
const DR1 = doc(1, A, { doctor_code: 'SDR1', display_name: 'Dr. Suite Referrer 1', qualification: 'MD General Practice', registration_council: 'NMC', registration_no: 'REG-1',
  is_verified: true, phone_e164: PHONE, email: EMAIL, notes: NOTE, source: 'quick_add' });
const DR_M = doc(2, A, { doctor_code: 'SDR1-DUP', display_name: 'Dr. Suite Referrer 1 (dup)', is_active: false, merged_into_id: DR1.id });
const DR_C1 = doc(3, A, { doctor_code: 'SCH1', is_active: false, merged_into_id: ID(0xd04) });      // defensive: a chain C1 -> C2 -> C3 (merges flatten chains, the impl still follows)
const DR_C2 = doc(4, A, { doctor_code: 'SCH2', is_active: false, merged_into_id: ID(0xd05) });
const DR_C3 = doc(5, A, { doctor_code: 'SCH3' });
const DR_BARE = doc(6, A, { doctor_code: 'SBARE', display_name: 'Dr. Suite Bare' });                // no qualification / registration / contact
const DR_OLD = doc(7, A, { doctor_code: 'SOLD', is_active: false, phone_e164: '+9779800000107' });  // deactivated, not merged
const DR_B = doc(9, B, { doctor_code: 'SDRB', display_name: 'Dr. Tenant B', phone_e164: '+9779800000999', email: 'b-secret@example.com' });

const CP_LIST = plist(1, A, { owner_kind: 'credit_party', code: 'CPLIST' });
const CP_VER = pver(1, A, CP_LIST.id as string, 1, { status: 'published' });
const CP1 = cp(1, A, { party_code: 'SCP1', name: 'Suite Hospital 1', kind: 'hospital', allows_credit: true, pan: '600000101', billing_address: 'Suite Ward 1, Synthetic Road',
  contact_phone_e164: '+9779800000201', contact_email: 'suite-cp1@example.com' });
const CP_NOCRED = cp(2, A, { party_code: 'SCP2', name: 'Suite Discount Clinic', kind: 'clinic', allows_credit: false });
const CP_OFF = cp(3, A, { party_code: 'SCP3', name: 'Suite Dormant Co', kind: 'company', is_active: false, pan: '600000103' });
const CP_BARE = cp(4, A, { party_code: 'SCP4', name: 'Suite Bare Partner', kind: 'partner_lab' });
const CP_B = cp(9, B, { party_code: 'SCPB', name: 'Tenant B Party', pan: '699999999', billing_address: 'B street', contact_email: 'b-cp@example.com' });

const world = () => refEnv({
  rows: {
    doctors: [DR1, DR_M, { ...DR_C1, merged_into_id: DR_C2.id }, { ...DR_C2, merged_into_id: DR_C3.id }, DR_C3, DR_BARE, DR_OLD, DR_B],
    price_lists: [CP_LIST, defaultList(2, A), plist(8, A, { owner_kind: 'credit_party', code: 'OFFLIST', is_active: false })],
    price_list_versions: [CP_VER],
    price_list_assignments: [passign(1, A, CP_LIST.id as string, 'credit_party', CP1.id as string)],
  },
  parties: [CP1, CP_NOCRED, CP_OFF, CP_BARE, CP_B],
});
const ref = (id: string, purpose: unknown = 'display') => ({ referrerId: id, purpose });
const party = (id: string, purpose: unknown = 'display') => ({ creditPartyId: id, purpose });

describe('getReferrer (contract 14, 15; AC-11.3, AC-11.4)', () => {
  it('shape (A): is a function on the real port', { timeout: T }, () => {
    expect(typeof world().port['getReferrer']).toBe('function');
    expect(typeof world().port['getCreditParty']).toBe('function');
  });
  it('(14) purpose display: full profile, NO contact (no phone, no email)', { timeout: T }, async () => {
    const r = await world().one('getReferrer', ref(DR1.id as string));
    expect(r).toEqual({ referrerId: DR1.id, canonicalReferrerId: DR1.id, code: 'SDR1', displayName: 'Dr. Suite Referrer 1', qualification: 'MD General Practice', registrationNo: 'REG-1', isVerified: true, isActive: true });
    expect(r.contact).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain(PHONE);
    expect(JSON.stringify(r)).not.toContain(EMAIL);
  });
  it('(14) purpose notification as a user: the contact fields are returned', { timeout: T }, async () => {
    const r = await world().one('getReferrer', ref(DR1.id as string, 'notification'));
    expect(r.contact).toEqual({ phoneE164: PHONE, email: EMAIL });
    expect(r).toMatchObject({ referrerId: DR1.id, code: 'SDR1', displayName: 'Dr. Suite Referrer 1' });
  });
  it.each(STAFF)('(14) notification is allowed for actor type %s', { timeout: T }, async (type) => {
    expect((await world().one('getReferrer', ref(DR1.id as string, 'notification'), asActor(type))).contact?.email).toBe(EMAIL);
  });
  it.each(NON_STAFF)('(14) AB-19 notification from a %s actor -> auth.forbidden, and the error carries no contact data', { timeout: T }, async (type) => {
    const e = await rejection(world().one('getReferrer', ref(DR1.id as string, 'notification'), asActor(type)));
    expect(e.code).toBe('auth.forbidden');
    expect(JSON.stringify({ code: e.code, message: e.message, errors: e.errors })).not.toMatch(/9779800000101|suite-ref1|private note/);
  });
  it.each(NON_STAFF)('display from a %s actor is allowed and still has no contact', { timeout: T }, async (type) => {
    const r = await world().one('getReferrer', ref(DR1.id as string, 'display'), asActor(type));
    expect(r.referrerId).toBe(DR1.id);
    expect(r.contact).toBeUndefined();
  });
  it('(15) AC-11.3 a merged doctor reports the canonical id (own id stays referrerId); inactive doctors are still readable', { timeout: T }, async () => {
    const r = await world().one('getReferrer', ref(DR_M.id as string));
    expect([r.referrerId, r.canonicalReferrerId, r.isActive, r.code]).toEqual([DR_M.id, DR1.id, false, 'SDR1-DUP']);
    const self = await world().one('getReferrer', ref(DR1.id as string));
    expect(self.canonicalReferrerId).toBe(self.referrerId);
    const old = await world().one('getReferrer', ref(DR_OLD.id as string));
    expect([old.isActive, old.canonicalReferrerId]).toEqual([false, DR_OLD.id]);
  });
  it('(15) a (defensive) merge chain is followed to its end', { timeout: T }, async () => {
    expect((await world().one('getReferrer', ref(DR_C1.id as string))).canonicalReferrerId).toBe(DR_C3.id);
    expect((await world().one('getReferrer', ref(DR_C2.id as string))).canonicalReferrerId).toBe(DR_C3.id);
  });
  it('(15) a merge cycle cannot hang the call: it answers or rejects with a LimsError', { timeout: T }, async () => {
    const a = doc(21, A, { doctor_code: 'CYA', is_active: false, merged_into_id: ID(0xd16) }), b = doc(22, A, { doctor_code: 'CYB', is_active: false, merged_into_id: ID(0xd15) });
    const env = refEnv({ rows: { doctors: [a, b] }, parties: [] });
    const out = await Promise.race([env.one('getReferrer', ref(a.id as string)).then(() => 'ok', (e: any) => (e?.code ? 'limserror' : 'crash')), new Promise((r) => setTimeout(() => r('hang'), 5_000))]);
    expect(['ok', 'limserror']).toContain(out);
  });
  it('optional keys are omitted when the doctor has no such data (no qualification / registrationNo / contact keys, no undefined values)', { timeout: T }, async () => {
    const r = await world().one('getReferrer', ref(DR_BARE.id as string));
    expect(r).toEqual({ referrerId: DR_BARE.id, canonicalReferrerId: DR_BARE.id, code: 'SBARE', displayName: 'Dr. Suite Bare', isVerified: false, isActive: true });
    const n = await world().one('getReferrer', ref(DR_BARE.id as string, 'notification'));
    expect(n.contact?.phoneE164).toBeUndefined();
    expect(n.contact?.email).toBeUndefined();
    expect(Object.values(n).every((v) => v !== undefined && v !== null)).toBe(true);
  });
  it('the result carries port keys only: no snake_case, no notes / source / verified_by / version / audit / name_normalised / merged_into_id', { timeout: T }, async () => {
    const r = await world().one('getReferrer', ref(DR1.id as string, 'notification'));
    const keys = keysOf(r);
    expect(keys.filter((k) => k.includes('_'))).toEqual([]);
    for (const k of ['notes', 'source', 'version', 'createdAt', 'createdBy', 'updatedAt', 'tenantId', 'nameNormalised', 'mergedIntoId', 'registrationCouncil', 'verifiedBy']) expect(keys, k).not.toContain(k);
    expect(JSON.stringify(r)).not.toContain(NOTE);
  });
  it('unknown id and ANOTHER tenant\'s doctor are indistinguishable: common.not_found (S-1); the owner reads it', { timeout: T }, async () => {
    const env = world();
    expect(await codeOf(env.one('getReferrer', ref(ID(0xdead))))).toBe('common.not_found');
    expect(await codeOf(env.one('getReferrer', ref(DR_B.id as string)))).toBe('common.not_found');
    expect(await codeOf(env.one('getReferrer', ref(DR_B.id as string, 'notification')))).toBe('common.not_found');
    expect((await env.one('getReferrer', ref(DR_B.id as string), { tenantId: B })).referrerId).toBe(DR_B.id);
    expect(await codeOf(env.one('getReferrer', ref(DR1.id as string), { tenantId: B }))).toBe('common.not_found');
  });
  it('bad input -> common.validation_failed (or not_found for a non-uuid): purpose outside the enum, missing purpose, non-uuid id, no input', { timeout: T }, async () => {
    const env = world();
    for (const bad of [ref(DR1.id as string, 'billing'), ref(DR1.id as string, 'DISPLAY'), ref(DR1.id as string, 5), { referrerId: DR1.id }, undefined, null]) {
      expect(await codeOf(env.one('getReferrer', bad)), JSON.stringify(bad)).toBe('common.validation_failed');
    }
    expect(['common.validation_failed', 'common.not_found']).toContain(await codeOf(env.one('getReferrer', ref('not-a-uuid'))));
    expect(['common.validation_failed', 'common.not_found']).toContain(await codeOf(env.one('getReferrer', ref("x' OR '1'='1"))));
  });
  it('read-only, tenant-scoped, parameterised (S-1, S-6): no write / lock statement, every doctors statement names tenant_id and binds the ids', { timeout: T }, async () => {
    const env = world();
    await env.one('getReferrer', ref(DR_M.id as string, 'notification'));
    const s = env.stmts.filter((x) => /catalog\.doctors\b/i.test(x.text));
    expect(s.length).toBeGreaterThan(0);
    expect(env.stmts.filter((x) => WRITE.test(x.text))).toEqual([]);
    for (const x of s) {
      expect(x.text, x.text).toMatch(/\btenant_id\b/i);
      expect(x.values).toContain(A);
      expect(x.text).not.toContain(String(DR_M.id));
      expect(x.text).not.toMatch(/\$\{|'\s*\+/);
    }
    expect(s.length).toBeLessThanOrEqual(11);                                                     // <= 1 + the 10-hop defensive chain walk
  });
  it('is deterministic: same input, same output; a purpose \'display\' call after a \'notification\' call still has no contact (nothing cached across purposes)', { timeout: T }, async () => {
    const env = world();
    const a = await env.one('getReferrer', ref(DR1.id as string, 'notification'));
    expect(await env.one('getReferrer', ref(DR1.id as string, 'notification'))).toEqual(a);
    expect((await env.one('getReferrer', ref(DR1.id as string, 'display'))).contact).toBeUndefined();
    const c = await env.one('getCreditParty', party(CP1.id as string, 'billing'));
    expect((await env.one('getCreditParty', party(CP1.id as string, 'display'))).pan).toBeUndefined();
    expect((await env.one('getCreditParty', party(CP1.id as string, 'billing'))).pan).toBe(c.pan);
  });
});

describe('getCreditParty (contract 24; AC-12.2)', () => {
  it('(24) purpose billing (user): pan + billingAddressText, NEVER contact', { timeout: T }, async () => {
    const r = await world().one('getCreditParty', party(CP1.id as string, 'billing'));
    expect([r.pan, r.billingAddressText]).toEqual(['600000101', 'Suite Ward 1, Synthetic Road']);
    expect(r.contact).toBeUndefined();
    expect(JSON.stringify(r)).not.toMatch(/9779800000201|suite-cp1@/);
    expect(r).toMatchObject({ creditPartyId: CP1.id, code: 'SCP1', name: 'Suite Hospital 1', kind: 'hospital', allowsCredit: true, isActive: true });
  });
  it('(24) purpose display: no pan, no billing address, no contact', { timeout: T }, async () => {
    const r = await world().one('getCreditParty', party(CP1.id as string, 'display'));
    expect([r.pan, r.billingAddressText, r.contact]).toEqual([undefined, undefined, undefined]);
    expect(Object.keys(r).sort()).toEqual(['allowsCredit', 'code', 'creditPartyId', 'isActive', 'kind', 'name', 'priceListId']);
  });
  it('purpose notification (user): contact {phoneE164, email}, no pan, no billing address', { timeout: T }, async () => {
    const r = await world().one('getCreditParty', party(CP1.id as string, 'notification'));
    expect(r.contact).toEqual({ phoneE164: '+9779800000201', email: 'suite-cp1@example.com' });
    expect([r.pan, r.billingAddressText]).toEqual([undefined, undefined]);
  });
  it.each(STAFF)('billing and notification are allowed for actor type %s', { timeout: T }, async (type) => {
    expect((await world().one('getCreditParty', party(CP1.id as string, 'billing'), asActor(type))).pan).toBe('600000101');
    expect((await world().one('getCreditParty', party(CP1.id as string, 'notification'), asActor(type))).contact?.email).toBe('suite-cp1@example.com');
  });
  it.each(NON_STAFF)('(24) AB-19 billing and notification from a %s actor -> auth.forbidden, no data in the error; display is allowed', { timeout: T }, async (type) => {
    const env = world();
    for (const purpose of ['billing', 'notification']) {
      const e = await rejection(env.one('getCreditParty', party(CP1.id as string, purpose), asActor(type)));
      expect(e.code, purpose).toBe('auth.forbidden');
      expect(JSON.stringify({ message: e.message, errors: e.errors })).not.toMatch(/600000101|Synthetic Road|suite-cp1|9779800000201/);
    }
    const d = await env.one('getCreditParty', party(CP1.id as string, 'display'), asActor(type));
    expect([d.creditPartyId, d.pan, d.contact]).toEqual([CP1.id, undefined, undefined]);
  });
  it('AC-12.2 allowsCredit:false is reported as is (C4 refuses credit billing); inactive parties are readable with isActive:false', { timeout: T }, async () => {
    const env = world();
    expect(await env.one('getCreditParty', party(CP_NOCRED.id as string))).toMatchObject({ allowsCredit: false, isActive: true, kind: 'clinic', code: 'SCP2' });
    expect(await env.one('getCreditParty', party(CP_OFF.id as string))).toMatchObject({ allowsCredit: true, isActive: false, kind: 'company' });
  });
  it('priceListId is the party\'s assigned active list; absent when none is assigned', { timeout: T }, async () => {
    const env = world();
    expect((await env.one('getCreditParty', party(CP1.id as string))).priceListId).toBe(CP_LIST.id);
    expect(await env.one('getCreditParty', party(CP_NOCRED.id as string))).not.toHaveProperty('priceListId');
  });
  it('optional keys are omitted, never null: a party without pan / address / contact data', { timeout: T }, async () => {
    const env = world();
    const b = await env.one('getCreditParty', party(CP_BARE.id as string, 'billing'));
    expect(b).not.toHaveProperty('pan');
    expect(b).not.toHaveProperty('billingAddressText');
    expect(Object.values(b).every((v) => v !== undefined && v !== null)).toBe(true);
    const n = await env.one('getCreditParty', party(CP_BARE.id as string, 'notification'));
    expect(n.contact?.email).toBeUndefined();
    expect(n.contact?.phoneE164).toBeUndefined();
  });
  it('port keys only: no snake_case, no tenant / audit / version internals', { timeout: T }, async () => {
    const r = await world().one('getCreditParty', party(CP1.id as string, 'billing'));
    expect(keysOf(r).filter((k) => k.includes('_'))).toEqual([]);
    for (const k of ['tenantId', 'version', 'createdAt', 'createdBy', 'updatedAt', 'partyCode', 'billingAddress']) expect(keysOf(r), k).not.toContain(k);
  });
  it('unknown id and another tenant\'s party -> common.not_found for every purpose (S-1); the owner reads it', { timeout: T }, async () => {
    const env = world();
    for (const purpose of ['display', 'billing', 'notification']) {
      expect(await codeOf(env.one('getCreditParty', party(ID(0xdead), purpose))), purpose).toBe('common.not_found');
      expect(await codeOf(env.one('getCreditParty', party(CP_B.id as string, purpose))), purpose).toBe('common.not_found');
    }
    expect((await env.one('getCreditParty', party(CP_B.id as string, 'billing'), { tenantId: B })).pan).toBe('699999999');
    expect(await codeOf(env.one('getCreditParty', party(CP1.id as string), { tenantId: B }))).toBe('common.not_found');
  });
  it('bad input -> common.validation_failed: unknown purpose, missing purpose, missing id, no input', { timeout: T }, async () => {
    const env = world();
    for (const bad of [party(CP1.id as string, 'credit'), { creditPartyId: CP1.id }, { purpose: 'display' }, undefined, null]) {
      expect(await codeOf(env.one('getCreditParty', bad)), JSON.stringify(bad)).toBe('common.validation_failed');
    }
    expect(['common.validation_failed', 'common.not_found']).toContain(await codeOf(env.one('getCreditParty', party("x'; DROP TABLE catalog.credit_parties;--"))));
  });
  it('read-only, tenant-scoped, parameterised (S-1, S-6)', { timeout: T }, async () => {
    const env = world();
    await env.one('getCreditParty', party(CP1.id as string, 'billing'));
    const s = env.stmts.filter((x) => /catalog\.(credit_parties|price_list_assignments|price_lists)\b/i.test(x.text));
    expect(s.length).toBeGreaterThan(0);
    expect(env.stmts.filter((x) => WRITE.test(x.text))).toEqual([]);
    for (const x of s) { expect(x.text, x.text).toMatch(/\btenant_id\b/i); expect(x.values).toContain(A); expect(x.text).not.toContain(String(CP1.id)); }
  });
});
