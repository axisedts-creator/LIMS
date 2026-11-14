// FD-T04 F3 getPatient, F4 updatePatient, F6 listPatientOrders — 02-TRD §5.1 F3/F4/F6 + access-log table (patient.view, patient.update {changed_fields = column names only}),
// 02-CV §4.2 (If-Match "<version>": 428 missing / 409 stale), §4.3 cursor pages, 05-SCHEMA §3 (A13 D-27a: demographic values never reach audit rows), 07-SECURITY REQ-SEC-024.
// access.ts allows only string|number|boolean detail values, so changed_fields is a comma-separated string of column names.
import { beforeAll, describe, expect, it } from 'vitest';
import { PERM, T, TENANT_A, TENANT_B, accessRows, call, consentRows, fails, norm, ownerRows, patientRow, phone, req, schemaErrors, seedOrder, seedPatient, seedSettings, tag, uid } from './helpers.js';

const get = (id: string, o: Parameters<typeof call>[2] = {}) => call('getPatient', req({ params: { patient_id: id } }), o);
const patch = (id: string, body: object, ifMatch: string | undefined, o: Parameters<typeof call>[2] = {}) =>
  call('updatePatient', req({ params: { patient_id: id }, body, headers: ifMatch === undefined ? {} : { 'if-match': ifMatch } }), o);
const patchFails = (id: string, body: object, ifMatch: string | undefined, o: Parameters<typeof call>[2] = {}) =>
  patch(id, body, ifMatch, o).then(() => { throw new Error('expected a rejection'); }, (e) => e);
const listOrders = (id: string, query: object = {}, o: Parameters<typeof call>[2] = {}) => call('listPatientOrders', req({ params: { patient_id: id }, query }), o);
beforeAll(async () => { await seedSettings(); }, T);

describe('F3 getPatient', () => {
  it('200 Patient with the CURRENT consents, version, estimated flag; access_log patient.view for this patient', { timeout: T }, async () => {
    const p = await seedPatient('a', { is_birth_on_estimated: true, address_text: 'Synthetic Street 1', email: 'synthetic@example.test' }, { captured_at: '2026-10-01T00:00:00Z', sms: false });
    const r = await get(p.id);
    expect(r.status).toBe(200); expect(schemaErrors('Patient', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: p.id, patient_code: p.patient_code, full_name: p.full_name, is_birth_on_estimated: true, version: 1, phone_e164: p.phone_e164, address_text: 'Synthetic Street 1' });
    expect(r.body.consents).toMatchObject({ processing: true, sms: false, consent_text_version: 'v1' });
    const log = await accessRows('patient.view', r.probe.requestId);
    expect(log).toHaveLength(1); expect(log[0]).toMatchObject({ entity_type: 'patient', entity_id: p.id, outcome: 'allowed' });
    expect(r.probe.identity.calls[0]).toMatchObject({ permission: PERM.read });
  });
  it('phone_e164 / email / address are returned only to roles holding frontdesk.registration.create; a read-only role gets the masked phone', { timeout: T }, async () => {
    const p = await seedPatient('a', { email: 'synthetic@example.test', address_text: 'Synthetic Street 1' });
    const ro = await get(p.id, { grants: [PERM.read] });
    expect(ro.status).toBe(200);
    expect(ro.body).not.toHaveProperty('phone_e164');
    expect(JSON.stringify(ro.body)).not.toContain(p.phone_e164);
    expect(ro.body.phone_masked).toBeTruthy();
    expect(schemaErrors('Patient', ro.body)).toEqual([]);
  });
  it('unknown id and a tenant_b patient both -> 404 common.not_found (same answer: no existence oracle)', { timeout: T }, async () => {
    const b = await seedPatient('b');
    for (const id of [uid(), b.id]) { const e = await fails('getPatient', req({ params: { patient_id: id } })); expect(e.code).toBe('common.not_found'); expect(e.statusCode).toBe(404); }
  });
  it('without frontdesk.patient.read -> auth.forbidden', { timeout: T }, async () => {
    const p = await seedPatient('a');
    expect((await fails('getPatient', req({ params: { patient_id: p.id } }), { grants: [PERM.orders] })).code).toBe('auth.forbidden');
  });
  it('an anonymised patient reads as is_anonymised=true and exposes no phone/email/address', { timeout: T }, async () => {
    const p = await seedPatient('a', { anonymised_at: '2026-10-01T00:00:00Z', full_name: null, name_search: null, phone_e164: null, email: null, address_text: null });
    const r = await get(p.id);
    expect(r.body.is_anonymised).toBe(true);
    for (const k of ['phone_e164', 'email', 'address_text']) expect(r.body[k] ?? null).toBeNull();
  });
});

describe('F4 updatePatient (If-Match, access_log patient.update)', () => {
  it('200: changes only the sent fields, bumps version to 2, recomputes name_search; access_log patient.update lists column names only', { timeout: T }, async () => {
    const p = await seedPatient('a', { address_text: 'Old Street' });
    const newName = `Renamed ${tag()}`; const newPhone = phone();
    const r = await patch(p.id, { full_name: newName, phone_e164: newPhone }, '"1"');
    expect(r.status).toBe(200); expect(schemaErrors('Patient', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ full_name: newName, phone_e164: newPhone, version: 2, address_text: 'Old Street', sex: 'female' });
    const row = await patientRow(p.id);
    expect(row).toMatchObject({ full_name: newName, name_search: norm(newName), phone_e164: newPhone, version: 2, address_text: 'Old Street', patient_code: p.patient_code, tenant_id: TENANT_A });
    const log = await accessRows('patient.update', r.probe.requestId);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ entity_type: 'patient', entity_id: p.id, outcome: 'allowed' });
    expect(typeof log[0].detail.changed_fields).toBe('string');
    expect(new Set(String(log[0].detail.changed_fields).split(','))).toEqual(new Set(['full_name', 'phone_e164']));
    const dump = JSON.stringify(log[0]);
    expect(dump).not.toContain(newName); expect(dump).not.toContain(newPhone); expect(dump).not.toContain(p.full_name);   // values never reach the audit row
    expect(r.probe.logs.join('\n')).not.toContain(newName);
    expect(r.probe.identity.calls[0]).toMatchObject({ permission: PERM.create });
  });
  it('age replaces birth_on as an estimate; birth_on sets an exact date and clears the estimate flag', { timeout: T }, async () => {
    const p = await seedPatient('a');
    const a = await patch(p.id, { age: { years: 50 } }, '"1"');
    expect(a.body).toMatchObject({ birth_on: '1976-11-10', is_birth_on_estimated: true, version: 2 });
    const b = await patch(p.id, { birth_on: '1975-02-03' }, '"2"');
    expect(b.body).toMatchObject({ birth_on: '1975-02-03', is_birth_on_estimated: false, version: 3 });
  });
  it('unset[] clears optional fields to NULL and nothing else', { timeout: T }, async () => {
    const p = await seedPatient('a', { email: 'synthetic@example.test', address_text: 'Synthetic Street 1' });
    const r = await patch(p.id, { unset: ['email', 'phone_e164'] }, '"1"');
    expect(r.status).toBe(200);
    const row = await patientRow(p.id);
    expect(row).toMatchObject({ email: null, phone_e164: null, address_text: 'Synthetic Street 1', full_name: p.full_name, version: 2 });
    expect(new Set(String((await accessRows('patient.update', r.probe.requestId))[0].detail.changed_fields).split(','))).toEqual(new Set(['email', 'phone_e164']));
  });
  it('428 common.precondition_required without If-Match; 409 common.version_conflict with a stale one; the row is untouched either way', { timeout: T }, async () => {
    const p = await seedPatient('a');
    const e1 = await patchFails(p.id, { full_name: 'Nope Nope' }, undefined);
    expect(e1.code).toBe('common.precondition_required'); expect(e1.statusCode).toBe(428);
    const e2 = await patchFails(p.id, { full_name: 'Nope Nope' }, '"7"');
    expect(e2.code).toBe('common.version_conflict'); expect(e2.statusCode).toBe(409);
    expect(await patientRow(p.id)).toMatchObject({ full_name: p.full_name, version: 1 });
  });
  it('malformed If-Match values are refused, never parsed loosely', { timeout: T }, async () => {
    const p = await seedPatient('a');
    for (const h of ['1', 'W/"1"', '"0"', '"-1"', '"1"; DROP TABLE x', '*', '""']) {
      const e = await patchFails(p.id, { full_name: 'Nope Nope' }, h);
      expect(['common.precondition_required', 'common.validation_failed', 'common.version_conflict'], h).toContain(e.code);
    }
    expect((await patientRow(p.id)).version).toBe(1);
  });
  it.each([
    ['birth_on together with age', { birth_on: '1990-01-01', age: { years: 20 } }],
    ['future birth_on', { birth_on: '2027-01-01' }],
    ['blank name', { full_name: '  ' }],
    ['empty body', {}],
  ])('%s -> 400 common.validation_failed, row untouched', { timeout: T }, async (_n, body) => {
    const p = await seedPatient('a');
    expect((await patchFails(p.id, body, '"1"')).code).toBe('common.validation_failed');
    expect((await patientRow(p.id)).version).toBe(1);
  });
  it('tenant isolation: tenant_a cannot update a tenant_b patient (404) and the row does not change', { timeout: T }, async () => {
    const b = await seedPatient('b');
    expect((await patchFails(b.id, { full_name: 'Hijacked Name' }, '"1"')).code).toBe('common.not_found');
    expect(await patientRow(b.id)).toMatchObject({ full_name: b.full_name, version: 1 });
  });
  it('mass assignment: forged tenant_id / patient_code / version / id in the body are rejected or ignored, never applied', { timeout: T }, async () => {
    const p = await seedPatient('a');
    const r = await patch(p.id, { full_name: `Forged ${tag()}`, tenant_id: TENANT_B, patient_code: 'HACKED', version: 99, id: uid() } as any, '"1"').then((x) => x, (e) => e);
    if (r?.code) expect(r.code).toBe('common.validation_failed');
    expect(await patientRow(p.id)).toMatchObject({ tenant_id: TENANT_A, patient_code: p.patient_code, id: p.id, version: r?.code ? 1 : 2 });
  });
  it('without frontdesk.registration.create -> auth.forbidden (read-only role cannot edit demographics)', { timeout: T }, async () => {
    const p = await seedPatient('a');
    expect((await patchFails(p.id, { full_name: 'Nope Nope' }, '"1"', { grants: [PERM.read] })).code).toBe('auth.forbidden');
    expect((await patientRow(p.id)).version).toBe(1);
  });
  it('race: two PATCHes with the same If-Match -> exactly one wins (200), the other is 409 common.version_conflict; final version 2', { timeout: T }, async () => {
    const p = await seedPatient('a');
    const rs = await Promise.all([patch(p.id, { full_name: `Racer A ${tag()}` }, '"1"').then((x) => x, (e) => e), patch(p.id, { full_name: `Racer B ${tag()}` }, '"1"').then((x) => x, (e) => e)]);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.code === 'common.version_conflict')).toHaveLength(1);
    expect((await patientRow(p.id)).version).toBe(2);
  });
  it('a failed update leaves no patient.update access-log row for that request (log and change commit together)', { timeout: T }, async () => {
    const p = await seedPatient('a');
    const e = await patchFails(p.id, { full_name: 'Nope Nope' }, '"9"');
    expect(e.code).toBe('common.version_conflict');
    expect(await ownerRows('audit.access_log', 'action = $1 AND entity_id = $2', ['patient.update', p.id])).toEqual([]);
  });
  it('consents are not touched by a demographics update', { timeout: T }, async () => {
    const p = await seedPatient('a');
    await patch(p.id, { address_text: 'New Street' }, '"1"');
    expect(await consentRows(p.id)).toHaveLength(1);
  });
});

describe('F6 listPatientOrders', () => {
  const regs = async (side: 'a' | 'b', pid: string, n: number) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push(await seedOrder(side, pid, { registered_at: `2026-11-0${i + 1}T04:00:00Z` }));
    return out;
  };
  it('200 OrderSummaryPage, newest first by default (-registered_at); only this patient\'s orders; item_count and flags are consistent', { timeout: T }, async () => {
    const p = await seedPatient('a'); const other = await seedPatient('a');
    const os = await regs('a', p.id, 3); await seedOrder('a', other.id);
    const r = await listOrders(p.id);
    expect(r.status).toBe(200); expect(schemaErrors('OrderSummaryPage', r.body)).toEqual([]);
    expect(r.body.data.map((o: any) => o.id)).toEqual([os[2]!.id, os[1]!.id, os[0]!.id]);
    expect(r.body.data[0]).toMatchObject({ patient_id: p.id, status: 'registered', billing_mode: 'cash', has_open_flag: false, item_count: 0, version: 1 });
    expect(r.probe.identity.calls[0]).toMatchObject({ permission: PERM.orders });
  });
  it('sort=registered_at is ascending; limit pages with an opaque cursor, no overlap, no gap, last page has no next_cursor', { timeout: T }, async () => {
    const p = await seedPatient('a'); const os = await regs('a', p.id, 5);
    expect((await listOrders(p.id, { sort: 'registered_at' })).body.data.map((o: any) => o.id)).toEqual(os.map((o) => o.id));
    const seen: string[] = []; let cursor: string | undefined; let pages = 0;
    do {
      const r = await listOrders(p.id, { limit: 2, ...(cursor ? { cursor } : {}) });
      expect(r.body.page.limit).toBe(2); expect(r.body.data.length).toBeLessThanOrEqual(2);
      seen.push(...r.body.data.map((o: any) => o.id)); cursor = r.body.page.next_cursor; pages++;
    } while (cursor && pages < 10);
    expect(seen).toEqual([...os].reverse().map((o) => o.id)); expect(pages).toBe(3);
  });
  it('equal registered_at: order is stable with id as tie-break (no row skipped or repeated across pages)', { timeout: T }, async () => {
    const p = await seedPatient('a');
    const os = await Promise.all([1, 2, 3, 4].map(() => seedOrder('a', p.id, { registered_at: '2026-11-05T04:00:00Z' })));
    const seen: string[] = []; let cursor: string | undefined;
    for (let i = 0; i < 6; i++) { const r = await listOrders(p.id, { limit: 1, ...(cursor ? { cursor } : {}) }); seen.push(...r.body.data.map((o: any) => o.id)); cursor = r.body.page.next_cursor; if (!cursor) break; }
    expect(new Set(seen).size).toBe(4); expect(seen.length).toBe(4); expect(new Set(seen)).toEqual(new Set(os.map((o) => o.id)));
  });
  it.each(['garbage!!', 'AAAA', 'e30', '%00'])('cursor %j -> 400 common.invalid_cursor', { timeout: T }, async (c) => {
    const p = await seedPatient('a');
    expect((await fails('listPatientOrders', req({ params: { patient_id: p.id }, query: { cursor: c } }))).code).toBe('common.invalid_cursor');
  });
  it('a cursor minted for one patient cannot be replayed on another patient (no cross-patient/tenant leak)', { timeout: T }, async () => {
    const p = await seedPatient('a'); const q = await seedPatient('a'); await regs('a', p.id, 3); const qs = await regs('a', q.id, 3);
    const first = await listOrders(p.id, { limit: 1 });
    const e = await listOrders(q.id, { limit: 5, cursor: first.body.page.next_cursor }).then((x) => x, (x) => x);
    if (e?.code) expect(e.code).toBe('common.invalid_cursor');
    else for (const o of e.body.data) expect(qs.map((x) => x.id)).toContain(o.id);
  });
  it('patient with no orders -> 200 empty page; unknown / tenant_b patient -> 404 common.not_found; tenant_b orders never appear', { timeout: T }, async () => {
    const p = await seedPatient('a'); const b = await seedPatient('b'); await seedOrder('b', b.id);
    expect((await listOrders(p.id)).body.data).toEqual([]);
    for (const id of [uid(), b.id]) expect((await fails('listPatientOrders', req({ params: { patient_id: id } }))).code).toBe('common.not_found');
  });
  it('without frontdesk.order.read -> auth.forbidden (patient.read alone is not enough)', { timeout: T }, async () => {
    const p = await seedPatient('a');
    expect((await fails('listPatientOrders', req({ params: { patient_id: p.id } }), { grants: [PERM.read] })).code).toBe('auth.forbidden');
  });
  it('probe: a TENANT_B ctx cannot list tenant_a patient orders either (symmetry)', { timeout: T }, async () => {
    const p = await seedPatient('a'); await seedOrder('a', p.id);
    expect((await fails('listPatientOrders', req({ params: { patient_id: p.id } }), { tenant: TENANT_B })).code).toBe('common.not_found');
  });
});
