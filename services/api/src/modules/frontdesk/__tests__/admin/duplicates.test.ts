// FD-T15 F26 listPossibleDuplicatePatients. 02-TRD §5 F26: GET /v1/frontdesk/patients/possible-duplicates?created_on&cursor&limit, `created_on` = A.D. date in the TENANT timezone
// (default today), permission frontdesk.registration.create, page of `{patient: PatientSummary, candidates: [PatientSummary] <= 5}` for patients created on that date for which the
// §2.3 dedupe predicate (normalised name, birth year +-1, same phone when both present) finds ANOTHER NON-ANONYMISED patient; access-log `patient.search` with
// detail {mode:'possible_duplicates', result_count}; `common.invalid_cursor`. Plan row FD-T15: "F26 returns only same-tenant candidates" (RLS + explicit tenant filter).
// Every test works on its own random date (2000-2019: Asia/Kathmandu is +05:45 there) so counts are exact even on a shared DB. Fails now: stub (common.service_unavailable).
import { describe, expect, it } from 'vitest';
import { ADMIN, DESK, P, T, TENANT_B, accessRows, as, duplicates, duplicatesFails, phone, schemaErrors, seedPatient, tag, uid } from './helpers.js';

const rnd = (n: number) => Math.floor(Math.random() * n);
/** A fresh A.D. date between 2000-01-01 and 2019-12-28 (no tenant-timezone edge cases, no collisions with other suites). */
const freshDate = () => `${2000 + rnd(20)}-${String(1 + rnd(12)).padStart(2, '0')}-${String(1 + rnd(28)).padStart(2, '0')}`;
const at = (date: string, time = '10:00:00') => `${date}T${time}+05:45`;
const nm = (t: string, tail = 'Kumari') => `Zdup${t} ${tail}`;
const mk = (side: 'a' | 'b', date: string, o: Record<string, unknown>) => seedPatient(side, { created_at: at(date), ...o });
const idsOf = (body: any) => (body.data as any[]).map((x) => x.patient.id);
const entry = (body: any, id: string) => (body.data as any[]).find((x) => x.patient.id === id);
const cand = (body: any, id: string) => (entry(body, id)?.candidates as any[] | undefined)?.map((c) => c.id).sort();

describe('F26 the dedupe predicate (US-FD-02.2 reused over a day of registrations)', () => {
  it('lists exactly the patients with another matching non-anonymised patient of the same tenant, with their candidates; masks phones; schema-valid', { timeout: T }, async () => {
    const D = freshDate(); const D2 = `${2000 + rnd(20)}-06-15`;
    const t = tag(); const ph = phone();
    // 1: same normalised name (case + whitespace), birth year +1, same phone
    const a1 = await mk('a', D, { full_name: nm(t), birth_on: '1990-05-05', phone_e164: ph });
    const a2 = await mk('a', D, { full_name: `ZDUP${t}    kumari`, birth_on: '1991-01-01', phone_e164: ph });
    // 2: birth year +2 -> no
    const t2 = tag(); const b1 = await mk('a', D, { full_name: nm(t2), birth_on: '1990-05-05' }); const b2 = await mk('a', D, { full_name: nm(t2), birth_on: '1992-05-05' });
    // 3: both phones present and different -> no
    const t3 = tag(); const c1 = await mk('a', D, { full_name: nm(t3), birth_on: '1980-01-01', phone_e164: phone() }); const c2 = await mk('a', D, { full_name: nm(t3), birth_on: '1980-01-01', phone_e164: phone() });
    // 4: one phone missing -> yes
    const t4 = tag(); const d1 = await mk('a', D, { full_name: nm(t4), birth_on: '1975-03-03', phone_e164: phone() }); const d2 = await mk('a', D, { full_name: nm(t4), birth_on: '1975-03-03', phone_e164: null });
    // 5: twin created on ANOTHER date still counts as the candidate; the twin itself is not listed for D
    const t5 = tag(); const ph5 = phone(); const e1 = await mk('a', D, { full_name: nm(t5), birth_on: '1985-07-07', phone_e164: ph5 }); const e2 = await mk('a', D2, { full_name: nm(t5), birth_on: '1985-07-07', phone_e164: ph5 });
    // 6: anonymised twin never matches (and an anonymised patient is never listed)
    const t6 = tag();
    const f1 = await mk('a', D, { full_name: nm(t6), birth_on: '1970-01-01' });
    const f2 = await mk('a', D, { full_name: null, name_search: null, birth_on: null, phone_e164: null, anonymised_at: at(D), anonymised_by: uid() });
    // 7: a twin in the OTHER tenant never matches
    const t7 = tag(); const ph7 = phone();
    const g1 = await mk('a', D, { full_name: nm(t7), birth_on: '1965-02-02', phone_e164: ph7 }); const g2 = await mk('b', D, { full_name: nm(t7), birth_on: '1965-02-02', phone_e164: ph7 });
    // 8: a lone patient
    const h1 = await mk('a', D, { full_name: nm(tag()), birth_on: '1960-01-01' });

    const expected = [a1.id, a2.id, d1.id, d2.id, e1.id].sort();
    for (const bypassRls of [false, true]) {
      const r = await duplicates({ created_on: D }, DESK, { bypassRls });
      expect(r.status).toBe(200);
      expect(schemaErrors('PossibleDuplicatePage', r.body), `bypassRls=${bypassRls}`).toEqual([]);
      expect(idsOf(r.body).sort(), `bypassRls=${bypassRls}`).toEqual(expected);
      expect(cand(r.body, a1.id)).toEqual([a2.id]); expect(cand(r.body, a2.id)).toEqual([a1.id]);
      expect(cand(r.body, d1.id)).toEqual([d2.id]); expect(cand(r.body, d2.id)).toEqual([d1.id]);
      expect(cand(r.body, e1.id)).toEqual([e2.id]);
      for (const x of [b1, b2, c1, c2, f1, f2, g1, g2, h1, e2]) expect(idsOf(r.body), x.id).not.toContain(x.id);
      // no patient or candidate of tenant B anywhere
      expect(JSON.stringify(r.body)).not.toContain(g2.id);
    }
    // summaries: masked phone only, never the full number / email / address / birth date
    const r = await duplicates({ created_on: D }, DESK);
    const dump = JSON.stringify(r.body);
    for (const v of [ph, a1.email, a1.address_text, '1990-05-05', '1991-01-01']) if (v) expect(dump).not.toContain(String(v));
    const s = entry(r.body, a1.id);
    expect(s.patient).toMatchObject({ id: a1.id, patient_code: a1.patient_code, full_name: a1.full_name, is_anonymised: false });
    expect(s.patient.phone_masked).toContain('*'); expect(s.patient).not.toHaveProperty('phone_e164');
    expect(s.candidates[0].phone_masked).toContain('*'); expect(s.candidates[0]).not.toHaveProperty('phone_e164');
  });

  it('at most 5 candidates per patient (7 identical people -> every entry has exactly 5, none is the patient itself)', { timeout: T }, async () => {
    const D = freshDate(); const t = tag(); const ph = phone();
    const all = await Promise.all(Array.from({ length: 7 }, () => mk('a', D, { full_name: nm(t), birth_on: '1990-01-01', phone_e164: ph })));
    const r = await duplicates({ created_on: D, limit: '200' });
    expect(idsOf(r.body).sort()).toEqual(all.map((p) => p.id).sort());
    for (const p of all) {
      const c = cand(r.body, p.id)!;
      expect(c).toHaveLength(5); expect(new Set(c).size).toBe(5); expect(c).not.toContain(p.id);
      for (const id of c) expect(all.map((x) => x.id)).toContain(id);
    }
    expect(schemaErrors('PossibleDuplicatePage', r.body)).toEqual([]);
  });
});

describe('F26 created_on is a date in the TENANT timezone (Asia/Kathmandu, +05:45), default today', () => {
  it('default = tenant-local today of ctx.now() (2026-11-10 11:45); the day edges follow Kathmandu midnight, not UTC', { timeout: T }, async () => {
    const twinDate = freshDate(); const t = tag();
    const mkPair = async (stamp: string) => {
      const ph = phone();
      const x = await seedPatient('a', { full_name: nm(`${t}${tag()}`), birth_on: '1990-01-01', phone_e164: ph, created_at: stamp });
      const twin = await seedPatient('a', { full_name: x.full_name, birth_on: '1990-01-01', phone_e164: ph, created_at: at(twinDate) });
      return { x, twin };
    };
    const justAfterMidnight = await mkPair('2026-11-09T18:30:00Z');   // 2026-11-10 00:15 in Kathmandu (UTC date is still 11-09)
    const lastMinute = await mkPair('2026-11-10T18:14:00Z');          // 2026-11-10 23:59
    const nextDay = await mkPair('2026-11-10T18:15:00Z');             // 2026-11-11 00:00
    const previous = await mkPair('2026-11-09T18:14:00Z');            // 2026-11-09 23:59
    const dflt = await duplicates({ limit: '200' });
    expect(idsOf(dflt.body)).toEqual(expect.arrayContaining([justAfterMidnight.x.id, lastMinute.x.id]));
    expect(idsOf(dflt.body)).not.toContain(nextDay.x.id); expect(idsOf(dflt.body)).not.toContain(previous.x.id);
    expect(cand(dflt.body, justAfterMidnight.x.id)).toEqual([justAfterMidnight.twin.id]);
    const d9 = await duplicates({ created_on: '2026-11-09', limit: '200' });
    expect(idsOf(d9.body)).toContain(previous.x.id); expect(idsOf(d9.body)).not.toContain(justAfterMidnight.x.id);
    const d11 = await duplicates({ created_on: '2026-11-11', limit: '200' });
    expect(idsOf(d11.body)).toContain(nextDay.x.id); expect(idsOf(d11.body)).not.toContain(lastMinute.x.id);
  });
});

describe('F26 paging (02-CV §4.3 keyset cursor)', () => {
  it('limit 4 over 6 listed patients -> 4 + cursor, then 2 and no cursor; no overlap, nothing missing; page.limit echoed; an exact-fit page has no cursor', { timeout: T }, async () => {
    const D = freshDate(); const ids: string[] = [];
    for (let i = 0; i < 3; i++) { const t = tag(); const ph = phone(); for (let j = 0; j < 2; j++) ids.push((await mk('a', D, { full_name: nm(t), birth_on: '1990-01-01', phone_e164: ph })).id); }
    const p1 = await duplicates({ created_on: D, limit: '4' });
    expect(p1.body.data).toHaveLength(4); expect(p1.body.page.limit).toBe(4); expect(typeof p1.body.page.next_cursor).toBe('string');
    const p2 = await duplicates({ created_on: D, limit: '4', cursor: p1.body.page.next_cursor });
    expect(p2.body.data).toHaveLength(2); expect(p2.body.page.next_cursor).toBeUndefined();
    expect([...idsOf(p1.body), ...idsOf(p2.body)].sort()).toEqual([...ids].sort());
    expect(schemaErrors('PossibleDuplicatePage', p1.body)).toEqual([]);
    const exact = await duplicates({ created_on: D, limit: '6' });
    expect(exact.body.data).toHaveLength(6); expect(exact.body.page.next_cursor).toBeUndefined();
  });
  it('a malformed or forged cursor -> 400 common.invalid_cursor', { timeout: T }, async () => {
    const D = freshDate();
    for (const cursor of ['abc', 'e30', Buffer.from('["x","y","z"]').toString('base64url'), Buffer.from(JSON.stringify(['-created_at', '2000-01-01T00:00:00.000000Z', 'not-a-uuid'])).toString('base64url')]) {
      expect((await duplicatesFails({ created_on: D, cursor })).code, cursor).toBe('common.invalid_cursor');
    }
  });
});

describe('F26 input, permission, audit', () => {
  it('invalid created_on / limit / unknown parameters -> 400 common.validation_failed', { timeout: T }, async () => {
    for (const q of [{ created_on: 'abc' }, { created_on: '2026-13-01' }, { created_on: '2026-02-30' }, { created_on: '2026-11-10T00:00:00Z' }, { created_on: '' },
      { limit: '0' }, { limit: '201' }, { limit: 'x' }, { name: 'x' }, { tenant_id: TENANT_B }]) {
      expect((await duplicatesFails(q as any)).code, JSON.stringify(q)).toBe('common.validation_failed');
    }
  });

  it('permission frontdesk.registration.create is required (auth.forbidden); not privileged: aal1 is enough', { timeout: T }, async () => {
    expect((await duplicatesFails({}, as(DESK, { grants: [P.patientRead, P.orderRead] }))).code).toBe('auth.forbidden');
    expect((await duplicatesFails({}, as(ADMIN, { grants: [P.settings, P.anonymise] }))).code).toBe('auth.forbidden');
    const ok = await duplicates({}, as(DESK, { mfa: 'aal1' }));
    expect(ok.status).toBe(200); expect(ok.probe.identity.calls.map((c) => c.permission)).toContain(P.create);
  });

  it('access_log: exactly one patient.search row, detail {mode: possible_duplicates, result_count}; no name, phone or query text in it', { timeout: T }, async () => {
    const D = freshDate(); const t = tag(); const ph = phone();
    await mk('a', D, { full_name: nm(t), birth_on: '1990-01-01', phone_e164: ph }); await mk('a', D, { full_name: nm(t), birth_on: '1990-01-01', phone_e164: ph });
    const r = await duplicates({ created_on: D });
    const log = await accessRows('patient.search', r.probe.requestId);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ entity_type: 'patient', outcome: 'allowed', detail: { mode: 'possible_duplicates', result_count: 2 } });
    const dump = JSON.stringify(log[0]) + r.probe.logs.join('\n');
    for (const v of [t, ph]) expect(dump).not.toContain(v);
  });

  it('an empty day is a normal empty page, not an error', { timeout: T }, async () => {
    const r = await duplicates({ created_on: freshDate() });
    expect(r.status).toBe(200); expect(r.body.data).toEqual([]);
    expect(schemaErrors('PossibleDuplicatePage', r.body)).toEqual([]);
  });
});
