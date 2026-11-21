// T0B-PARTYSET-1 done_when (2) validation + (3 data side) getPartyCommercialSetting / setPartyCommercialSetting, tenant isolation, If-Match. Real PG17.
// Pins: unsaved party = defaults (is_default true, version 1, no id, auto_release_reports false, tds_bp 0, auto_block_overdue false); first PUT needs no If-Match;
// an unknown / foreign party = common.not_found; every rule failure is common.validation_failed with a field path and NO write attempted (domain layer).
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_A, ADMIN_B, P, T, TENANT_A, TENANT_B, dbRows, fire, ifm, mkCreditParty, mkDoctor, mkPartner, mkSetting, noWrites, notFound, ok, rejected, rejectedAny, req, wipe, only } from './helpers.js';

const get = (kind: string, id: string, who = ADMIN_A) => fire('getPartyCommercialSetting', req({ params: { party_kind: kind, party_id: id } }), who);
const put = (kind: string, id: string, body: unknown, headers: object = {}, who = ADMIN_A) => fire('setPartyCommercialSetting', req({ params: { party_kind: kind, party_id: id }, headers, body }), who);
const rows = (party: string) => dbRows('partners.party_commercial_setting', 'party_id = $1', [party]);

beforeEach(async () => { await wipe(TENANT_A, TENANT_B); }, T);

describe('getPartyCommercialSetting', () => {
  it('an unsaved party answers the defaults, is_default true, version 1, and writes nothing', async () => {
    const cp = await mkCreditParty(TENANT_A);
    const o = await get('credit_party', cp.id);
    const b = ok(o);
    expect(b).toMatchObject({ party_kind: 'credit_party', party_id: cp.id, is_default: true, version: 1, auto_release_reports: false, tds_bp: 0, auto_block_overdue: false });
    expect(b.id).toBeUndefined();
    expect(['daily', 'weekly', 'fortnightly', 'monthly', 'quarterly']).toContain(b.billing_cycle);
    expect(['P1', 'P2', 'P3', 'P4', 'P5']).toContain(b.priority);
    expect(['with', 'without', 'both']).toContain(b.header_footer_mode);
    expect(o.probe.writes).toEqual([]);
    expect(await rows(cp.id)).toHaveLength(0);
  }, T);
  it('a saved row is answered with is_default false and its id', async () => {
    const cp = await mkCreditParty(TENANT_A);
    const s = await mkSetting(TENANT_A, 'credit_party', cp.id, { commission_bp: 1250, priority: 'P2' });
    expect(ok(await get('credit_party', cp.id))).toMatchObject({ id: s.id, is_default: false, commission_bp: 1250, priority: 'P2', version: 1 });
  }, T);
  it.each([['credit_party', mkCreditParty], ['partner', mkPartner], ['doctor', mkDoctor]] as const)('works for party kind %s', async (kind, make) => {
    const p = await (make as (t: string) => Promise<any>)(TENANT_A);
    expect(ok(await get(kind, p.id))).toMatchObject({ party_kind: kind, party_id: p.id, is_default: true });
  }, T);
  it('unknown id (every kind) and a party of another tenant are common.not_found, and tenant B cannot read tenant A saved settings', async () => {
    for (const kind of ['partner', 'credit_party', 'doctor', 'referrer']) notFound(await get(kind, '01a1a98a-ac40-7000-8000-00000000dead'));
    const cp = await mkCreditParty(TENANT_A);
    await mkSetting(TENANT_A, 'credit_party', cp.id);
    notFound(await get('credit_party', cp.id, ADMIN_B));
  }, T);
  it('needs partners.party_setting.read', async () => {
    const cp = await mkCreditParty(TENANT_A);
    rejected(await get('credit_party', cp.id, only(1, P.settingManage)), 'auth.forbidden');
    ok(await get('credit_party', cp.id, only(2, P.settingRead)));
  }, T);
});

describe('setPartyCommercialSetting: save, update, If-Match', () => {
  const FULL = { auto_release_reports: true, whatsapp_enabled: true, insurance_enabled: true, print_exception: true, lab_number_scheme_code: 'KTM_A', billing_cycle: 'quarterly',
    invoice_payment_days: 30, invoice_blocking_days: 60, invoice_warning_days: 45, interest_bp_per_day: 5, priority: 'P1', header_footer_mode: 'without', commission_bp: 1250, tds_bp: 100, auto_block_overdue: true };
  it('the first save needs no If-Match, creates ONE row, answers 200 with every field and version 1', async () => {
    const cp = await mkCreditParty(TENANT_A);
    const b = ok(await put('credit_party', cp.id, FULL));
    expect(b).toMatchObject({ ...FULL, party_kind: 'credit_party', party_id: cp.id, is_default: false, version: 1 });
    expect(typeof b.id).toBe('string');
    const r = await rows(cp.id);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ billing_cycle: 'quarterly', invoice_blocking_days: 60, interest_bp_per_day: 5, tds_bp: 100, auto_block_overdue: true, header_footer_mode: 'without' });
  }, T);
  it('an omitted field keeps its saved value; the response carries the new version', async () => {
    const cp = await mkCreditParty(TENANT_A);
    const a = ok(await put('credit_party', cp.id, FULL));
    const b = ok(await put('credit_party', cp.id, { commission_bp: 900 }, ifm(a.version)));
    expect(b).toMatchObject({ ...FULL, commission_bp: 900, version: 2, id: a.id });
    expect(await rows(cp.id)).toHaveLength(1);
  }, T);
  it('on the first save an omitted field takes the default (same value the GET answered)', async () => {
    const cp = await mkCreditParty(TENANT_A);
    const d = ok(await get('credit_party', cp.id));
    const b = ok(await put('credit_party', cp.id, { commission_bp: 100 }));
    for (const k of ['billing_cycle', 'priority', 'header_footer_mode', 'invoice_payment_days', 'invoice_blocking_days', 'invoice_warning_days', 'interest_bp_per_day', 'auto_release_reports', 'tds_bp', 'auto_block_overdue'])
      expect(b[k], k).toEqual(d[k]);
  }, T);
  it('unset ["lab_number_scheme_code"] clears the scheme code', async () => {
    const cp = await mkCreditParty(TENANT_A);
    const a = ok(await put('credit_party', cp.id, { lab_number_scheme_code: 'KTM_A' }));
    const b = ok(await put('credit_party', cp.id, { unset: ['lab_number_scheme_code'] }, ifm(a.version)));
    expect(b.lab_number_scheme_code ?? null).toBeNull();
    expect((await rows(cp.id))[0].lab_number_scheme_code).toBeNull();
  }, T);
  it('a stale If-Match is common.version_conflict and changes nothing; a second save without If-Match is refused', async () => {
    const cp = await mkCreditParty(TENANT_A);
    const a = ok(await put('credit_party', cp.id, { commission_bp: 100 }));
    ok(await put('credit_party', cp.id, { commission_bp: 200 }, ifm(a.version)));
    rejected(await put('credit_party', cp.id, { commission_bp: 300 }, ifm(a.version)), 'common.version_conflict');
    rejectedAny(await put('credit_party', cp.id, { commission_bp: 400 }), ['common.precondition_required', 'common.version_conflict']);
    expect((await rows(cp.id))[0]).toMatchObject({ commission_bp: 200, version: 2 });
  }, T);
  it('two concurrent first saves of one party leave exactly one row (the other is a conflict or a plain update)', async () => {
    const cp = await mkCreditParty(TENANT_A);
    const outs = await Promise.all([1, 2, 3, 4].map((n) => put('credit_party', cp.id, { commission_bp: n * 100 })));
    expect(outs.filter((o) => o.reply?.status === 200).length).toBeGreaterThanOrEqual(1);
    for (const o of outs) if (o.error) rejectedAny(o, ['common.version_conflict', 'common.precondition_required']);
    expect(await rows(cp.id)).toHaveLength(1);
  }, T);
  it('unknown party and a party of another tenant are common.not_found and write nothing; tenant B can use its own party', async () => {
    const cp = await mkCreditParty(TENANT_A);
    const o = await put('credit_party', cp.id, { commission_bp: 1 }, {}, ADMIN_B);
    notFound(o);
    expect(await rows(cp.id)).toHaveLength(0);
    notFound(await put('partner', '01a1a98a-ac40-7000-8000-00000000dead', { commission_bp: 1 }));
    const own = await mkCreditParty(TENANT_B);
    ok(await put('credit_party', own.id, { commission_bp: 1 }, {}, ADMIN_B));
  }, T);
  it('needs partners.party_setting.manage (read is not enough)', async () => {
    const cp = await mkCreditParty(TENANT_A);
    rejected(await put('credit_party', cp.id, { commission_bp: 1 }, {}, only(3, P.settingRead)), 'auth.forbidden');
    expect(await rows(cp.id)).toHaveLength(0);
  }, T);
});

describe('setPartyCommercialSetting: validation in the domain layer (path of the field, no write)', () => {
  const bad: Array<[string, unknown]> = [
    ['invoice_payment_days', -1], ['invoice_payment_days', 366], ['invoice_payment_days', 1.5], ['invoice_payment_days', '30'], ['invoice_payment_days', null],
    ['invoice_blocking_days', -1], ['invoice_blocking_days', 366], ['invoice_blocking_days', 0.5],
    ['invoice_warning_days', -1], ['invoice_warning_days', 366], ['invoice_warning_days', Number.NaN],
    ['interest_bp_per_day', -1], ['interest_bp_per_day', 10001], ['interest_bp_per_day', 1.1],
    ['commission_bp', -1], ['commission_bp', 10001], ['commission_bp', '1250'],
    ['tds_bp', -1], ['tds_bp', 10001],
    ['billing_cycle', 'yearly'], ['billing_cycle', 'Monthly'], ['billing_cycle', ''], ['billing_cycle', 5],
    ['priority', 'P0'], ['priority', 'P6'], ['priority', 'p1'],
    ['header_footer_mode', 'all'], ['header_footer_mode', 'WITH'],
    ['lab_number_scheme_code', 'lower'], ['lab_number_scheme_code', 'A'.repeat(21)], ['lab_number_scheme_code', ''], ['lab_number_scheme_code', 'A B'],
    ['auto_release_reports', 'true'], ['auto_release_reports', 1], ['whatsapp_enabled', 'yes'], ['insurance_enabled', null], ['print_exception', 0], ['auto_block_overdue', 'on'],
  ];
  it.each(bad)('%s = %j is refused with /%s and nothing is written', async (field, value) => {
    const cp = await mkCreditParty(TENANT_A);
    const o = await put('credit_party', cp.id, { [field]: value });
    rejected(o, 'common.validation_failed', `/${field}`);
    noWrites(o);
    expect(await rows(cp.id)).toHaveLength(0);
  }, T);
  it('an unknown field, a non object body and a body unset of a field that cannot be cleared are refused with a field path', async () => {
    const cp = await mkCreditParty(TENANT_A);
    rejected(await put('credit_party', cp.id, { foo: 1 }), 'common.validation_failed', '*');
    rejected(await put('credit_party', cp.id, { party_id: cp.id }), 'common.validation_failed', '*');
    rejected(await put('credit_party', cp.id, [] as unknown), 'common.validation_failed', '*');
    rejected(await put('credit_party', cp.id, { unset: ['priority'] }), 'common.validation_failed', '*');
    rejected(await put('credit_party', cp.id, { unset: ['lab_number_scheme_code', 'lab_number_scheme_code'] }), 'common.validation_failed', '*');
  }, T);
  it('every bad field is reported in one answer', async () => {
    const cp = await mkCreditParty(TENANT_A);
    const e: any = rejected(await put('credit_party', cp.id, { invoice_payment_days: 400, commission_bp: 20000, priority: 'P9' }));
    expect(e.errors.map((x: any) => x.path).sort()).toEqual(['/commission_bp', '/invoice_payment_days', '/priority']);
  }, T);
  it('the limits themselves are valid: day counts 0 and 365, basis points 0 and 10000', async () => {
    const cp = await mkCreditParty(TENANT_A);
    const lo = ok(await put('credit_party', cp.id, { invoice_payment_days: 0, invoice_blocking_days: 0, invoice_warning_days: 0, interest_bp_per_day: 0, commission_bp: 0, tds_bp: 0 }));
    expect(lo).toMatchObject({ invoice_payment_days: 0, invoice_blocking_days: 0, invoice_warning_days: 0, interest_bp_per_day: 0, commission_bp: 0, tds_bp: 0 });
    const hi = ok(await put('credit_party', cp.id, { invoice_payment_days: 365, invoice_blocking_days: 365, invoice_warning_days: 365, interest_bp_per_day: 10000, commission_bp: 10000, tds_bp: 10000 }, ifm(lo.version)));
    expect(hi).toMatchObject({ invoice_payment_days: 365, invoice_blocking_days: 365, invoice_warning_days: 365, interest_bp_per_day: 10000, commission_bp: 10000, tds_bp: 10000, version: 2 });
  }, T);
  it('every enum value is accepted', async () => {
    const cp = await mkCreditParty(TENANT_A);
    let v = 0;
    for (const c of ['daily', 'weekly', 'fortnightly', 'monthly', 'quarterly']) { const b = ok(await put('credit_party', cp.id, { billing_cycle: c }, v ? ifm(v) : {})); v = b.version; expect(b.billing_cycle).toBe(c); }
    for (const c of ['P1', 'P2', 'P3', 'P4', 'P5']) { const b = ok(await put('credit_party', cp.id, { priority: c }, ifm(v))); v = b.version; expect(b.priority).toBe(c); }
    for (const c of ['with', 'without', 'both']) { const b = ok(await put('credit_party', cp.id, { header_footer_mode: c }, ifm(v))); v = b.version; expect(b.header_footer_mode).toBe(c); }
  }, T);
});
