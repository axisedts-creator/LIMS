// T0B-TESTMGMT-1 (LD-318, done_when 2, 3, 4, 7): reference range bands and critical bands with the ElabAssist fields (third gender, hour, laboratory, machine, default range,
// method, auto approved band). Real PG17, RLS on. Ranges only ever change in DRAFT sets; publishReferenceRangeSet / publishCriticalLimitSet (catalog.reference_range.publish) makes them live.
// PINNED PICKS (the contract has no text for where each rule fires; flagged to the lead):
//  - draft write (createReferenceRangeSetDraft with bands, replaceReferenceRangeSetBands, same for critical): per band age from <= age to (compared in hours across units), low <= high,
//    auto_approved_low <= auto_approved_high, the auto approved band inside the normal band (auto_approved_low >= low, auto_approved_high <= high), uuid / enum / boolean shapes, AND at most one
//    default_range per group (sex, instrument_id, laboratory_id). Paths: /bands/{i}/age_high, /bands/{i}/low, /bands/{i}/auto_approved_low | _high, /bands/{i}/default_range (the LATER band of the group).
//  - publish: overlap (existing rule, widened: the group is sex + specimen + instrument + laboratory, units compared in hours) flags /bands/{i} and /bands/{j}; when ANY band of the set sets default_range,
//    instrument_id or laboratory_id, EVERY group must hold exactly one default band, else /bands/{i}/default_range of the first band of the offending group. A set that uses none of the new fields
//    publishes exactly as before.
//  - critical outside normal: a critical band must lie outside the normal band it overlaps (same sex or any, overlapping age): critical low < normal low and critical high > normal high, checked on
//    replaceCriticalLimitSetBands and publishCriticalLimitSet against the analyte's draft-or-published reference set (when none exists nothing is compared); paths /bands/{i}/low, /bands/{i}/high.
import { beforeAll, describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B, T, auditRows, band, call, dbRow, errPaths, expectCode, expectInvalid, fails, im, mkAnalyte, mkRangeDraft, mkLegacyTest as mkTest, ownerRows, publishVersion, req, schemaErrors, uid, world, years, type World } from './helpers.js';

let A: World;
beforeAll(async () => { A = await world(TENANT_A); }, T);

const INSTR = '01a1a98a-ac40-7000-8000-0000000000a1'; const INSTR2 = '01a1a98a-ac40-7000-8000-0000000000a2';
const LAB = '01a1a98a-ac40-7000-8000-0000000000b1'; const LAB2 = '01a1a98a-ac40-7000-8000-0000000000b2';
async function analyte(): Promise<any> {
  const t = await mkTest(A); const a = await mkAnalyte(A, t.id); await publishVersion(a); return a;
}
const replace = (setId: string, version: number, bands: object[], tenant = TENANT_A) => call('replaceReferenceRangeSetBands', req({ params: { set_id: setId }, headers: im(version), body: { bands } }), { tenant });
const replaceCrit = (setId: string, version: number, bands: object[]) => call('replaceCriticalLimitSetBands', req({ params: { set_id: setId }, headers: im(version), body: { bands } }));
const publish = (setId: string, version: number, o: { grants?: readonly string[] } = {}) => call('publishReferenceRangeSet', req({ params: { set_id: setId }, headers: im(version), body: { change_reason: 'synthetic ranges' } }), o);
const publishCrit = (setId: string, version: number) => call('publishCriticalLimitSet', req({ params: { set_id: setId }, headers: im(version), body: { change_reason: 'synthetic critical' } }));
const draftReplace = async (_unused: object[] = []) => { const a = await analyte(); const s = await mkRangeDraft(a.id, [band()]); return { a, s }; };

describe('(2) every new band field is stored and returned', () => {
  it('replaceReferenceRangeSetBands with all new fields: 200 RangeSet (schema valid), fields echoed, columns stored under the tenant; hour units and third_gender accepted', { timeout: T }, async () => {
    const a = await analyte();
    const s = await mkRangeDraft(a.id, [band()]);
    const b0 = band({ sex: 'third_gender', age_low: { value: 0, unit: 'hour' }, age_high: { value: 48, unit: 'hour' }, instrument_id: INSTR, laboratory_id: LAB, default_range: true,
      method_id: A.method.id, low: '10.0', high: '20.0', auto_approved_low: '12.0', auto_approved_high: '18.0', display_text: '10 - 20', sort_order: 0 });
    const r = await replace(s.id, s.version, [b0]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(schemaErrors('RangeSet', r.body)).toEqual([]);
    expect(r.body.bands[0]).toMatchObject({ sex: 'third_gender', age_low: { value: 0, unit: 'hour' }, age_high: { value: 48, unit: 'hour' }, instrument_id: INSTR, laboratory_id: LAB, default_range: true, method_id: A.method.id });
    expect(Number(r.body.bands[0].auto_approved_low)).toBe(12); expect(Number(r.body.bands[0].auto_approved_high)).toBe(18);
    const rows = await ownerRows('catalog.reference_ranges', 'set_id = $1', [s.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenant_id: TENANT_A, sex: 'third_gender', age_low_unit: 'hour', instrument_id: INSTR, laboratory_id: LAB, default_range: true, method_id: A.method.id });
    const g = await call('getReferenceRangeSet', req({ params: { set_id: s.id } }));
    expect(g.body.bands[0].default_range).toBe(true);
  });
  it('bands without the new fields read back as before: default_range false, the other new fields absent', { timeout: T }, async () => {
    const a = await analyte();
    const s = await mkRangeDraft(a.id, [band()]);
    expect(s.bands[0].default_range ?? false).toBe(false);
    for (const k of ['instrument_id', 'laboratory_id', 'method_id', 'auto_approved_low', 'auto_approved_high']) expect(s.bands[0][k], k).toBeUndefined();
  });
  it('critical bands accept third_gender and hour; they are stored and returned', { timeout: T }, async () => {
    const a = await analyte();
    const c = (await call('createCriticalLimitSetDraft', req({ params: { analyte_id: a.id }, body: { bands: [{ sex: 'third_gender', age_low: { value: 0, unit: 'hour' }, age_high: { value: 24, unit: 'hour' }, low: '1.0', high: '9.0' }] }, headers: { 'idempotency-key': uid() } })));
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(c.body.bands[0]).toMatchObject({ sex: 'third_gender', age_low: { value: 0, unit: 'hour' }, age_high: { value: 24, unit: 'hour' } });
  });
});

describe('(3) per band rules: 400 + path before any write (draft write)', () => {
  const BAD: Array<[string, Record<string, unknown>, string]> = [
    ['age from above age to (5 years to 1 year)', { age_low: years(5), age_high: years(1) }, '/bands/0/age_high'],
    ['age from above age to across units (13 months to 1 year)', { age_low: { value: 13, unit: 'month' }, age_high: years(1) }, '/bands/0/age_high'],
    ['age from above age to across units (25 hours to 1 day)', { age_low: { value: 25, unit: 'hour' }, age_high: { value: 1, unit: 'day' } }, '/bands/0/age_high'],
    ['negative age from', { age_low: { value: -1, unit: 'year' } }, '/bands/0/age_low'], ['unknown age unit', { age_low: { value: 1, unit: 'minute' } }, '/bands/0/age_low'],
    ['sex outside the list', { sex: 'other' }, '/bands/0/sex'],
    ['low above high', { low: '9.0', high: '3.0' }, '/bands/0/low'],
    ['auto approved low above auto approved high', { auto_approved_low: '5.0', auto_approved_high: '4.0' }, '/bands/0/auto_approved_low'],
    ['auto approved low below normal low', { auto_approved_low: '3.0', auto_approved_high: '5.0' }, '/bands/0/auto_approved_low'],
    ['auto approved high above normal high', { auto_approved_low: '4.0', auto_approved_high: '6.0' }, '/bands/0/auto_approved_high'],
    ['auto approved band on a band with no normal limits', { kind: 'text', low: undefined, high: undefined, display_text: 'Negative', auto_approved_low: '1', auto_approved_high: '2' }, '/bands/0/auto_approved_low'],
    ['auto approved not a decimal', { auto_approved_low: 'x' }, '/bands/0/auto_approved_low'],
    ['instrument_id not a uuid', { instrument_id: 'machine-1' }, '/bands/0/instrument_id'], ['laboratory_id not a uuid', { laboratory_id: 'lab-1' }, '/bands/0/laboratory_id'],
    ['default_range not a boolean', { default_range: 'yes' }, '/bands/0/default_range'], ['method_id not a uuid', { method_id: 'm' }, '/bands/0/method_id'],
    ['an unknown band field', { colour: 'red' }, '/bands/0/colour'],
  ];
  it.each(BAD)('replace: %s', { timeout: T }, async (_n, over, path) => {
    const { s } = await draftReplace();
    await expectInvalid('replaceReferenceRangeSetBands', req({ params: { set_id: s.id }, headers: im(s.version), body: { bands: [band(over)] } }), path);
  });
  it.each(BAD.filter(([, o]) => !('auto_approved_low' in o || 'auto_approved_high' in o || 'instrument_id' in o || 'laboratory_id' in o || 'default_range' in o || 'method_id' in o || 'kind' in o)))('create with bands: %s', { timeout: T }, async (_n, over, path) => {
    const a = await analyte();
    await expectInvalid('createReferenceRangeSetDraft', req({ params: { analyte_id: a.id }, body: { bands: [band(over)] }, headers: { 'idempotency-key': uid() } }), path);
  });
  it('every broken band of a request is reported (not only the first)', { timeout: T }, async () => {
    const { s } = await draftReplace([]);
    const e = await replace(s.id, s.version, [band({ low: '9', high: '1' }), band({ age_low: years(5), age_high: years(1) }), band({ sex: 'x' })]).then(() => undefined, (x) => x);
    expect(e?.code).toBe('common.validation_failed');
    for (const p of ['/bands/0/low', '/bands/1/age_high', '/bands/2/sex']) expect(errPaths(e)).toContain(p);
  });
  it('a method of another tenant is 404 common.not_found', { timeout: T }, async () => {
    const { s } = await draftReplace([]);
    const other = await world(TENANT_B);
    expectCode(await fails('replaceReferenceRangeSetBands', req({ params: { set_id: s.id }, headers: im(s.version), body: { bands: [band({ method_id: other.method.id })] } })), 'common.not_found', 404);
  });
});

describe('(3) exactly one default range per analyte + sex + instrument + laboratory group', () => {
  it('two default bands in one group are rejected at the LATER band; defaults in different sex / instrument / laboratory groups are fine', { timeout: T }, async () => {
    const { s } = await draftReplace([]);
    await expectInvalid('replaceReferenceRangeSetBands', req({ params: { set_id: s.id }, headers: im(s.version), body: { bands: [
      band({ default_range: true, age_high: years(10) }), band({ default_range: true, age_low: years(10), sort_order: 1 })] } }), '/bands/1/default_range');
    const ok = await replace(s.id, s.version, [
      band({ sex: 'male', default_range: true }), band({ sex: 'female', default_range: true, sort_order: 1 }), band({ sex: 'male', instrument_id: INSTR, default_range: true, sort_order: 2 }),
      band({ sex: 'male', laboratory_id: LAB, default_range: true, sort_order: 3 }), band({ sex: 'third_gender', default_range: true, sort_order: 4 })]);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });
  it('publish: a set that uses default_range / instrument / laboratory needs exactly one default in EVERY group (none is rejected at the first band of the group)', { timeout: T }, async () => {
    const a = await analyte();
    const s = await mkRangeDraft(a.id, [band({ sex: 'male', default_range: true }), band({ sex: 'female', instrument_id: INSTR, sort_order: 1 })]);
    await expectInvalid('publishReferenceRangeSet', req({ params: { set_id: s.id }, headers: im(s.version), body: { change_reason: 'x' } }), '/bands/1/default_range');
    expect((await ownerRows('catalog.reference_range_sets', 'id = $1', [s.id]))[0].status).toBe('draft');
    const fixed = await replace(s.id, s.version, [band({ sex: 'male', default_range: true }), band({ sex: 'female', instrument_id: INSTR, default_range: true, sort_order: 1 })]);
    const p = await publish(s.id, fixed.body.version);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.status).toBe('published');
  });
  it('publish: a set that uses none of the new fields publishes as before (no default needed)', { timeout: T }, async () => {
    const a = await analyte();
    const s = await mkRangeDraft(a.id, [band({ sex: 'male' }), band({ sex: 'female', sort_order: 1 })]);
    expect((await publish(s.id, s.version)).status).toBe(200);
  });
});

describe('(3) no overlapping age bands for the same group (publish)', () => {
  const overlap = (a: object, b: object) => ({ bands: [band({ ...a }), band({ ...b, sort_order: 1 })] });   // no default_range: the set uses none of the new fields
  it('same sex + instrument + laboratory with overlapping ages (0-5 and 3-10 years) is refused at both bands; a set that touches (0-5 and 5-10) publishes', { timeout: T }, async () => {
    const a = await analyte();
    const s = await mkRangeDraft(a.id, overlap({ age_high: years(5) }, { age_low: years(3), age_high: years(10) }).bands);
    const e = await publish(s.id, s.version).then(() => undefined, (x) => x);
    expect(e?.code).toBe('common.validation_failed');
    for (const p of ['/bands/0', '/bands/1']) expect(errPaths(e)).toContain(p);
    const t = await replace(s.id, s.version, overlap({ age_high: years(5) }, { age_low: years(5), age_high: years(10) }).bands);
    expect((await publish(s.id, t.body.version)).status).toBe(200);
  });
  it('overlap is judged in hours across units: 0-48 hours and 1 day-1 month overlap, 0-24 hours and 1 day-1 month do not', { timeout: T }, async () => {
    const a = await analyte();
    const s = await mkRangeDraft(a.id, overlap({ age_high: { value: 48, unit: 'hour' } }, { age_low: { value: 1, unit: 'day' }, age_high: { value: 1, unit: 'month' } }).bands);
    expect(errPaths(await publish(s.id, s.version).then(() => undefined, (x) => x))).toContain('/bands/0');
    const t = await replace(s.id, s.version, overlap({ age_high: { value: 24, unit: 'hour' } }, { age_low: { value: 1, unit: 'day' }, age_high: { value: 1, unit: 'month' } }).bands);
    expect((await publish(s.id, t.body.version)).status).toBe(200);
  });
  it('overlapping ages of DIFFERENT groups are fine: other sex, other instrument, other laboratory', { timeout: T }, async () => {
    const a = await analyte();
    const bands = [
      band({ sex: 'male', default_range: true }), band({ sex: 'female', default_range: true, sort_order: 1 }), band({ sex: 'male', instrument_id: INSTR, default_range: true, sort_order: 2 }),
      band({ sex: 'male', instrument_id: INSTR2, default_range: true, sort_order: 3 }), band({ sex: 'male', laboratory_id: LAB, default_range: true, sort_order: 4 }),
      band({ sex: 'male', laboratory_id: LAB2, default_range: true, sort_order: 5 })];
    const s = await mkRangeDraft(a.id, bands);
    const p = await publish(s.id, s.version);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
  });
});

describe('(3) critical outside normal', () => {
  async function withNormal() {
    const a = await analyte();
    const n = await mkRangeDraft(a.id, [band({ low: '3.5', high: '5.5' })]);
    const c = (await call('createCriticalLimitSetDraft', req({ params: { analyte_id: a.id }, body: {}, headers: { 'idempotency-key': uid() } }))).body;
    return { a, n, c };
  }
  it('critical low inside / at the normal low and critical high inside / at the normal high are rejected with the band path; outside is accepted', { timeout: T }, async () => {
    const { c } = await withNormal();
    const at = (b: object) => req({ params: { set_id: c.id }, headers: im(c.version), body: { bands: [{ sex: 'any', ...b }] } });
    await expectInvalid('replaceCriticalLimitSetBands', at({ low: '4.0', high: '8.0' }), '/bands/0/low');
    await expectInvalid('replaceCriticalLimitSetBands', at({ low: '3.5', high: '8.0' }), '/bands/0/low');
    await expectInvalid('replaceCriticalLimitSetBands', at({ low: '2.0', high: '5.0' }), '/bands/0/high');
    await expectInvalid('replaceCriticalLimitSetBands', at({ low: '2.0', high: '5.5' }), '/bands/0/high');
    const ok = await replaceCrit(c.id, c.version, [{ sex: 'any', low: '2.5', high: '7.0' }]);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const lowOnly = await replaceCrit(c.id, ok.body.version, [{ sex: 'any', low: '2.0' }]);
    expect(lowOnly.status).toBe(200);
  });
  it('a critical band for one sex is compared with the normal band of that sex (and with a normal band for any sex); a band of another sex is not', { timeout: T }, async () => {
    const a = await analyte();
    await mkRangeDraft(a.id, [band({ sex: 'female', low: '3.0', high: '5.0' }), band({ sex: 'male', low: '4.0', high: '6.0', sort_order: 1 })]);
    const c = (await call('createCriticalLimitSetDraft', req({ params: { analyte_id: a.id }, body: {}, headers: { 'idempotency-key': uid() } }))).body;
    await expectInvalid('replaceCriticalLimitSetBands', req({ params: { set_id: c.id }, headers: im(c.version), body: { bands: [{ sex: 'female', low: '3.5', high: '9' }] } }), '/bands/0/low');
    expect((await replaceCrit(c.id, c.version, [{ sex: 'female', low: '2.0', high: '9' }])).status).toBe(200);
  });
  it('publishCriticalLimitSet checks again against the reference set in force then: a normal band widened after the critical draft was written is refused', { timeout: T }, async () => {
    const { a, n, c } = await withNormal();
    const ok = await replaceCrit(c.id, c.version, [{ sex: 'any', low: '3.0', high: '6.0' }]);
    expect(ok.status).toBe(200);
    const wider = await replace(n.id, n.version, [band({ low: '2.0', high: '7.0' })]);
    expect(wider.status).toBe(200);
    expect((await publish(n.id, wider.body.version)).status).toBe(200);
    await expectInvalid('publishCriticalLimitSet', req({ params: { set_id: c.id }, headers: im(ok.body.version), body: { change_reason: 'x' } }), '/bands/0/low');
    expect((await ownerRows('catalog.critical_limit_sets', 'id = $1 AND analyte_id = $2', [c.id, a.id]))[0].status).toBe('draft');
  });
  it('an analyte with no reference set: nothing to compare, any critical band that passes the old rules is accepted', { timeout: T }, async () => {
    const a = await analyte();
    const c = (await call('createCriticalLimitSetDraft', req({ params: { analyte_id: a.id }, body: {}, headers: { 'idempotency-key': uid() } }))).body;
    expect((await replaceCrit(c.id, c.version, [{ sex: 'any', low: '4.0', high: '5.0' }])).status).toBe(200);
  });
});

describe('(4) ranges stay behind the draft + publish gate; (7) isolation and audit', () => {
  it('publishing needs catalog.reference_range.publish: without it 403 auth.forbidden, the set stays a draft and nothing is written', { timeout: T }, async () => {
    const a = await analyte();
    const s = await mkRangeDraft(a.id, [band()]);
    expectCode(await fails('publishReferenceRangeSet', req({ params: { set_id: s.id }, headers: im(s.version), body: { change_reason: 'x' } }), { grants: ['catalog.test.manage', 'catalog.test.read'] }), 'auth.forbidden', 403);
    expect((await ownerRows('catalog.reference_range_sets', 'id = $1', [s.id]))[0].status).toBe('draft');
  });
  it('a published set is immutable: replacing its bands is 409 catalog.version_in_use and the stored bands do not change', { timeout: T }, async () => {
    const a = await analyte();
    const s = await mkRangeDraft(a.id, [band({ default_range: true })]);
    const p = await publish(s.id, s.version);
    const before = JSON.stringify(await ownerRows('catalog.reference_ranges', 'set_id = $1', [s.id]));
    expectCode(await fails('replaceReferenceRangeSetBands', req({ params: { set_id: s.id }, headers: im(p.body.version), body: { bands: [band({ low: '1', high: '2' })] } })), 'catalog.version_in_use', 409);
    expect(JSON.stringify(await ownerRows('catalog.reference_ranges', 'set_id = $1', [s.id]))).toBe(before);
  });
  it('a new band value reaches the live range only after the new set is published: the published set keeps the old values until then', { timeout: T }, async () => {
    const a = await analyte();
    const s1 = await mkRangeDraft(a.id, [band({ low: '3.5', high: '5.5' })]);
    await publish(s1.id, s1.version);
    const s2 = (await call('createReferenceRangeSetDraft', req({ params: { analyte_id: a.id }, body: {}, headers: { 'idempotency-key': uid() } }))).body;
    const r2 = await replace(s2.id, s2.version, [band({ low: '7.5', high: '9.5' })]);
    expect(r2.status).toBe(200);
    const live = await call('listReferenceRangeSets', req({ params: { analyte_id: a.id }, query: { status: 'published' } }));
    expect(live.body.data).toHaveLength(1);
    expect(live.body.data[0].bands[0]).toMatchObject({ low: expect.stringMatching(/^3\.5/) });
  });
  it('publish writes an audit line on the set (status draft -> published) and the band rows carry the tenant; another tenant gets 404 on read, replace and publish', { timeout: T }, async () => {
    const a = await analyte();
    const s = await mkRangeDraft(a.id, [band({ default_range: true })]);
    await publish(s.id, s.version);
    const audit = (await auditRows('reference_range_sets', s.id)).filter((x: any) => x.action === 'UPDATE');
    expect(audit.some((x: any) => x.changed_columns.includes('status') && x.new_values.status === 'published')).toBe(true);
    expect((await ownerRows('catalog.reference_ranges', 'set_id = $1', [s.id])).every((x: any) => x.tenant_id === TENANT_A)).toBe(true);
    expectCode(await fails('getReferenceRangeSet', req({ params: { set_id: s.id } }), { tenant: TENANT_B }), 'common.not_found', 404);
    expectCode(await fails('replaceReferenceRangeSetBands', req({ params: { set_id: s.id }, headers: im(3), body: { bands: [band()] } }), { tenant: TENANT_B }), 'common.not_found', 404);
    expectCode(await fails('publishReferenceRangeSet', req({ params: { set_id: s.id }, headers: im(3), body: { change_reason: 'x' } }), { tenant: TENANT_B }), 'common.not_found', 404);
    expect(await dbRow('reference_range_sets', s.id)).toMatchObject({ tenant_id: TENANT_A });
  });
});
