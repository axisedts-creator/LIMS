// FD-T15 F7 anonymisePatient. PRD US-FD-16.1 / 16.2, 03-APP-FLOW §2.18, 02-TRD §5 F7 + access-log table, 08 A13 D-27 (a) excluded audit columns / (b) TRF object deletion, P-12 c,
// 07-SECURITY REQ-SEC-139 + §6.4 (privileged: no permission -> auth.forbidden, aal1 -> auth.mfa_required), CR-C4-007 (frontdesk.retention_not_elapsed 409), 02-CV §4.2 (If-Match).
// Reading of the retention rule (AF §2.18): the LAST order's `registered_at + retentionYears < ctx.now()`; `retentionYears` from IdentityPort.getTenantSettings, default 5 (PRD B15);
// equality is NOT enough. Orders in the happy path are `cancelled` (never "open", so no LabPort is needed); an open (pre_registered) order blocks with 409 frontdesk.order_not_editable.
// Fails now: stub (common.service_unavailable). Audit-row tests run against the REAL audit.audit_log + patients audit trigger of the migration.
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN, ADMIN_B, DESK, P, T, TENANT_B, accessRows, anonymisable, anonymise, anonymiseFails, as, auditRowsContaining, consentsOf, op, ordersOf, ownerRows, patientRow, req,
  schemaErrors, seedOrder, seedPatient, seedSettings, trfsOfPatient, uid, yearsAgo, tag, phone, type Anonymisable,
} from './helpers.js';

const DAY = 86_400_000;
const DEMOGRAPHIC_COLUMNS = ['full_name', 'name_search', 'birth_on', 'phone_e164', 'email', 'address_text'];
beforeAll(async () => { await seedSettings(); }, T);

/** Nothing happened: row, consents, TRFs, objects, access log. */
async function expectUntouched(a: Anonymisable, requestId?: string) {
  const row = await patientRow(a.patient.id);
  expect(row).toMatchObject({ full_name: a.sent.name, phone_e164: a.sent.phone, email: a.sent.email, address_text: a.sent.address, anonymised_at: null, version: 1 });
  expect(await consentsOf(a.patient.id)).toHaveLength(1);
  for (const t of await trfsOfPatient(a.patient.id)) { expect(t.is_active).toBe(true); expect(a.w.storage.has(t.object_path)).toBe(true); }
  expect(a.w.storage.callsOf('delete')).toEqual([]);
  if (requestId) expect(await accessRows('patient.anonymise', requestId)).toEqual([]);
}

describe('US-FD-16.1 anonymise after the retention period', () => {
  it('replaces the demographics, resets consents, keeps order ids, deletes the TRF objects (rows kept, is_active=false), logs patient.anonymise', { timeout: T }, async () => {
    const a = await anonymisable({ orderAt: [yearsAgo(7), yearsAgo(6)], trfPerOrder: 2 });
    const ordersBefore = await ordersOf(a.patient.id);
    const consentsBefore = await consentsOf(a.patient.id);
    const trfBefore = await trfsOfPatient(a.patient.id); expect(trfBefore).toHaveLength(4);
    const r = await anonymise(a.patient.id, '"1"', { reason_code: 'patient_request', reason_text: 'Synthetic request letter' }, ADMIN, { w: a.w });
    expect(r.status).toBe(200);

    // response: Patient (anonymised)
    expect(schemaErrors('Patient', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: a.patient.id, patient_code: a.patient.patient_code, is_anonymised: true, version: 2, consents: { processing: false, sms: false, whatsapp: false, email: false, share_with_referrer: false } });
    for (const k of ['phone_e164', 'email', 'address_text', 'birth_on']) expect(r.body, k).not.toHaveProperty(k);
    const wireText = JSON.stringify(r.body);
    for (const v of Object.values(a.sent)) expect(wireText).not.toContain(v);

    // row
    const row = await patientRow(a.patient.id);
    for (const c of DEMOGRAPHIC_COLUMNS) expect(row[c], c).toBeNull();
    expect(row).toMatchObject({ anonymise_reason_code: 'patient_request', version: 2, patient_code: a.patient.patient_code, is_active: true });
    expect(row.anonymised_at).toBeInstanceOf(Date); expect(row.anonymised_by).toBeTruthy();

    // consents: append-only, one new all-false row with source 'anonymisation'; the history is untouched
    const consentsAfter = await consentsOf(a.patient.id);
    expect(consentsAfter).toHaveLength(consentsBefore.length + 1);
    expect(consentsAfter.slice(0, consentsBefore.length).map((c) => c.id)).toEqual(consentsBefore.map((c) => c.id));
    expect(consentsBefore[0]).toMatchObject({ sms: true, whatsapp: true, email: true, share_with_referrer: true });   // ...still the old, true values (append-only)
    expect(consentsAfter.at(-1)).toMatchObject({ processing: false, sms: false, whatsapp: false, email: false, share_with_referrer: false, source: 'anonymisation' });

    // orders keep their ids and links
    expect((await ordersOf(a.patient.id)).map((o) => [o.id, o.patient_id, o.registration_no])).toEqual(ordersBefore.map((o) => [o.id, o.patient_id, o.registration_no]));

    // TRF: objects deleted (P-12 c / D-27 b), metadata rows kept inactive; the control patient's TRF is untouched
    const trfAfter = await trfsOfPatient(a.patient.id);
    expect(trfAfter.map((t) => t.id)).toEqual(trfBefore.map((t) => t.id));
    for (const t of trfAfter) { expect(t.is_active, t.id).toBe(false); expect(a.w.storage.has(t.object_path), t.object_path).toBe(false); }
    expect(a.w.storage.callsOf('delete').map((c) => c.path).sort()).toEqual(trfBefore.map((t) => t.object_path).sort());
    expect(a.w.storage.callsOf('delete').every((c) => c.bucket === 'frontdesk-trf')).toBe(true);
    const ct = (await ownerRows('frontdesk.trf_attachments', 'id = $1', [a.control.trf.id]))[0];
    expect(ct.is_active).toBe(true); expect(a.w.storage.has(a.control.trf.object_path)).toBe(true);
    expect(await patientRow(a.control.patient.id)).toMatchObject({ anonymised_at: null, version: 1 });
  });

  it('access_log: exactly one patient.anonymise row (entity patient, allowed) whose detail.changed_fields lists column NAMES only', { timeout: T }, async () => {
    const a = await anonymisable();
    const r = await anonymise(a.patient.id, '"1"', { reason_code: 'patient_request', reason_text: `Synthetic ${a.sent.name}` }, ADMIN, { w: a.w });
    expect(r.status).toBe(200);
    const log = await accessRows('patient.anonymise', r.probe.requestId);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ entity_type: 'patient', entity_id: a.patient.id, outcome: 'allowed' });
    expect(typeof log[0].detail.changed_fields).toBe('string');
    const fields = new Set(String(log[0].detail.changed_fields).split(','));
    for (const c of DEMOGRAPHIC_COLUMNS) expect(fields.has(c), c).toBe(true);
    const dump = JSON.stringify(log[0]) + JSON.stringify(r.probe.accessCalls) + r.probe.logs.join('\n');
    for (const v of Object.values(a.sent)) expect(dump).not.toContain(v);   // values never reach the access log or the application log
    expect(dump).not.toContain('Synthetic request');
  });

  it('afterwards getPatient reports an anonymised patient with no demographics and search no longer finds it by name or phone', { timeout: T }, async () => {
    const a = await anonymisable();
    expect((await anonymise(a.patient.id, '"1"', undefined, ADMIN, { w: a.w })).status).toBe(200);
    const g = await op('getPatient', req({ params: { patient_id: a.patient.id } }), ADMIN);
    expect(g.body).toMatchObject({ is_anonymised: true, full_name: '' });
    for (const k of ['phone_e164', 'email', 'address_text', 'birth_on']) expect(g.body, k).not.toHaveProperty(k);
    for (const q of [a.sent.name.slice(0, 14), a.sent.phone]) {
      const s = await op('searchPatients', req({ body: { query: q } }), ADMIN);
      expect((s.body.data as any[]).map((p) => p.id), q).not.toContain(a.patient.id);
    }
  });
});

describe('audit.audit_log holds no demographic value of the patient, before or after (D-27 a, REQ-SEC-139)', () => {
  const SIX = DEMOGRAPHIC_COLUMNS;
  const keysOf = (x: any) => Object.keys(x ?? {});
  it('before: the INSERT audit row of the seeded patient and the tenant-wide text scan contain none of the values', { timeout: T }, async () => {
    const a = await anonymisable();
    for (const v of Object.values(a.sent)) expect(await auditRowsContaining(v), v).toEqual([]);
    const rows = await ownerRows('audit.audit_log', `table_name = 'patients' AND row_id = $1`, [a.patient.id]);
    for (const r of rows) for (const c of SIX) { expect(keysOf(r.new_values), c).not.toContain(c); expect(keysOf(r.old_values), c).not.toContain(c); }
  });
  it('after F7: still none (not even as old_values of the UPDATE), and the UPDATE itself IS audited without the excluded columns', { timeout: T }, async () => {
    const a = await anonymisable();
    expect((await anonymise(a.patient.id, '"1"', undefined, ADMIN, { w: a.w })).status).toBe(200);
    for (const v of Object.values(a.sent)) expect(await auditRowsContaining(v), v).toEqual([]);
    const rows = await ownerRows('audit.audit_log', `table_name = 'patients' AND row_id = $1 AND action = 'UPDATE'`, [a.patient.id]);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const r of rows) { for (const c of SIX) { expect(keysOf(r.new_values), c).not.toContain(c); expect(keysOf(r.old_values), c).not.toContain(c); expect(r.changed_columns, c).not.toContain(c); } }
  });
  it('F4 updatePatient path (the other half of the compensating control): patient.update with changed_fields, and audit_log gets neither the old nor the new value', { timeout: T }, async () => {
    const a = await anonymisable();
    const newName = `Zrenamed ${tag()} Sentinel`; const newPhone = phone();
    const r = await op('updatePatient', req({ params: { patient_id: a.patient.id }, headers: { 'if-match': '"1"' }, body: { full_name: newName, phone_e164: newPhone } }), ADMIN, { w: a.w });
    expect(r.status).toBe(200);
    const log = await accessRows('patient.update', r.probe.requestId);
    expect(log).toHaveLength(1);
    expect(new Set(String(log[0].detail.changed_fields).split(','))).toEqual(new Set(['full_name', 'phone_e164']));
    for (const v of [a.sent.name, a.sent.phone, newName, newPhone]) { expect(JSON.stringify(log[0])).not.toContain(v); expect(await auditRowsContaining(v), v).toEqual([]); }
  });
});

describe('US-FD-16.2 retention rule', () => {
  const cases: Array<[string, number | undefined, number, number, number]> = [
    // [name, tenant retentionYears (undefined = not configured -> default 5), order age in years, shift ms, expected status]
    ['default 5 y: a day inside the window', undefined, 5, +DAY, 409],
    ['default 5 y: exactly 5 y is NOT elapsed (registered_at + 5 y = now, not < now)', undefined, 5, 0, 409],
    ['default 5 y: one second past 5 y is elapsed', undefined, 5, -1000, 200],
    ['default 5 y: a year past', undefined, 6, 0, 200],
    ['tenant retentionYears 10: 6 y old is not enough', 10, 6, 0, 409],
    ['tenant retentionYears 10: one second past 10 y', 10, 10, -1000, 200],
  ];
  it.each(cases)('%s', { timeout: T }, async (_n, years, age, shift, status) => {
    const a = await anonymisable({ orderAt: [yearsAgo(age, shift)] });
    const who = years === undefined ? ADMIN : as(ADMIN, { retentionYears: years });
    if (status === 200) { expect((await anonymise(a.patient.id, '"1"', undefined, who, { w: a.w })).status).toBe(200); return; }
    const requestId = uid();
    const e = await anonymiseFails(a.patient.id, '"1"', undefined, who, { w: a.w, requestId });
    expect(e.code).toBe('frontdesk.retention_not_elapsed'); expect(e.statusCode).toBe(409);
    await expectUntouched(a, requestId);
  });

  it('the LAST order counts: an old order plus a recent one blocks; nothing changes', { timeout: T }, async () => {
    const a = await anonymisable({ orderAt: [yearsAgo(9), yearsAgo(1)] });
    const e = await anonymiseFails(a.patient.id, '"1"', undefined, ADMIN, { w: a.w });
    expect(e.code).toBe('frontdesk.retention_not_elapsed');
    await expectUntouched(a);
  });

  it('an open (pre_registered) order blocks with 409 frontdesk.order_not_editable (AF §2.18) even when every other order is old; nothing changes', { timeout: T }, async () => {
    const a = await anonymisable({ orderAt: [yearsAgo(8)] });
    await seedOrder('a', a.patient.id, { status: 'pre_registered', registered_at: null, source: 'engagement_booking', source_ref_id: uid(), created_at: yearsAgo(8) });
    const e = await anonymiseFails(a.patient.id, '"1"', undefined, ADMIN, { w: a.w });
    expect(e.code).toBe('frontdesk.order_not_editable'); expect(e.statusCode).toBe(409);
    await expectUntouched(a);
  });
});

describe('privileged: frontdesk.patient.anonymise at aal2 (REQ-SEC-062/067, 07-SECURITY §6.4)', () => {
  it('aal1 -> 403 auth.mfa_required; no permission / front desk -> 403 auth.forbidden; nothing changes; the permission is asserted through IdentityPort', { timeout: T }, async () => {
    const a = await anonymisable();
    const e1 = await anonymiseFails(a.patient.id, '"1"', undefined, as(ADMIN, { mfa: 'aal1' }), { w: a.w });
    expect(e1.code).toBe('auth.mfa_required'); expect(e1.statusCode).toBe(403);
    expect((await anonymiseFails(a.patient.id, '"1"', undefined, as(ADMIN, { grants: [] }), { w: a.w })).code).toBe('auth.forbidden');
    expect((await anonymiseFails(a.patient.id, '"1"', undefined, DESK, { w: a.w })).code).toBe('auth.forbidden');
    expect((await anonymiseFails(a.patient.id, '"1"', undefined, as(ADMIN, { grants: [P.settings, P.patientRead, P.create] }), { w: a.w })).code).toBe('auth.forbidden');   // settings.manage is not anonymise
    await expectUntouched(a);
    const ok = await anonymise(a.patient.id, '"1"', undefined, ADMIN, { w: a.w });
    expect(ok.probe.identity.calls.map((c) => c.permission)).toContain(P.anonymise);
  });

  // FD-T15 review item 1: frontdesk.orders / trf_attachments are tenant+centre RLS, so a centre-scoped admin cannot see another centre's open order or TRFs.
  // F7 must fail closed (REQ-SEC-139 / P-12 c) unless IdentityPort.getActor().centreScope.all is true. Nothing may be written.
  it('centre-scoped aal2 tenant_admin (centreScope.all = false) -> 403 auth.forbidden; patient, consents, TRFs, storage and access_log unchanged', { timeout: T }, async () => {
    const a = await anonymisable({ trfPerOrder: 2 });
    const requestId = uid();
    const e = await anonymiseFails(a.patient.id, '"1"', undefined, as(ADMIN, { allCentres: false }), { w: a.w, requestId });
    expect(e.code).toBe('auth.forbidden'); expect(e.statusCode).toBe(403);
    await expectUntouched(a, requestId);
    expect((await ownerRows('audit.access_log', `action = 'patient.anonymise' AND entity_id = $1`, [a.patient.id]))).toEqual([]);
    expect((await anonymise(a.patient.id, '"1"', undefined, ADMIN, { w: a.w })).status).toBe(200);   // the all-centre admin still may
  });
});

describe('input, concurrency, isolation', () => {
  it('If-Match: absent -> 428 common.precondition_required; stale -> 409 common.version_conflict; malformed -> 400; nothing changes', { timeout: T }, async () => {
    const a = await anonymisable();
    expect((await anonymiseFails(a.patient.id, undefined, undefined, ADMIN, { w: a.w })).code).toBe('common.precondition_required');
    expect((await anonymiseFails(a.patient.id, '"9"', undefined, ADMIN, { w: a.w })).code).toBe('common.version_conflict');
    expect((await anonymiseFails(a.patient.id, '1', undefined, ADMIN, { w: a.w })).code).toBe('common.validation_failed');
    await expectUntouched(a);
  });
  const badBodies: Array<[string, unknown]> = [
    ['no reason_code', {}], ['empty reason_code', { reason_code: '' }], ['reason_code with spaces/punctuation', { reason_code: 'bad code!' }], ['numeric reason_code', { reason_code: 5 }],
    ['reason_code of 65 chars', { reason_code: 'a'.repeat(65) }], ['reason_text of 501 chars', { reason_code: 'patient_request', reason_text: 'x'.repeat(501) }],
    ['unknown field', { reason_code: 'patient_request', extra: 1 }], ['forged tenant_id', { reason_code: 'patient_request', tenant_id: TENANT_B }], ['null body', null], ['string body', 'patient_request'],
  ];
  it.each(badBodies)('400 common.validation_failed for %s; nothing changes', { timeout: T }, async (_n, body) => {
    const a = await anonymisable();
    expect((await anonymiseFails(a.patient.id, '"1"', body, ADMIN, { w: a.w })).code).toBe('common.validation_failed');
    await expectUntouched(a);
  });

  it('already anonymised: a second call is refused (4xx), writes no second patient.anonymise row and no second consent row', { timeout: T }, async () => {
    const a = await anonymisable();
    expect((await anonymise(a.patient.id, '"1"', undefined, ADMIN, { w: a.w })).status).toBe(200);
    const requestId = uid();
    const e = await anonymiseFails(a.patient.id, '"2"', undefined, ADMIN, { w: a.w, requestId });
    expect(e.statusCode).toBeGreaterThanOrEqual(400); expect(e.statusCode).toBeLessThan(500);
    expect(await accessRows('patient.anonymise', requestId)).toEqual([]);
    expect((await consentsOf(a.patient.id)).filter((c) => c.source === 'anonymisation')).toHaveLength(1);
    expect((await patientRow(a.patient.id)).version).toBe(2);
  });

  it('race: two concurrent anonymisations with the same If-Match -> exactly one 200; one anonymisation consent row, one access-log row, one set of deletes', { timeout: T }, async () => {
    const a = await anonymisable({ trfPerOrder: 2 });
    const res = await Promise.allSettled([anonymise(a.patient.id, '"1"', undefined, ADMIN, { w: a.w }), anonymise(a.patient.id, '"1"', undefined, ADMIN, { w: a.w })]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const lost = (res.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason;
    expect(['common.version_conflict', 'common.not_found']).toContain(lost.code);
    expect((await consentsOf(a.patient.id)).filter((c) => c.source === 'anonymisation')).toHaveLength(1);
    expect((await ownerRows('audit.access_log', `action = 'patient.anonymise' AND entity_id = $1`, [a.patient.id]))).toHaveLength(1);
    expect(new Set(a.w.storage.callsOf('delete').map((c) => c.path)).size).toBe(2);
    expect((await patientRow(a.patient.id)).version).toBe(2);
  });

  it('unknown patient -> 404 common.not_found; a patient of another tenant -> 404 too (RLS on, and with RLS bypassed the explicit tenant filter) and is left untouched', { timeout: T }, async () => {
    const other = await seedPatient('b', { full_name: `Zforeign ${tag()}` });
    await seedOrder('b', other.id, { status: 'cancelled', registered_at: yearsAgo(8), cancelled_at: yearsAgo(8), cancel_reason_code: 'patient_request' });
    expect((await anonymiseFails(uid(), '"1"')).code).toBe('common.not_found');
    expect((await anonymiseFails(other.id, '"1"')).code).toBe('common.not_found');
    expect((await anonymiseFails(other.id, '"1"', undefined, ADMIN, { bypassRls: true })).code).toBe('common.not_found');
    expect(await patientRow(other.id)).toMatchObject({ full_name: other.full_name, anonymised_at: null, version: 1 });
    const own = await anonymise(other.id, '"1"', undefined, ADMIN_B);    // its own tenant's admin may
    expect(own.status).toBe(200);
  });

  it('a malformed patient id fails closed (400 or 404), never a SQL error', { timeout: T }, async () => {
    for (const id of ['abc', "1'; DROP TABLE frontdesk.patients;--", '00000000-0000-0000-0000-000000000000']) {
      const e = await anonymiseFails(id, '"1"').catch((x) => x);
      expect(['common.validation_failed', 'common.not_found'], id).toContain(e?.code);
    }
  });
});
