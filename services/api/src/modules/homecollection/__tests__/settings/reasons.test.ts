// HC-T04 H20 listHomecollectionReasons. 02-TRD §5 H20 (GET /v1/homecollection/reasons?set=<enum>, `homecollection.visit.read`, response { data: [{ code, display, requires_text, is_active }] } — global seeds only,
// 08 A19 D-130: no tenant overrides, no cs_reasons table, no endpoint writes them), 05-SCHEMA §2 (the eight sets and their codes; `other` is the only requires_text code), contract (set required, enum, maxLength 30).
// Fails now: the operation is an HC-T01 stub (common.internal "not implemented").
import { beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, ADMIN_B, DISPATCHER, P, PHLEBO, REASON_SETS, T, TENANT_A, TENANT_B, as, opOf, reasonTableState, reasons, reasonsFails, responseErrors, seedReasons, superTx } from './helpers.js';

beforeAll(async () => { await seedReasons(); }, T);

describe('H20 happy path', () => {
  it.each(Object.entries(REASON_SETS))('%s: the 05-SCHEMA §2 codes, schema-valid, only the four contract fields, active only, requires_text only on `other`', { timeout: T }, async (set, codes) => {
    const r = await reasons(set);
    expect(r.status).toBe(200);
    expect(responseErrors('listHomecollectionReasons', r.body)).toEqual([]);
    expect(r.body.data.map((x: any) => x.code).sort()).toEqual([...codes].sort());
    for (const x of r.body.data) {
      expect(Object.keys(x).sort()).toEqual(['code', 'display', 'is_active', 'requires_text']);
      expect(typeof x.display).toBe('string'); expect(x.display.length).toBeGreaterThanOrEqual(1); expect(x.display.length).toBeLessThanOrEqual(80);
      expect(x.is_active).toBe(true);
      expect(x.requires_text, x.code).toBe(x.code === 'other');
    }
    expect(Object.keys(r.body)).toEqual(['data']);
  });
  it('the contract enum lists exactly the eight 05-SCHEMA §2 sets (so every set is reachable and nothing else is)', () => {
    const enumValues = opOf('listHomecollectionReasons').parameters.find((p: any) => p.name === 'set').schema.enum;
    expect([...enumValues].sort()).toEqual(Object.keys(REASON_SETS).sort());
  });
  it('a set never leaks the codes of another set (unassign_reasons has `missed`, visit_cancel_reasons has `booking_cancelled`, not vice versa)', { timeout: T }, async () => {
    const un = (await reasons('unassign_reasons')).body.data.map((x: any) => x.code);
    const ca = (await reasons('visit_cancel_reasons')).body.data.map((x: any) => x.code);
    expect(un).toContain('missed'); expect(un).not.toContain('booking_cancelled');
    expect(ca).toContain('booking_cancelled'); expect(ca).not.toContain('missed');
  });
  it('deterministic: two calls return the same list in the same order', { timeout: T }, async () => {
    expect((await reasons('review_reasons')).body).toEqual((await reasons('review_reasons')).body);
  });
});

describe('H20 global seeds only (D-130)', () => {
  it('every tenant, including a tenant-B admin, gets the identical list for a set (no tenant dimension), with RLS bypassed too', { timeout: T }, async () => {
    const a = (await reasons('wipe_reasons', DISPATCHER)).body;
    const b = (await reasons('wipe_reasons', as(DISPATCHER, { tenant: TENANT_B }))).body;
    expect(b).toEqual(a);
    expect((await reasons('wipe_reasons', DISPATCHER, { bypassRls: true })).body).toEqual(a);
  });
  it('read-only: listing every set leaves homecollection.g_cs_reasons byte-for-byte unchanged', { timeout: T }, async () => {
    const before = await reasonTableState();
    for (const set of Object.keys(REASON_SETS)) await reasons(set);
    expect(await reasonTableState()).toEqual(before);
  });
  it('an inactive seed row is not offered (the app can only pick active reasons)', { timeout: T }, async () => {
    await superTx(async (tx) => {
      await tx.query(`INSERT INTO homecollection.g_cs_reasons (id, set_code, code, display, is_active) VALUES (gen_random_uuid(), 'wipe_reasons', 'zz_inactive_probe', 'Inactive probe', false)
        ON CONFLICT (set_code, code) DO UPDATE SET is_active = false`);
    });
    expect((await reasons('wipe_reasons')).body.data.map((x: any) => x.code)).not.toContain('zz_inactive_probe');
  });
});

describe('H20 validation and access', () => {
  const badSets: Array<[string, unknown]> = [
    ['missing set', undefined], ['empty set', ''], ['unknown set', 'cancel_reasons'], ['other case', 'VISIT_CANCEL_REASONS'], ['trailing space', 'visit_cancel_reasons '],
    ['a frontdesk set name', 'order_cancel_reasons'], ['SQL', `visit_cancel_reasons' OR '1'='1`], ['SQL comment', 'wipe_reasons;--'], ['wildcard', '%'], ['array', ['wipe_reasons']],
    ['object', { set: 'wipe_reasons' }], ['number', 7], ['over 30 chars', 'a'.repeat(31)], ['prototype key', '__proto__'],
  ];
  it.each(badSets)('%s -> 400 common.validation_failed', { timeout: T }, async (_n, set) => {
    expect((await reasonsFails(set)).code).toBe('common.validation_failed');
  });
  it('visit.read is required: settings.manage alone and phlebotomist (sync.upload) -> auth.forbidden; the check goes through IdentityPort.assertRole(homecollection.visit.read)', { timeout: T }, async () => {
    expect((await reasonsFails('wipe_reasons', as(ADMIN, { grants: [P.settings] }))).code).toBe('auth.forbidden');
    expect((await reasonsFails('wipe_reasons', PHLEBO)).code).toBe('auth.forbidden');
    expect((await reasonsFails('wipe_reasons', as(DISPATCHER, { grants: [] }))).code).toBe('auth.forbidden');
    expect((await reasons('wipe_reasons')).probe.identity.calls.map((c) => c.permission)).toContain(P.read);
  });
  it('authorisation precedes validation: a forbidden caller with a bad set gets auth.forbidden', { timeout: T }, async () => {
    expect((await reasonsFails('nope', PHLEBO)).code).toBe('auth.forbidden');
  });
  it('visit.read is not a privileged permission: a dispatcher at aal1 and a tenant-B admin both succeed', { timeout: T }, async () => {
    expect((await reasons('wipe_reasons', DISPATCHER)).status).toBe(200);
    expect((await reasons('wipe_reasons', ADMIN_B)).status).toBe(200);
    expect(TENANT_A).not.toBe(TENANT_B);
  });
});
