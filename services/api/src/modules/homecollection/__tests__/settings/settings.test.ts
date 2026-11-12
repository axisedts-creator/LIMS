// HC-T04 H18 getHomecollectionSettings / H19 updateHomecollectionSettings (US-07-7). 02-TRD §5 H18/H19 (GET/PUT /v1/homecollection/settings, `homecollection.settings.manage` privileged
// [CR-C17-008], PUT If-Match "<version>"), §11.2 (ranges + defaults), 08 A17 P-22 (lazy row: INSERT ... ON CONFLICT (tenant_id) DO NOTHING + TRD defaults; a read with no row uses the defaults),
// 08 A19 D-128 (payment_methods[].code must be one of C4's six seed codes), D-129 (notify_patient_on_assign = true -> 400 until CR-C17-014 merges), TRD §5 H19 (second_identifier = birth_date -> 400
// until CR-C17-003 merges), 02-CV §4.2 (If-Match absent 428, stale 409, malformed 400), 07-SECURITY §4 (privilege escalation: forbidden / mfa_required), 05-SCHEMA §4 settings CHECKs (a value the DB
// would reject must be a 400, never a 500). Fails now: both operations are HC-T01 stubs (common.internal "not implemented").
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, ADMIN_B, BASE, DEFAULT_PAYMENT_CODES, DEFAULT_SCALARS, DISPATCHER, NEW, P, PHLEBO, SEED_PAYMENT_CODES, SYS_ACTOR, T, TENANT_A, TENANT_B, WIRE, as, getSettings, getSettingsFails,
  putSettings, putSettingsFails, resetSettings, schemaErrors, settingsRow, settingsRows, superTx, wire } from './helpers.js';

const AUDIT_AND_INTERNAL = ['id', 'tenant_id', 'is_active', 'created_by', 'updated_by', 'created_at', 'updated_at'];
const pm = (...codes: string[]) => codes.map((code) => ({ code, display: code.slice(0, 40), requires_reference: false }));
const untouched = async (v = 1) => { const row = await settingsRow(TENANT_A); expect(row.version).toBe(v); expect(wire(row)).toEqual(BASE); };

describe('H18 GET (row exists)', () => {
  beforeEach(async () => { await resetSettings(); }, T);

  it('returns the tenant row as a schema-valid SettingsDto with its version, and nothing else (no id / tenant_id / audit columns); an existing row is never replaced by the defaults', { timeout: T }, async () => {
    const r = await getSettings();
    expect(r.status).toBe(200);
    expect(schemaErrors('SettingsDto', r.body)).toEqual([]);
    expect(r.body).toEqual({ ...BASE, version: 1 });
    for (const k of AUDIT_AND_INTERNAL) expect(r.body, k).not.toHaveProperty(k);
    expect(Object.keys(r.body.payment_methods[0]).sort()).toEqual(['code', 'display', 'requires_reference']);
  });
  it('privileged: no grant -> auth.forbidden (dispatcher, phlebotomist); settings.manage at aal1 -> auth.mfa_required (403); the check goes through IdentityPort.assertRole(homecollection.settings.manage)', { timeout: T }, async () => {
    expect((await getSettingsFails(DISPATCHER)).code).toBe('auth.forbidden');
    expect((await getSettingsFails(PHLEBO)).code).toBe('auth.forbidden');
    expect((await getSettingsFails(as(ADMIN, { grants: [] }))).code).toBe('auth.forbidden');
    const e = await getSettingsFails(as(ADMIN, { mfa: 'aal1' }));
    expect(e.code).toBe('auth.mfa_required'); expect(e.statusCode).toBe(403);
    expect((await getSettings()).probe.identity.calls.map((c) => c.permission)).toContain(P.settings);
  });
  it('tenant isolation: each tenant reads its own row, also with RLS bypassed (only the explicit tenant_id filter separates them)', { timeout: T }, async () => {
    expect((await putSettings(NEW, '"1"', ADMIN_B)).status).toBe(200);
    expect((await getSettings(ADMIN)).body).toEqual({ ...BASE, version: 1 });
    expect((await getSettings(ADMIN, { bypassRls: true })).body).toEqual({ ...BASE, version: 1 });
    expect((await getSettings(ADMIN_B, { bypassRls: true })).body).toEqual({ ...NEW, version: 2 });
  });
});

describe('H18 GET / H19 PUT with no row (lazy create, P-22, TRD §11.2 defaults)', () => {
  beforeEach(async () => { await resetSettings(['a']); }, T);

  it('GET with no row: 200 with the TRD §11.2 defaults at version 1 (not 404, not 500); schema-valid; payment methods default to cash/fonepay_qr/esewa/khalti with C4-seed requires_reference; consent text is a non-empty placeholder', { timeout: T }, async () => {
    const r = await getSettings();
    expect(r.status).toBe(200);
    expect(schemaErrors('SettingsDto', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ ...DEFAULT_SCALARS, version: 1 });
    expect(r.body.payment_methods.map((m: any) => ({ code: m.code, requires_reference: m.requires_reference }))).toEqual(DEFAULT_PAYMENT_CODES);
    for (const m of r.body.payment_methods) { expect(typeof m.display).toBe('string'); expect(m.display.length).toBeGreaterThanOrEqual(1); expect(m.display.length).toBeLessThanOrEqual(40); }
    expect(typeof r.body.collection_consent_text).toBe('string');
    expect(r.body.collection_consent_text.length).toBeGreaterThanOrEqual(1); expect(r.body.collection_consent_text.length).toBeLessThanOrEqual(2000);
    expect(Object.keys(r.body).sort()).toEqual([...WIRE, 'version'].sort());
  });
  it('GET with no row never leaks or touches another tenant: B keeps its row, A reads defaults (RLS bypassed too)', { timeout: T }, async () => {
    expect((await getSettings(ADMIN, { bypassRls: true })).body).toMatchObject({ ...DEFAULT_SCALARS, version: 1 });
    expect((await getSettings(ADMIN_B, { bypassRls: true })).body).toEqual({ ...BASE, version: 1 });
    expect(await settingsRows(TENANT_B)).toHaveLength(1);
  });
  it('first PUT creates the row lazily from the defaults (exactly one row, unique per tenant), then applies the body: 200, version 2, DB and a following GET agree, updated_by is the caller', { timeout: T }, async () => {
    const r = await putSettings(NEW, '"1"');
    expect(r.status).toBe(200);
    expect(schemaErrors('SettingsDto', r.body)).toEqual([]);
    expect(r.body).toEqual({ ...NEW, version: 2 });
    const rows = await settingsRows(TENANT_A);
    expect(rows).toHaveLength(1);
    expect(wire(rows[0])).toEqual(NEW); expect(rows[0].version).toBe(2); expect(rows[0].tenant_id).toBe(TENANT_A); expect(rows[0].updated_by).toBe(SYS_ACTOR);
    expect((await getSettings()).body).toEqual({ ...NEW, version: 2 });
  });
  it('a PUT on the not-yet-created row with a version the lazy row cannot have (If-Match "2") is 409 common.version_conflict; no If-Match is 428; never a 500', { timeout: T }, async () => {
    expect((await putSettingsFails(NEW, '"2"')).code).toBe('common.version_conflict');
    expect((await putSettingsFails(NEW, undefined)).code).toBe('common.precondition_required');
    const rows = await settingsRows(TENANT_A);
    if (rows.length) { expect(rows).toHaveLength(1); expect(rows[0].version).toBe(1); expect(rows[0].collection_consent_text_version).toBe('hc-consent-v1'); }
  });
  it('a rejected PUT (validation) on the not-yet-created row leaves it at the defaults, version 1', { timeout: T }, async () => {
    expect((await putSettingsFails({ ...NEW, sync_interval_seconds: 5 }, '"1"')).code).toBe('common.validation_failed');
    expect((await getSettings()).body).toMatchObject({ ...DEFAULT_SCALARS, version: 1 });
    const rows = await settingsRows(TENANT_A);
    if (rows.length) { expect(rows).toHaveLength(1); expect(rows[0].version).toBe(1); }
  });
  it('race on the lazy create: two first PUTs with If-Match "1" -> exactly one 200, the other 409 common.version_conflict (INSERT ... ON CONFLICT DO NOTHING, never a unique-violation 500); one row, version 2', { timeout: T }, async () => {
    const res = await Promise.allSettled([putSettings({ ...NEW, sync_interval_seconds: 100 }, '"1"'), putSettings({ ...NEW, sync_interval_seconds: 200 }, '"1"')]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const lost = res.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason.code).toBe('common.version_conflict');
    const rows = await settingsRows(TENANT_A);
    expect(rows).toHaveLength(1); expect(rows[0].version).toBe(2);
  });
  it('race between two first GETs and a PUT never yields a 5xx and never two rows', { timeout: T }, async () => {
    const res = await Promise.allSettled([getSettings(), getSettings(), putSettings(NEW, '"1"')]);
    for (const x of res) if (x.status === 'rejected') expect(x.reason.code).toBe('common.version_conflict');
    expect(res.filter((x) => x.status === 'fulfilled').length).toBeGreaterThanOrEqual(2);
    expect(await settingsRows(TENANT_A)).toHaveLength(1);
  });
});

describe('H19 PUT', () => {
  beforeEach(async () => { await resetSettings(); }, T);

  it('If-Match "1": 200, every field replaced, version 2, schema-valid; the row and a following GET agree; updated_by is the caller; no tenant_id / audit columns in the body', { timeout: T }, async () => {
    const r = await putSettings(NEW, '"1"');
    expect(r.status).toBe(200);
    expect(schemaErrors('SettingsDto', r.body)).toEqual([]);
    expect(r.body).toEqual({ ...NEW, version: 2 });
    for (const k of AUDIT_AND_INTERNAL) expect(r.body, k).not.toHaveProperty(k);
    const row = await settingsRow(TENANT_A);
    expect(wire(row)).toEqual(NEW); expect(row.version).toBe(2); expect(row.updated_by).toBe(SYS_ACTOR); expect(row.is_active).toBe(true);
    expect((await getSettings()).body).toEqual({ ...NEW, version: 2 });
  });
  it('428 common.precondition_required without If-Match; 409 common.version_conflict with a stale one; 400 for a malformed one; the row is untouched each time', { timeout: T }, async () => {
    expect((await putSettingsFails(NEW, undefined)).code).toBe('common.precondition_required');
    expect((await putSettingsFails(NEW, '"7"')).code).toBe('common.version_conflict');
    expect((await putSettingsFails(NEW, '1')).code).toBe('common.validation_failed');
    expect((await putSettingsFails(NEW, '"0"')).code).toBe('common.validation_failed');
    expect((await putSettingsFails(NEW, '"abc"')).code).toBe('common.validation_failed');
    await untouched();
  });
  it('lost-update guard: the already-used version conflicts; the new version succeeds', { timeout: T }, async () => {
    expect((await putSettings(NEW, '"1"')).status).toBe(200);
    expect((await putSettingsFails({ ...NEW, capture_gps: false }, '"1"')).code).toBe('common.version_conflict');
    const r = await putSettings({ ...NEW, capture_gps: false }, '"2"');
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ capture_gps: false, version: 3 });
  });
  it('race: two PUTs with the same If-Match -> exactly one 200, the other 409 common.version_conflict; final version 2', { timeout: T }, async () => {
    const res = await Promise.allSettled([putSettings({ ...NEW, max_visits_per_route: 5 }, '"1"'), putSettings({ ...NEW, max_visits_per_route: 6 }, '"1"')]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(((res.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason).code).toBe('common.version_conflict');
    expect((await settingsRow(TENANT_A)).version).toBe(2);
  });

  describe('validation (TRD §11.2 ranges, D-128, D-129): 400 common.validation_failed that leaves the row at version 1 (never a DB constraint 500)', () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ['sync_interval_seconds 59', { sync_interval_seconds: 59 }], ['sync_interval_seconds 901', { sync_interval_seconds: 901 }], ['sync_interval_seconds 300.5', { sync_interval_seconds: 300.5 }],
      ['sync_interval_seconds as string', { sync_interval_seconds: '300' }], ['sync_interval_seconds null', { sync_interval_seconds: null }], ['sync_interval_seconds negative', { sync_interval_seconds: -1 }],
      ['offline_purge_hours 3', { offline_purge_hours: 3 }], ['offline_purge_hours 25', { offline_purge_hours: 25 }],
      ['gps_retention_days 6', { gps_retention_days: 6 }], ['gps_retention_days 366', { gps_retention_days: 366 }],
      ['handover_overdue_hours 0', { handover_overdue_hours: 0 }], ['handover_overdue_hours 25', { handover_overdue_hours: 25 }],
      ['max_visits_per_route 0', { max_visits_per_route: 0 }], ['max_visits_per_route 61', { max_visits_per_route: 61 }],
      ['clock_tolerance_seconds 59', { clock_tolerance_seconds: 59 }], ['clock_tolerance_seconds 3601', { clock_tolerance_seconds: 3601 }],
      ['min_app_version 1.0', { min_app_version: '1.0' }], ['min_app_version 1.0.0.0', { min_app_version: '1.0.0.0' }], ['min_app_version v1.0.0', { min_app_version: 'v1.0.0' }],
      ['min_app_version 1.0.0-beta', { min_app_version: '1.0.0-beta' }], ['min_app_version 12345.0.0', { min_app_version: '12345.0.0' }], ['min_app_version empty', { min_app_version: '' }],
      ['collection_consent_text_version empty', { collection_consent_text_version: '' }], ['collection_consent_text_version of 41 chars', { collection_consent_text_version: 'v'.repeat(41) }],
      ['collection_consent_text empty', { collection_consent_text: '' }], ['collection_consent_text of 2001 chars', { collection_consent_text: 'x'.repeat(2001) }],
      ['second_identifier outside the enum', { second_identifier: 'passport' }],
      ['second_identifier = birth_date before CR-C17-003 is merged', { second_identifier: 'birth_date' }],
      ['notify_patient_on_assign = true before CR-C17-014 is merged (D-129)', { notify_patient_on_assign: true }],
      ['notify_patient_on_assign as string "true"', { notify_patient_on_assign: 'true' }],
      ['capture_gps as string', { capture_gps: 'true' }], ['map_handoff_enabled as number', { map_handoff_enabled: 1 }], ['notify_phlebotomist_on_assign null', { notify_phlebotomist_on_assign: null }],
      ['payment_methods empty', { payment_methods: [] }], ['payment_methods of 11 entries', { payment_methods: pm(...Array(11).fill('cash')) }],
      ['payment_methods not an array', { payment_methods: { code: 'cash', display: 'Cash', requires_reference: false } }],
      ['payment code outside the C4 seed set (D-128)', { payment_methods: pm('cash', 'paypal') }],
      ['payment code with another case (CASH)', { payment_methods: pm('CASH') }], ['payment code with a trailing space', { payment_methods: pm('cash ') }],
      ['payment code empty', { payment_methods: pm('') }], ['payment code null', { payment_methods: [{ code: null, display: 'Cash', requires_reference: false }] }],
      ['payment code carrying SQL', { payment_methods: pm(`cash'; DROP TABLE homecollection.settings; --`) }],
      ['payment display empty', { payment_methods: [{ code: 'cash', display: '', requires_reference: false }] }],
      ['payment display of 41 chars', { payment_methods: [{ code: 'cash', display: 'd'.repeat(41), requires_reference: false }] }],
      ['payment requires_reference as string', { payment_methods: [{ code: 'cash', display: 'Cash', requires_reference: 'false' }] }],
      ['payment method missing requires_reference', { payment_methods: [{ code: 'cash', display: 'Cash' }] }],
      ['payment method with an unknown key', { payment_methods: [{ code: 'cash', display: 'Cash', requires_reference: false, fee: 1 }] }],
      ['payment method that is a bare string', { payment_methods: ['cash'] }],
      ['unknown field tenant_id (mass assignment)', { tenant_id: TENANT_B }], ['unknown field id', { id: '01a1a98a-ac40-7000-8000-00000000ffff' }],
      ['unknown field is_active', { is_active: false }], ['unknown field created_by', { created_by: SYS_ACTOR }],
    ];
    it.each(bad)('%s', { timeout: T }, async (_n, patch) => {
      const e = await putSettingsFails({ ...NEW, ...patch }, '"1"');
      expect(e.code).toBe('common.validation_failed');
      await untouched();
    });
    it('a missing required field (PUT replaces the whole object) and a non-object body', { timeout: T }, async () => {
      for (const k of WIRE) {
        const { [k]: _drop, ...rest } = NEW as Record<string, unknown>;
        expect((await putSettingsFails(rest, '"1"')).code, `missing ${k}`).toBe('common.validation_failed');
      }
      for (const b of ['x', null, [], 7, undefined]) expect((await putSettingsFails(b, '"1"')).code, `body ${JSON.stringify(b)}`).toBe('common.validation_failed');
      await untouched();
    });
    it('D-129: notify_patient_on_assign = true is rejected, but notify_phlebotomist_on_assign = true is allowed (staff recipients are suppressed_no_contact in Phase 1, nothing is sent)', { timeout: T }, async () => {
      expect((await putSettingsFails({ ...NEW, notify_patient_on_assign: true, notify_phlebotomist_on_assign: true }, '"1"')).code).toBe('common.validation_failed');
      const r = await putSettings({ ...NEW, notify_patient_on_assign: false, notify_phlebotomist_on_assign: true }, '"1"');
      expect(r.status).toBe(200); expect(r.body).toMatchObject({ notify_patient_on_assign: false, notify_phlebotomist_on_assign: true });
    });
    it('D-128: all six C4 seed codes are accepted, in any subset, and requires_reference may be ticked for any method (cash true included)', { timeout: T }, async () => {
      const all = SEED_PAYMENT_CODES.map((code, i) => ({ code, display: `Synthetic ${code}`, requires_reference: i % 2 === 0 }));
      const r = await putSettings({ ...NEW, payment_methods: all }, '"1"');
      expect(r.status).toBe(200); expect(r.body.payment_methods).toEqual(all);
      expect((await settingsRow(TENANT_A)).payment_methods).toEqual(all);
      const one = await putSettings({ ...NEW, payment_methods: [{ code: 'cash', display: 'Cash', requires_reference: true }] }, '"2"');
      expect(one.status).toBe(200); expect(one.body.payment_methods).toEqual([{ code: 'cash', display: 'Cash', requires_reference: true }]);
    });
    it('boundaries that ARE valid: every range minimum, then every range maximum; min_app_version 0.0.0 / 9999.9999.9999; 40-char consent version; 2000-char consent text; capture_gps / map_handoff_enabled tenant choice', { timeout: T }, async () => {
      const lo = { ...NEW, min_app_version: '0.0.0', sync_interval_seconds: 60, offline_purge_hours: 4, gps_retention_days: 7, handover_overdue_hours: 1, max_visits_per_route: 1, clock_tolerance_seconds: 60,
        collection_consent_text_version: 'v', collection_consent_text: 'x', payment_methods: pm('cash') };
      const hi = { ...NEW, min_app_version: '9999.9999.9999', sync_interval_seconds: 900, offline_purge_hours: 24, gps_retention_days: 365, handover_overdue_hours: 24, max_visits_per_route: 60, clock_tolerance_seconds: 3600,
        collection_consent_text_version: 'v'.repeat(40), collection_consent_text: 'x'.repeat(2000), payment_methods: pm(...SEED_PAYMENT_CODES) };
      const a = await putSettings(lo, '"1"'); expect(a.status).toBe(200); expect(a.body).toMatchObject({ ...lo, version: 2 });
      const b = await putSettings(hi, '"2"'); expect(b.status).toBe(200); expect(b.body).toMatchObject({ ...hi, version: 3 });
    });
  });

  it('privileged: no grant / dispatcher / phlebotomist -> auth.forbidden; settings.manage at aal1 -> auth.mfa_required (403); the row stays at version 1; a valid call re-validates through IdentityPort.assertRole every time', { timeout: T }, async () => {
    expect((await putSettingsFails(NEW, '"1"', as(ADMIN, { grants: [] }))).code).toBe('auth.forbidden');
    expect((await putSettingsFails(NEW, '"1"', DISPATCHER)).code).toBe('auth.forbidden');
    expect((await putSettingsFails(NEW, '"1"', PHLEBO)).code).toBe('auth.forbidden');
    const e = await putSettingsFails(NEW, '"1"', as(ADMIN, { mfa: 'aal1' }));
    expect(e.code).toBe('auth.mfa_required'); expect(e.statusCode).toBe(403);
    await untouched();
    expect((await putSettings(NEW, '"1"')).probe.identity.calls.map((c) => c.permission)).toContain(P.settings);
  });
  it('authorisation is checked before the body is inspected: a forbidden caller with a bad body gets auth.forbidden, not a validation error', { timeout: T }, async () => {
    expect((await putSettingsFails({ junk: true }, '"1"', DISPATCHER)).code).toBe('auth.forbidden');
    expect((await putSettingsFails({ junk: true }, undefined, as(ADMIN, { mfa: 'aal1' }))).code).toBe('auth.mfa_required');
  });
  it('tenant isolation: A updates only A (also with RLS bypassed); B is untouched; a body naming tenant B cannot reach B', { timeout: T }, async () => {
    expect((await putSettings(NEW, '"1"', ADMIN, { bypassRls: true })).status).toBe(200);
    const b = await settingsRow(TENANT_B);
    expect(wire(b)).toEqual(BASE); expect(b.version).toBe(1);
    expect((await putSettingsFails({ ...NEW, tenant_id: TENANT_B }, '"2"')).code).toBe('common.validation_failed');
    expect((await settingsRow(TENANT_B)).version).toBe(1);
  });
  it('SQL probe: consent text that looks like SQL is stored and returned verbatim as data (parameterised), and the table survives', { timeout: T }, async () => {
    const evil = `x'); DROP TABLE homecollection.settings; --`;
    const r = await putSettings({ ...NEW, collection_consent_text: evil }, '"1"');
    expect(r.status).toBe(200); expect(r.body.collection_consent_text).toBe(evil);
    expect((await settingsRow(TENANT_A)).collection_consent_text).toBe(evil);
    expect(await superTx(async (tx) => (await tx.query("SELECT to_regclass('homecollection.settings') IS NOT NULL AS ok")).rows[0].ok)).toBe(true);
  });
  it('the submitted consent text / payment display text is setting content, not log material: nothing of the body reaches ctx.log', { timeout: T }, async () => {
    const r = await putSettings({ ...NEW, collection_consent_text: 'SENTINEL-CONSENT-7731' }, '"1"');
    expect(r.status).toBe(200);
    expect(r.probe.logs.join('\n')).not.toContain('SENTINEL-CONSENT-7731');
  });
});
