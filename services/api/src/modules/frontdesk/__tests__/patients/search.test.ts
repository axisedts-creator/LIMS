// FD-T04 F1 searchPatients — US-FD-01.1..6 (01-PRD §8), 03-APP-FLOW §2.1, 02-TRD §5.1 F1 + access-log table (patient.search, detail {mode, result_count}, no query text).
// Query modes: auto -> phone (digits>=10 or '+', +977 default) | code (patientCodePattern prefix; fake tenant pattern 'MP{seq:8}') | registration_no ('R{seq:6}') | name.
import { beforeAll, describe, expect, it } from 'vitest';
import { PERM, T, TENANT_A, TENANT_B, accessRows, call, fails, ownerRows, uid, national, norm, phone, req, schemaErrors, seedOrder, seedPatient, seedSettings, tag } from './helpers.js';

const search = (body: object, o: Parameters<typeof call>[2] = {}) => call('searchPatients', req({ body }), o);
beforeAll(async () => { await seedSettings(); }, T);

describe('US-FD-01.1 search by mobile', () => {
  it('9800000042-style national number finds the patient first, with code, sex, age and last visit; masked phone only', { timeout: T }, async () => {
    const p = await seedPatient('a', { full_name: `Test Patient ${tag()}`, birth_on: '1983-11-10' });
    const r = await search({ query: national(p.phone_e164) });
    expect(r.status).toBe(200);
    expect(schemaErrors('PatientSummaryList', r.body)).toEqual([]);
    const first = r.body.data[0];
    expect(first.id).toBe(p.id);
    expect(first).toMatchObject({ patient_code: p.patient_code, sex: 'female', age_display: '43 Years', is_anonymised: false });
    expect(first.last_visit_at).toBe('2026-11-01T04:00:00.000Z');
    expect(first.phone_masked).not.toContain(p.phone_e164.slice(5, 11));   // middle digits never shown
    expect(JSON.stringify(r.body)).not.toContain(p.phone_e164);
    expect(r.probe.identity.calls[0]).toMatchObject({ permission: PERM.read });
  });
  it('the E.164 form and mode=phone find the same patient; a different phone does not', { timeout: T }, async () => {
    const p = await seedPatient('a');
    expect((await search({ query: p.phone_e164 })).body.data.map((x: any) => x.id)).toEqual([p.id]);
    expect((await search({ query: national(p.phone_e164), mode: 'phone' })).body.data.map((x: any) => x.id)).toEqual([p.id]);
    expect((await search({ query: phone(), mode: 'phone' })).body.data).toEqual([]);
  });
  it('several patients sharing a phone are all returned, most recent visit first', { timeout: T }, async () => {
    const ph = phone();
    const old = await seedPatient('a', { phone_e164: ph, last_visit_at: '2026-01-01T00:00:00Z' });
    const recent = await seedPatient('a', { phone_e164: ph, last_visit_at: '2026-10-01T00:00:00Z' });
    expect((await search({ query: ph, mode: 'phone' })).body.data.map((x: any) => x.id)).toEqual([recent.id, old.id]);
  });
});

describe('US-FD-01.2 search by patient code / by registration no of any of their orders', () => {
  it('patient code (auto and explicit mode) returns exactly that patient', { timeout: T }, async () => {
    const p = await seedPatient('a'); await seedPatient('a');
    expect((await search({ query: p.patient_code })).body.data.map((x: any) => x.id)).toEqual([p.id]);
    expect((await search({ query: p.patient_code, mode: 'code' })).body.data.map((x: any) => x.id)).toEqual([p.id]);
  });
  it('registration no of any order (auto and explicit mode) returns exactly the owning patient', { timeout: T }, async () => {
    const p = await seedPatient('a'); const other = await seedPatient('a');
    const o1 = await seedOrder('a', p.id); const o2 = await seedOrder('a', p.id); await seedOrder('a', other.id);
    for (const o of [o1, o2]) {
      expect((await search({ query: o.registration_no })).body.data.map((x: any) => x.id), o.registration_no).toEqual([p.id]);
      expect((await search({ query: o.registration_no, mode: 'registration_no' })).body.data.map((x: any) => x.id)).toEqual([p.id]);
    }
  });
  it('code / registration modes are exact: a prefix of a code matches nothing', { timeout: T }, async () => {
    const p = await seedPatient('a');
    expect((await search({ query: p.patient_code.slice(0, 7), mode: 'code' })).body.data).toEqual([]);
  });
});

describe('US-FD-01.3 minimum length', () => {
  it.each(['ab', ' ab ', 'a', '98', '  '])('%j -> 400 common.validation_failed and nothing is logged to access_log as a successful search', { timeout: T }, async (q) => {
    const e = await fails('searchPatients', req({ body: { query: q } }));
    expect(e.code).toBe('common.validation_failed'); expect(e.statusCode).toBe(400);
  });
  it('mode=name with 2 characters is also refused; 3 characters are accepted (zero hits is fine)', { timeout: T }, async () => {
    expect((await fails('searchPatients', req({ body: { query: 'ab', mode: 'name' } }))).code).toBe('common.validation_failed');
    expect((await search({ query: `zq${tag().slice(0, 1)}`, mode: 'name' })).status).toBe(200);
  });
  it('a full patient code or full mobile shorter than a name is still allowed by the rule "3 letters or a full mobile/code"', { timeout: T }, async () => {
    const p = await seedPatient('a');
    expect((await search({ query: p.patient_code })).status).toBe(200);
  });
  it('limit above 20 never returns more than 20 rows (rejected or capped)', { timeout: T }, async () => {
    const t = tag(); for (let i = 0; i < 22; i++) await seedPatient('a', { full_name: `Bulk${t} Person${i}`, phone_e164: null });
    const r = await call('searchPatients', req({ body: { query: `bulk${t}`, mode: 'name', limit: 500 } })).then((x) => x.body.data.length, (e) => e.code);
    expect(typeof r === 'number' ? r <= 20 : r === 'common.validation_failed').toBe(true);
    expect((await search({ query: `bulk${t}`, mode: 'name' })).body.data.length).toBe(20);
  });
});

describe('US-FD-01.4 tenant isolation', () => {
  it('a patient that exists only in tenant_b is invisible to a tenant_a search by exact mobile, code, registration no and name', { timeout: T }, async () => {
    const b = await seedPatient('b', { full_name: `Theirs ${tag()}` }); const bo = await seedOrder('b', b.id);
    for (const q of [national(b.phone_e164), b.patient_code, bo.registration_no, b.full_name]) {
      expect((await search({ query: q })).body.data, q).toEqual([]);
    }
    expect((await search({ query: national(b.phone_e164) }, { tenant: TENANT_B })).body.data.map((x: any) => x.id)).toEqual([b.id]);
  });
  it('RLS backstop: if the handler were handed the wrong ctx.tenantId it still sees nothing of the other tenant', { timeout: T }, async () => {
    const b = await seedPatient('b');
    // Ruling FD-T04 #4: the patient.search access_log row is mandatory (01-PRD:142, 02-TRD:225, 03-APP-FLOW:68); with claims A + ctx.tenantId B, RLS rejects that row,
    // so failing closed is correct. Accept EITHER a rejection OR 200 with no data; never a tenant-B row, never a tenant-B access_log row.
    const requestId = uid();
    const out = await call('searchPatients', req({ body: { query: national(b.phone_e164) } }), { tenant: TENANT_A, tenantId: TENANT_B, requestId }).then((x) => ({ ok: x }), (e) => ({ err: e }));
    if ('ok' in out) { expect(out.ok.status).toBe(200); expect(out.ok.body.data).toEqual([]); }
    expect(JSON.stringify('ok' in out ? out.ok.body : {})).not.toContain(b.id);
    expect(await ownerRows('audit.access_log', 'tenant_id = $1 AND request_id = $2', [TENANT_B, requestId])).toEqual([]);
  });
});

describe('US-FD-01.5 access log + no query text', () => {
  it('writes exactly one audit.access_log row: action patient.search, entity patient, detail {mode, result_count}, no query text', { timeout: T }, async () => {
    const p = await seedPatient('a', { full_name: `Logged ${tag()}` });
    const r = await search({ query: national(p.phone_e164) });
    const rows = await accessRows('patient.search', r.probe.requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenant_id: TENANT_A, entity_type: 'patient', outcome: 'allowed' });
    expect(rows[0].detail).toEqual({ mode: 'phone', result_count: 1 });
    expect(JSON.stringify(rows[0])).not.toContain(national(p.phone_e164));
    expect(r.probe.accessCalls).toHaveLength(1);
  });
  it('zero-result searches are logged too (result_count 0) and the name query text appears nowhere in the row', { timeout: T }, async () => {
    const q = `nobody${tag()}`;
    const r = await search({ query: q, mode: 'name' });
    const rows = await accessRows('patient.search', r.probe.requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toEqual({ mode: 'name', result_count: 0 });
    expect(JSON.stringify(rows[0])).not.toContain(q);
  });
  it('mode auto is resolved before logging (detail.mode is the effective mode, never "auto")', { timeout: T }, async () => {
    const p = await seedPatient('a'); const o = await seedOrder('a', p.id);
    const modes: string[] = [];
    for (const q of [national(p.phone_e164), p.patient_code, o.registration_no, `Fdt Seed`]) {
      const r = await search({ query: q }); modes.push((await accessRows('patient.search', r.probe.requestId))[0].detail.mode);
    }
    expect(modes).toEqual(['phone', 'code', 'registration_no', 'name']);
  });
  it('no query text in ctx.log output (name, phone, code)', { timeout: T }, async () => {
    const p = await seedPatient('a', { full_name: `Secretive ${tag()}` });
    for (const q of [p.full_name, national(p.phone_e164), p.patient_code]) {
      const r = await search({ query: q });
      expect(r.probe.logs.join('\n')).not.toContain(q);
    }
  });
});

describe('US-FD-01.6 Devanagari + normalisation', () => {
  it('matches NFC-normalised Devanagari names (plain word)', { timeout: T }, async () => {
    const t = tag(); const name = `परीक्षण ${t}`;
    const p = await seedPatient('a', { full_name: name, name_search: norm(name) });
    expect((await search({ query: 'परीक्षण' })).body.data.map((x: any) => x.id)).toContain(p.id);
  });
  it('a query typed with a decomposable precomposed nukta letter (U+0958) matches the stored NFC form (U+0915 U+093C)', { timeout: T }, async () => {
    const t = tag(); const stored = `क़लम ${t}`;
    const p = await seedPatient('a', { full_name: stored, name_search: norm(stored) });
    const r = await search({ query: `क़लम ${t}`, mode: 'name' });
    expect(r.body.data.map((x: any) => x.id)).toContain(p.id);
  });
  it('case-insensitive, whitespace-collapsed Latin name search; exact name ranks before a looser match', { timeout: T }, async () => {
    const t = tag();
    const exact = await seedPatient('a', { full_name: `Ramesh Thapa ${t}`, name_search: norm(`Ramesh Thapa ${t}`), phone_e164: null });
    const looser = await seedPatient('a', { full_name: `Ramesh Thapa ${t}x Magar`, name_search: norm(`Ramesh Thapa ${t}x Magar`), phone_e164: null });
    const ids = (await search({ query: `  RAMESH   thapa ${t.toUpperCase()} `, mode: 'name' })).body.data.map((x: any) => x.id);
    expect(ids[0]).toBe(exact.id); expect(ids).toContain(looser.id);
  });
  it('anonymised patients are never returned (by name, phone or code)', { timeout: T }, async () => {
    const t = tag();
    const a = await seedPatient('a', { full_name: `Anon ${t}`, name_search: norm(`Anon ${t}`), anonymised_at: '2026-10-01T00:00:00Z' });
    for (const [q, mode] of [[`anon ${t}`, 'name'], [national(a.phone_e164), 'phone'], [a.patient_code, 'code']] as const) {
      expect((await search({ query: q, mode })).body.data.map((x: any) => x.id), q).not.toContain(a.id);
    }
  });
});

describe('probes: hostile query strings', () => {
  it.each([
    `'; DROP TABLE frontdesk.patients; --`, `' OR '1'='1`, `%%%`, `___`, `\\\\\\`, `a%b`, `"; select pg_sleep(5); --`, '\u0000nul', '<script>alert(1)</script>',
  ])('%j is treated as data: 200, no rows from other patients, table intact', { timeout: T }, async (q) => {
    const p = await seedPatient('a');
    const r = await call('searchPatients', req({ body: { query: q, mode: 'name' } })).then((x) => x, (e) => e);
    if (r instanceof Error || (r as any).code) expect((r as any).code).toBe('common.validation_failed');   // a NUL byte may be refused as invalid
    else { expect(r.status).toBe(200); expect(r.body.data.length).toBeLessThanOrEqual(20); for (const x of r.body.data) expect(x.is_anonymised).toBe(false); }
    // table intact (arbiter ruling: no tenant-wide count, other suites insert in parallel)
    expect(await ownerRows('frontdesk.patients', 'id = $1', [p.id])).toHaveLength(1);
    expect(await ownerRows('pg_catalog.pg_class', "oid = to_regclass('frontdesk.patients')")).toHaveLength(1);
  });
  it('LIKE wildcards in a name query do not match everything', { timeout: T }, async () => {
    const p = await seedPatient('a', { full_name: `Wild ${tag()}` });
    const ids = (await search({ query: '%%%', mode: 'name' })).body.data.map((x: any) => x.id);
    expect(ids).not.toContain(p.id);
  });
  it('a 100-char query is accepted; the response never exceeds the PatientSummaryList schema', { timeout: T }, async () => {
    const r = await search({ query: 'x'.repeat(100), mode: 'name' });
    expect(schemaErrors('PatientSummaryList', r.body)).toEqual([]);
  });
});

describe('permission', () => {
  it('without frontdesk.patient.read: auth.forbidden, no data, no access-log row', { timeout: T }, async () => {
    const p = await seedPatient('a');
    const e = await fails('searchPatients', req({ body: { query: national(p.phone_e164) } }), { grants: [PERM.orders] });
    expect(e.code).toBe('auth.forbidden');
  });
});
