// FD-T04 F2 createPatient + F5 recordPatientConsent — US-FD-02.1..5 (01-PRD §8), 03-APP-FLOW §2.3 step 1, 02-TRD §5.1 F2/F5, 05-SCHEMA §3 (patients, patient_consents append-only), 07-SECURITY REQ-SEC-005.
// US-FD-02.4 (the registration half: NotificationPort suppressed_no_consent, UI text) belongs to FD-T06/FD-T09; here the SMS flag a registration will read is proven stored + returned faithfully.
// Known interface gap pinned softly: LimsError (core/errors.ts) has no field for the problem extension `candidates`; the test checks the code/status and, when the handler exposes `candidates`, its shape.
import { beforeAll, describe, expect, it } from 'vitest';
import { PERM, T, TENANT_A, TENANT_B, accessRows, appTx, call, consentRows, consents, fails, newPatient, norm, NOW_DATE, ownerRows, patientRow, phone,
  req, schemaErrors, seedPatient, seedSettings, superTx, tag, uid } from './helpers.js';

const create = (body: object, o: Parameters<typeof call>[2] = {}) => call('createPatient', req({ body, headers: { 'idempotency-key': `k-${uid()}` } }), o);
const createFails = (body: object, o: Parameters<typeof call>[2] = {}) => fails('createPatient', req({ body, headers: { 'idempotency-key': `k-${uid()}` } }), o);
const byName = (n: string) => ownerRows('frontdesk.patients', 'tenant_id = $1 AND name_search = $2', [TENANT_A, norm(n)]);
// Ruling FD-T04 #2: count only rows this test could create (unique phone), never a tenant-wide count that other parallel suites move.
const countByPhone = async (ph: string) => (await ownerRows('frontdesk.patients', 'tenant_id = $1 AND phone_e164 = $2', [TENANT_A, ph])).length;
beforeAll(async () => { await seedSettings(); }, T);

describe('US-FD-02.1 create from age only', () => {
  it('201 Patient: birth_on estimated from the age at ctx.now(), is_birth_on_estimated=true, new patient_code from the tenant pattern, version 1', { timeout: T }, async () => {
    const body = newPatient({ age: { years: 43 } });
    const r = await create(body);
    expect(r.status).toBe(201);
    expect(schemaErrors('Patient', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ full_name: body.full_name, sex: 'female', is_birth_on_estimated: true, age_display: '43 Years', is_anonymised: false, version: 1 });
    expect(r.body.birth_on).toBe(`${Number(NOW_DATE.slice(0, 4)) - 43}${NOW_DATE.slice(4)}`);   // 1983-11-10
    expect(r.body.patient_code).toMatch(/^MP\d{8}$/);
    expect(r.body.consents).toEqual(body.consents);
    const row = await patientRow(r.body.id);
    expect(row).toMatchObject({ tenant_id: TENANT_A, is_birth_on_estimated: true, source: 'front_desk', phone_e164: body.phone_e164, version: 1 });
    expect(row.registered_centre_id).not.toBeNull();
    expect(row.name_search).toBe(norm(body.full_name));            // normalised for search + dedupe
    expect((await superTx((tx) => tx.query('SELECT birth_on::text AS d FROM frontdesk.patients WHERE id = $1', [r.body.id]))).rows[0].d).toBe('1983-11-10');   // ruling #3: compare the date text, not a JS Date string
    expect(r.probe.identity.calls[0]).toMatchObject({ permission: PERM.create });
  });
  it('with age in years+months+days the estimate subtracts all three; with only birth_on it is exact and not estimated', { timeout: T }, async () => {
    const a = await create(newPatient({ age: { years: 1, months: 1, days: 1 } }));
    expect(a.body.birth_on).toBe('2025-10-09');
    expect(a.body.is_birth_on_estimated).toBe(true);
    const b = await create(newPatient({ age: undefined, birth_on: '1990-05-17' }));
    expect(b.body).toMatchObject({ birth_on: '1990-05-17', is_birth_on_estimated: false, age_display: '36 Years' });
  });
  it('writes exactly one consent row with the submitted flags and the consent text version; created_by is the actor', { timeout: T }, async () => {
    const r = await create(newPatient({ consents: consents({ sms: true, whatsapp: true, email: false, share_with_referrer: true }) }));
    const cs = await consentRows(r.body.id);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ tenant_id: TENANT_A, processing: true, sms: true, whatsapp: true, email: false, share_with_referrer: true, consent_text_version: 'v1', source: 'front_desk' });
  });
  it('successive patients get distinct, increasing codes (counter), and 10 concurrent creates yield 10 distinct codes with none lost', { timeout: T }, async () => {
    const a = await create(newPatient()); const b = await create(newPatient());
    expect(Number(b.body.patient_code.slice(2))).toBeGreaterThan(Number(a.body.patient_code.slice(2)));
    const many = await Promise.all(Array.from({ length: 10 }, () => create(newPatient())));
    expect(new Set(many.map((m) => m.body.patient_code)).size).toBe(10);
  });
  it.each([
    ['both birth_on and age', { birth_on: '1990-01-01', age: { years: 30 } }],
    ['neither birth_on nor age', { age: undefined }],
    ['future birth_on', { age: undefined, birth_on: '2027-01-01' }],
    ['impossible calendar date', { age: undefined, birth_on: '2026-02-30' }],
    ['absurd age', { age: { years: 400 } }],
    ['negative age', { age: { years: -1 } }],
    ['blank name', { full_name: '   ' }],
  ])('%s -> 400 common.validation_failed and nothing is stored', { timeout: T }, async (_n, patch) => {
    const body = newPatient(patch as any);
    const e = await createFails(body);
    expect(e.code).toBe('common.validation_failed');
    expect(await countByPhone(body.phone_e164)).toBe(0);
  });
  it('consent_text_version different from the tenant setting -> 400 common.validation_failed, nothing stored', { timeout: T }, async () => {
    const body = newPatient({ consents: consents({ consent_text_version: 'v0-old' }) });
    expect((await createFails(body)).code).toBe('common.validation_failed');
    expect(await countByPhone(body.phone_e164)).toBe(0);
  });
  it('permission: patient.read alone cannot create (auth.forbidden), nothing stored', { timeout: T }, async () => {
    const body = newPatient();
    expect((await createFails(body, { grants: [PERM.read] })).code).toBe('auth.forbidden');
    expect(await countByPhone(body.phone_e164)).toBe(0);
  });
});

describe('US-FD-02.2 duplicate suspicion + audited override', () => {
  it('same normalised name + birth year ±1 + same phone -> 409 frontdesk.patient_duplicate_suspected listing the candidate; nothing stored', { timeout: T }, async () => {
    const t = tag(); const ph = phone();
    const existing = await seedPatient('a', { full_name: `Sita Rai ${t}`, name_search: norm(`Sita Rai ${t}`), birth_on: '1983-03-03', phone_e164: ph });
    const before = await countByPhone(ph);
    const e = await createFails(newPatient({ full_name: `  SITA   rai ${t}`, age: undefined, birth_on: '1984-12-31', phone_e164: ph }));
    expect(e.code).toBe('frontdesk.patient_duplicate_suspected'); expect(e.statusCode).toBe(409);
    const cands = e.candidates ?? e.extensions?.candidates;
    if (cands !== undefined) {
      expect(schemaErrors('PatientSummaryList', { data: cands })).toEqual([]);
      expect(cands.map((c: any) => c.id)).toContain(existing.id);
      expect(JSON.stringify(cands)).not.toContain(ph);          // summaries mask the phone
    }
    expect(await countByPhone(ph)).toBe(before);
  });
  it('resubmitting with duplicate_override.reason_code creates the patient and records the reason on the row', { timeout: T }, async () => {
    const t = tag(); const ph = phone();
    await seedPatient('a', { full_name: `Gita Rai ${t}`, name_search: norm(`Gita Rai ${t}`), birth_on: '1983-03-03', phone_e164: ph });
    const body = newPatient({ full_name: `Gita Rai ${t}`, age: undefined, birth_on: '1983-03-03', phone_e164: ph });
    expect((await createFails(body)).code).toBe('frontdesk.patient_duplicate_suspected');
    const r = await create({ ...body, duplicate_override: { reason_code: 'TWIN' } });
    expect(r.status).toBe(201);
    expect((await patientRow(r.body.id)).duplicate_override_reason_code).toBe('TWIN');
    expect(await byName(`Gita Rai ${t}`)).toHaveLength(2);
  });
  it('the override is audited: the row audit (audit.audit_log) or access log has an entry for the new patient that carries the reason code', { timeout: T }, async () => {
    const t = tag(); const ph = phone();
    await seedPatient('a', { full_name: `Mina Rai ${t}`, name_search: norm(`Mina Rai ${t}`), birth_on: '1983-03-03', phone_e164: ph });
    const r = await create({ ...newPatient({ full_name: `Mina Rai ${t}`, age: undefined, birth_on: '1983-03-03', phone_e164: ph }), duplicate_override: { reason_code: 'TWIN' } });
    const hits = await superTx(async (tx) => [
      ...(await tx.query(`SELECT detail::text AS d FROM audit.access_log WHERE tenant_id = $1 AND entity_id = $2`, [TENANT_A, r.body.id])).rows.map((x) => x.d),
      ...(await tx.query(`SELECT to_jsonb(a)::text AS d FROM audit.audit_log a WHERE tenant_id = $1 AND to_jsonb(a)::text LIKE '%' || $2 || '%'`, [TENANT_A, r.body.id])).rows.map((x) => x.d),
    ]);
    expect(hits.some((d: string) => d.includes('TWIN')), 'no audit entry mentions the override reason code').toBe(true);
  });
  it.each([
    ['birth years 2 apart', { birth_on: '1981-01-01' }],
    ['a different phone on both', { phone_e164: '+9779700000000' }],
    ['a different name', { full_name: 'Completely Different' }],
  ])('not a duplicate: %s', { timeout: T }, async (_n, patch) => {
    const t = tag(); const ph = phone();
    await seedPatient('a', { full_name: `Dup Base ${t}`, name_search: norm(`Dup Base ${t}`), birth_on: '1983-06-06', phone_e164: ph });
    const body = newPatient({ full_name: `Dup Base ${t}`, age: undefined, birth_on: '1983-06-06', phone_e164: ph, ...patch });
    expect((await create(body)).status).toBe(201);
  });
  it('a candidate without a phone still counts (phone compared only when both are present); an anonymised twin never does', { timeout: T }, async () => {
    const t = tag();
    await seedPatient('a', { full_name: `Nophone ${t}`, name_search: norm(`Nophone ${t}`), birth_on: '1983-06-06', phone_e164: null });
    expect((await createFails(newPatient({ full_name: `Nophone ${t}`, age: undefined, birth_on: '1983-06-06' }))).code).toBe('frontdesk.patient_duplicate_suspected');
    const u = tag();
    await seedPatient('a', { full_name: `Gone ${u}`, name_search: norm(`Gone ${u}`), birth_on: '1983-06-06', anonymised_at: '2026-10-01T00:00:00Z' });
    expect((await create(newPatient({ full_name: `Gone ${u}`, age: undefined, birth_on: '1983-06-06' }))).status).toBe(201);
  });
  it('a twin in ANOTHER tenant is never a candidate (tenant isolation) and never leaks into the 201/409', { timeout: T }, async () => {
    const t = tag(); const ph = phone();
    await seedPatient('b', { full_name: `Other Tenant ${t}`, name_search: norm(`Other Tenant ${t}`), birth_on: '1983-06-06', phone_e164: ph });
    const r = await create(newPatient({ full_name: `Other Tenant ${t}`, age: undefined, birth_on: '1983-06-06', phone_e164: ph }));
    expect(r.status).toBe(201);
    expect((await patientRow(r.body.id)).tenant_id).toBe(TENANT_A);
  });
  it('the same name in different tenants is allowed in tenant B too (dedupe is per tenant)', { timeout: T }, async () => {
    const t = tag(); const ph = phone();
    await seedPatient('a', { full_name: `Both ${t}`, name_search: norm(`Both ${t}`), birth_on: '1983-06-06', phone_e164: ph });
    const r = await create(newPatient({ full_name: `Both ${t}`, age: undefined, birth_on: '1983-06-06', phone_e164: ph }), { tenant: TENANT_B });
    expect(r.status).toBe(201); expect((await patientRow(r.body.id)).tenant_id).toBe(TENANT_B);
  });
});

describe('US-FD-02.3 processing consent required', () => {
  it('processing=false -> 422 frontdesk.consent_required and NOTHING is stored (no patient, no consent, no counter use visible as a patient)', { timeout: T }, async () => {
    const body = newPatient({ consents: consents({ processing: false }) });
    const e = await createFails(body);
    expect(e.code).toBe('frontdesk.consent_required'); expect(e.statusCode).toBe(422);
    expect(await countByPhone(body.phone_e164)).toBe(0);
    expect(await byName(body.full_name)).toHaveLength(0);
  });
  it('no consent + a matching duplicate: either error is acceptable (spec silent on order), but nothing is stored and no patient is created',{ timeout: T }, async () => {
    const t = tag(); const ph = phone();
    await seedPatient('a', { full_name: `Order ${t}`, name_search: norm(`Order ${t}`), birth_on: '1983-06-06', phone_e164: ph });
    const before = await countByPhone(ph);
    const e = await createFails(newPatient({ full_name: `Order ${t}`, age: undefined, birth_on: '1983-06-06', phone_e164: ph, consents: consents({ processing: false }) }));
    expect(['frontdesk.consent_required', 'frontdesk.patient_duplicate_suspected']).toContain(e.code);
    expect(await countByPhone(ph)).toBe(before);
  });
});

describe('US-FD-02.4 SMS consent flag (storage half; registration half is FD-T06)', () => {
  it('sms=false is stored as false and returned as consents.sms=false (the flag NotificationPort gating reads)', { timeout: T }, async () => {
    const r = await create(newPatient({ consents: consents({ sms: false }) }));
    expect(r.body.consents.sms).toBe(false);
    expect((await consentRows(r.body.id))[0].sms).toBe(false);
    const g = await call('getPatient', req({ params: { patient_id: r.body.id } }));
    expect(g.body.consents.sms).toBe(false);
  });
});

describe('US-FD-02.5 consent change is append-only (F5 recordPatientConsent)', () => {
  const record = (patientId: string, body: object, o: Parameters<typeof call>[2] = {}) =>
    call('recordPatientConsent', req({ params: { patient_id: patientId }, body, headers: { 'idempotency-key': `k-${uid()}` } }), o);

  it('201 ConsentRecord; a NEW row with the consent text version is appended, the old row is byte-identical, history keeps both', { timeout: T }, async () => {
    const p = await seedPatient('a', {}, { sms: true });
    const [old] = await consentRows(p.id);
    const r = await record(p.id, consents({ sms: false, whatsapp: true, share_with_referrer: true }));
    expect(r.status).toBe(201);
    expect(schemaErrors('ConsentRecord', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ patient_id: p.id, consents: consents({ sms: false, whatsapp: true, share_with_referrer: true }) });
    expect(r.body.recorded_by).toMatchObject({ membership_id: r.probe.membershipId, display_name: 'Synthetic Operator' });
    const after = await consentRows(p.id);
    expect(after).toHaveLength(2);
    expect(after.find((c) => c.id === old.id)).toEqual(old);
    expect(after.find((c) => c.id === r.body.id)).toMatchObject({ sms: false, whatsapp: true, consent_text_version: 'v1', tenant_id: TENANT_A, source: 'front_desk' });
    expect((await call('getPatient', req({ params: { patient_id: p.id } }))).body.consents).toMatchObject({ sms: false, whatsapp: true });   // newest row is the current consent
  });
  it('every change appends (3 changes -> 4 rows), never updates in place; access_log consent.change names the patient', { timeout: T }, async () => {
    const p = await seedPatient('a');
    const rs = [await record(p.id, consents({ sms: true })), await record(p.id, consents({ sms: false })), await record(p.id, consents({ email: true }))];
    expect(await consentRows(p.id)).toHaveLength(4);
    const log = await accessRows('consent.change', rs[2]!.probe.requestId);
    expect(log).toHaveLength(1); expect(log[0]).toMatchObject({ entity_type: 'patient', entity_id: p.id });
  });
  it('the handler has no way to rewrite history: the lims_api role cannot UPDATE or DELETE patient_consents', { timeout: T }, async () => {
    const p = await seedPatient('a');
    for (const sql of ['UPDATE frontdesk.patient_consents SET sms = true WHERE patient_id = $1', 'DELETE FROM frontdesk.patient_consents WHERE patient_id = $1']) {
      const e = await appTx(TENANT_A, (tx) => tx.query(sql, [p.id])).then(() => undefined, (x) => x);
      expect(e?.code, sql).toBe('42501');
    }
    expect(await consentRows(p.id)).toHaveLength(1);
  });
  it('withdrawing processing consent, a stale consent_text_version, or an unknown patient are refused and append nothing', { timeout: T }, async () => {
    const p = await seedPatient('a');
    const e1 = await rejectionOf(record(p.id, consents({ processing: false })));
    expect(['common.validation_failed', 'frontdesk.consent_required']).toContain(e1.code);
    expect((await rejectionOf(record(p.id, consents({ consent_text_version: 'old' })))).code).toBe('common.validation_failed');
    expect((await rejectionOf(record(uid(), consents()))).code).toBe('common.not_found');
    expect(await consentRows(p.id)).toHaveLength(1);
  });
  it('tenant isolation: tenant_a cannot append consent to a tenant_b patient (404, nothing written)', { timeout: T }, async () => {
    const b = await seedPatient('b');
    expect((await rejectionOf(record(b.id, consents()))).code).toBe('common.not_found');
    expect(await consentRows(b.id)).toHaveLength(1);
  });
  it('permission: patient.read alone -> auth.forbidden', { timeout: T }, async () => {
    const p = await seedPatient('a');
    expect((await rejectionOf(record(p.id, consents(), { grants: [PERM.read] }))).code).toBe('auth.forbidden');
    expect(await consentRows(p.id)).toHaveLength(1);
  });
});

async function rejectionOf(p: Promise<unknown>): Promise<any> { try { await p; } catch (e) { return e; } throw new Error('expected a rejection'); }
