// C13 T04 — manifest line validation (03-APP-FLOW §4.1 M5/M8 + §2.6; 02-TRD §5.1 field limits; US-04.2/3/4/8; 07-SECURITY: no PHI echoed in errors).
// SEAMS: ../../domain/line-validation.ts exports (pure, collects ALL issues, never throws on bad input)
//   validateLine(input, ctx): LineIssue[]                       LineIssue = { path: string (JSON pointer), code: string } — nothing else (no submitted value)
//   validateManifestForSubmit(lines: input[], ctx): LineIssue[]  (M8: empty -> /lines; pointers are /lines/<0-based index>/…; reports every line at once)
//   ctx = { today: 'YYYY-MM-DD' (tenant tz), now: Date, offeredOrderableIds: ReadonlySet<string>,
//           referrers: ReadonlyMap<string, { isActive: boolean }> (this partner's only), otherSampleRefs: ReadonlySet<string> (other lines of the manifest),
//           adding: boolean (true = M5 POST, line-limit applies), lineCountBefore: number, maxLines: number }
//   Issue codes: 'common.validation_failed' (shape/limits), 'partners.orderable_not_offered' (path /orderable_ids/<i>, one per id),
//   'partners.manifest_invalid' (line limit /lines; duplicate /partner_sample_ref; inactive referrer /referrer_id),
//   'common.not_found' (/referrer_id unknown to this partner — never reveal another partner's referrer).
// Input (camelCase of ManifestLineInput): { partnerSampleRef?, patient: { fullName, sex, birthOn?, ageYears?, phoneE164? },
//   consents: { sms, whatsapp, email, shareWithReferrer }, orderableIds, priority, referrerId?, collectedAt?, clinicalNote? }.
// Fails now: ../../domain/line-validation.js does not exist.
import { describe, expect, it } from 'vitest';
import { validateLine, validateManifestForSubmit } from '../../domain/line-validation.js';

const NOW = new Date('2026-11-13T06:00:00Z');
const ctx = (over: Record<string, unknown> = {}) => ({
  today: '2026-11-13', now: NOW, offeredOrderableIds: new Set(['t1', 't2', 't3']), otherSampleRefs: new Set<string>(),
  referrers: new Map([['r-active', { isActive: true }], ['r-off', { isActive: false }]]), adding: true, lineCountBefore: 0, maxLines: 200, ...over,
}) as any;
const line = (over: Record<string, unknown> = {}, patient: Record<string, unknown> = {}) => ({
  partnerSampleRef: 'BOX-1/A', patient: { fullName: 'Test Patient One', sex: 'female', ageYears: 34, phoneE164: '+9779800000000', ...patient },
  consents: { sms: true, whatsapp: false, email: false, shareWithReferrer: false }, orderableIds: ['t1'], priority: 'routine', ...over,
}) as any;
const issues = (l: any, c: any = ctx()) => validateLine(l, c) as Array<{ path: string; code: string }>;
const has = (l: any, path: string, code = 'common.validation_failed', c: any = ctx()) =>
  expect(issues(l, c), `${path} ${code}`).toEqual(expect.arrayContaining([{ path, code }]));

describe('baseline', () => {
  it('a valid line has no issues', () => expect(issues(line())).toEqual([]));
  it('optional fields may be absent', () => {
    const l = line(); delete l.partnerSampleRef; delete l.patient.phoneE164;
    expect(issues(l)).toEqual([]);
  });
});

describe('patient block', () => {
  it('full_name 1–120', () => {
    expect(issues(line({}, { fullName: 'A' }))).toEqual([]);
    expect(issues(line({}, { fullName: 'x'.repeat(120) }))).toEqual([]);
    has(line({}, { fullName: '' }), '/patient/full_name');
    has(line({}, { fullName: 'x'.repeat(121) }), '/patient/full_name');
    has(line({}, { fullName: undefined }), '/patient/full_name');
  });
  it.each(['male', 'female', 'other', 'unknown'])('sex %s ok', (sex) => expect(issues(line({}, { sex }))).toEqual([]));
  it.each(['M', 'Female', '', 'x'])('sex %j rejected', (sex) => has(line({}, { sex }), '/patient/sex'));

  it('exactly one of birth_on / age_years', () => {
    expect(issues(line({}, { ageYears: undefined, birthOn: '1990-05-05' }))).toEqual([]);
    const both = issues(line({}, { ageYears: 30, birthOn: '1990-05-05' }));
    const neither = issues(line({}, { ageYears: undefined }));
    for (const r of [both, neither]) {
      expect(r.length).toBeGreaterThan(0);
      expect(r.every((i) => i.path.startsWith('/patient') && i.code === 'common.validation_failed')).toBe(true);
    }
  });
  it('age_years 0–130 integer', () => {
    expect(issues(line({}, { ageYears: 0 }))).toEqual([]);
    expect(issues(line({}, { ageYears: 130 }))).toEqual([]);
    for (const ageYears of [-1, 131, 1.5, Number.NaN]) has(line({}, { ageYears }), '/patient/age_years');
  });
  it('birth_on >= 1900-01-01 and <= today, real calendar date', () => {
    const b = (birthOn: string) => line({}, { ageYears: undefined, birthOn });
    expect(issues(b('1900-01-01'))).toEqual([]);
    expect(issues(b('2026-11-13'))).toEqual([]); // today
    has(b('1899-12-31'), '/patient/birth_on');
    has(b('2026-11-14'), '/patient/birth_on'); // future
    has(b('2026-02-30'), '/patient/birth_on'); // not a date
    has(b('13/11/2026'), '/patient/birth_on'); // not ISO
  });
  it('phone_e164 ^\\+[1-9][0-9]{7,14}$', () => {
    expect(issues(line({}, { phoneE164: '+12345678' }))).toEqual([]);
    expect(issues(line({}, { phoneE164: '+123456789012345' }))).toEqual([]);
    for (const phoneE164 of ['9779800000000', '+0123456789', '+1234567', '+1234567890123456', '+97798 00000000', '+9779800000000a'])
      has(line({}, { phoneE164 }), '/patient/phone_e164');
  });
});

describe('consents', () => {
  it('all four attestations must be booleans', () => {
    for (const k of ['sms', 'whatsapp', 'email', 'shareWithReferrer']) {
      const c = { sms: true, whatsapp: true, email: true, shareWithReferrer: true } as Record<string, unknown>;
      c[k] = 'yes';
      expect(issues(line({ consents: c })).some((i) => i.path.startsWith('/consents'))).toBe(true);
      delete c[k];
      expect(issues(line({ consents: c })).some((i) => i.path.startsWith('/consents'))).toBe(true);
    }
    expect(issues(line({ consents: undefined })).some((i) => i.path.startsWith('/consents'))).toBe(true);
  });
});

describe('orderables (US-04.3)', () => {
  it('1–30 ids', () => {
    has(line({ orderableIds: [] }), '/orderable_ids');
    const ids = Array.from({ length: 31 }, (_, i) => `o${i}`);
    const c30 = ctx({ offeredOrderableIds: new Set(ids) });
    expect(issues(line({ orderableIds: ids.slice(0, 30) }), c30)).toEqual([]);
    has(line({ orderableIds: ids }), '/orderable_ids', 'common.validation_failed', c30);
  });
  it('ids must be unique', () => has(line({ orderableIds: ['t1', 't1'] }), '/orderable_ids'));
  it('not offered -> partners.orderable_not_offered, one issue per offending id with its index', () => {
    const r = issues(line({ orderableIds: ['t1', 'nope', 't2', 'nada'] }));
    expect(r).toEqual(expect.arrayContaining([{ path: '/orderable_ids/1', code: 'partners.orderable_not_offered' },
      { path: '/orderable_ids/3', code: 'partners.orderable_not_offered' }]));
    expect(r.filter((i) => i.code === 'partners.orderable_not_offered')).toHaveLength(2);
  });
  it('an empty offered set (price list not synced / default list excluded) rejects every id', () => {
    const r = issues(line({ orderableIds: ['t1'] }), ctx({ offeredOrderableIds: new Set() }));
    expect(r).toEqual([{ path: '/orderable_ids/0', code: 'partners.orderable_not_offered' }]);
  });
  it('prototype-ish ids are just not offered', () => {
    const r = issues(line({ orderableIds: ['__proto__', 'constructor'] }));
    expect(r.filter((i) => i.code === 'partners.orderable_not_offered')).toHaveLength(2);
  });
  it('priority routine|urgent', () => {
    expect(issues(line({ priority: 'urgent' }))).toEqual([]);
    for (const priority of ['stat', '', 'ROUTINE', undefined]) has(line({ priority }), '/priority');
  });
});

describe('partner_sample_ref', () => {
  it('1–40 chars of [A-Za-z0-9_./-]', () => {
    expect(issues(line({ partnerSampleRef: 'a'.repeat(40) }))).toEqual([]);
    expect(issues(line({ partnerSampleRef: 'Aa0_./-' }))).toEqual([]);
    for (const partnerSampleRef of ['', 'a'.repeat(41), 'has space', 'semi;colon', "quo'te", 'ünï']) has(line({ partnerSampleRef }), '/partner_sample_ref');
  });
  it('unique within the manifest -> partners.manifest_invalid', () =>
    has(line({ partnerSampleRef: 'DUP-1' }), '/partner_sample_ref', 'partners.manifest_invalid', ctx({ otherSampleRefs: new Set(['DUP-1']) })));
});

describe('referrer', () => {
  it('active referrer of this partner ok; none ok', () => {
    expect(issues(line({ referrerId: 'r-active' }))).toEqual([]);
    expect(issues(line({ referrerId: undefined }))).toEqual([]);
  });
  it('unknown / another partner\'s referrer -> common.not_found at /referrer_id', () =>
    has(line({ referrerId: 'r-of-partner-Y' }), '/referrer_id', 'common.not_found'));
  it('inactive referrer cannot be chosen -> partners.manifest_invalid at /referrer_id (03-APP-FLOW §2.6)', () =>
    has(line({ referrerId: 'r-off' }), '/referrer_id', 'partners.manifest_invalid'));
});

describe('free text and timestamps', () => {
  it('clinical_note <= 300', () => {
    expect(issues(line({ clinicalNote: 'n'.repeat(300) }))).toEqual([]);
    has(line({ clinicalNote: 'n'.repeat(301) }), '/clinical_note');
  });
  it('collected_at not later than now + 5 min (A13 P-1)', () => {
    expect(issues(line({ collectedAt: '2026-11-13T05:00:00Z' }))).toEqual([]);
    expect(issues(line({ collectedAt: '2026-11-13T06:05:00Z' }))).toEqual([]); // exactly now + 5 min
    has(line({ collectedAt: '2026-11-13T06:05:01Z' }), '/collected_at');
    has(line({ collectedAt: 'not-a-date' }), '/collected_at');
  });
});

describe('line limit (US-04.8)', () => {
  it('adding at max -> partners.manifest_invalid at /lines', () => {
    has(line(), '/lines', 'partners.manifest_invalid', ctx({ lineCountBefore: 200, maxLines: 200 }));
    expect(issues(line(), ctx({ lineCountBefore: 199, maxLines: 200 }))).toEqual([]);
    has(line(), '/lines', 'partners.manifest_invalid', ctx({ lineCountBefore: 3, maxLines: 3 }));
  });
  it('replacing an existing line (adding=false) is not limited', () =>
    expect(issues(line(), ctx({ adding: false, lineCountBefore: 200, maxLines: 200 }))).toEqual([]));
});

describe('error hygiene', () => {
  it('collects every problem at once (no short circuit)', () => {
    const r = issues(line({ priority: 'x', orderableIds: ['zzz'] }, { sex: 'q', fullName: '' }));
    const paths = r.map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(['/patient/sex', '/patient/full_name', '/priority', '/orderable_ids/0']));
  });
  it('issues carry only path + code and never echo submitted values (PHI)', () => {
    const l = line({ clinicalNote: 'z'.repeat(301), partnerSampleRef: 'BAD REF', referrerId: 'r-secret-id' }, { fullName: 'Secret Patient Name', phoneE164: '123' });
    const r = issues(l);
    expect(r.length).toBeGreaterThan(0);
    for (const i of r) expect(Object.keys(i).sort()).toEqual(['code', 'path']);
    const dump = JSON.stringify(r);
    for (const leak of ['Secret Patient Name', '123', 'BAD REF', 'r-secret-id', 'zzzz']) expect(dump).not.toContain(leak);
  });
  it('does not throw or mutate on hostile input', () => {
    const hostile = { patient: null, consents: 7, orderableIds: 'x', priority: {}, partnerSampleRef: [], referrerId: 5 } as any;
    expect(() => validateLine(hostile, ctx())).not.toThrow();
    expect(issues(hostile).length).toBeGreaterThan(0);
    expect(() => validateLine(undefined as any, ctx())).not.toThrow();
    expect(() => validateLine({} as any, ctx())).not.toThrow();
    const frozen = Object.freeze(line());
    expect(() => validateLine(frozen, ctx())).not.toThrow();
  });
});

describe('validateManifestForSubmit (M8, US-04.4)', () => {
  const sctx = (over: Record<string, unknown> = {}) => ctx({ adding: false, ...over });
  it('0 lines -> partners.manifest_invalid at /lines', () =>
    expect(validateManifestForSubmit([], sctx())).toEqual([{ path: '/lines', code: 'partners.manifest_invalid' }]));
  it('all valid -> no issues', () => expect(validateManifestForSubmit([line(), line({ partnerSampleRef: 'B2' })], sctx())).toEqual([]));
  it('reports every bad line at once with /lines/<index>/… pointers', () => {
    const r = validateManifestForSubmit([line(), line({ orderableIds: ['gone'] }), line(), line({ priority: 'x' }, { sex: 'q' })], sctx()) as any[];
    expect(r).toEqual(expect.arrayContaining([
      { path: '/lines/1/orderable_ids/0', code: 'partners.orderable_not_offered' },
      { path: '/lines/3/priority', code: 'common.validation_failed' },
      { path: '/lines/3/patient/sex', code: 'common.validation_failed' },
    ]));
    expect(r.some((i) => i.path.startsWith('/lines/0') || i.path.startsWith('/lines/2'))).toBe(false);
  });
  it('more lines than the tenant limit -> partners.manifest_invalid at /lines', () =>
    expect(validateManifestForSubmit([line(), line(), line()], sctx({ maxLines: 2 }))).toEqual(
      expect.arrayContaining([{ path: '/lines', code: 'partners.manifest_invalid' }])));
  it('an orderable removed from the price list after the line was saved is caught at submit', () =>
    expect(validateManifestForSubmit([line({ orderableIds: ['t1'] })], sctx({ offeredOrderableIds: new Set(['t2']) }))).toEqual(
      [{ path: '/lines/0/orderable_ids/0', code: 'partners.orderable_not_offered' }]));
});
