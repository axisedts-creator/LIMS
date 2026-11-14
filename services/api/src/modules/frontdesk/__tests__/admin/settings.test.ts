// FD-T15 F24 getFrontdeskSettings / updateFrontdeskSettings. 02-TRD §5 F24 (GET/PUT /v1/frontdesk/settings, PUT IM, `frontdesk.settings.manage` privileged [CR-C4-008], common.version_conflict),
// 02-CV §4.2 (If-Match "<version>": absent 428, stale 409, malformed 400), contract FrontdeskSettings (version server-set, ignored on PUT), 05-SCHEMA §3 frontdesk.settings CHECKs
// (limits 0..10000, self <= absolute max, search min chars 2..10: a value the DB would reject must be a 400, never a 500), 07-SECURITY §6.4 (no permission -> auth.forbidden;
// privileged at aal1 -> auth.mfa_required), REQ-SEC-062/067 (re-validation through IdentityPort.assertRole), tenant isolation (RLS + explicit tenant filter).
// Fails now: both operations are stubs (common.service_unavailable).
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, ADMIN_B, BASE_SETTINGS, DESK, NEW_SETTINGS, P, T, TENANT_A, TENANT_B, as, getSettings, putSettings, putSettingsFails, resetSettings, schemaErrors, settingsRow } from './helpers.js';

const WIRE = Object.keys(BASE_SETTINGS);
const wire = (row: any) => Object.fromEntries(WIRE.map((k) => [k, typeof row[k] === 'string' && /^\d+$/.test(row[k]) && k.endsWith('paisa') ? Number(row[k]) : row[k]]));

beforeEach(async () => { await resetSettings(); }, T);

describe('F24 GET', () => {
  it('returns the tenant row as a schema-valid FrontdeskSettings with its version, and nothing else (no tenant_id / audit columns)', { timeout: T }, async () => {
    const r = await getSettings();
    expect(r.status).toBe(200);
    expect(schemaErrors('FrontdeskSettings', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ ...BASE_SETTINGS, version: 1 });
    for (const k of ['tenant_id', 'is_active', 'created_by', 'updated_by', 'created_at', 'updated_at']) expect(r.body, k).not.toHaveProperty(k);
  });
  it('privileged: no grant -> auth.forbidden; settings.manage at aal1 -> auth.mfa_required; the check goes through IdentityPort.assertRole(frontdesk.settings.manage)', { timeout: T }, async () => {
    const e1 = await getSettings(DESK).catch((e) => e); expect(e1.code).toBe('auth.forbidden');
    const e2 = await getSettings(as(ADMIN, { mfa: 'aal1' })).catch((e) => e); expect(e2.code).toBe('auth.mfa_required');
    const ok = await getSettings(); expect(ok.probe.identity.calls.map((c) => c.permission)).toContain(P.settings);
  });
  it('tenant isolation: each tenant reads its own row (also with RLS bypassed: only the explicit tenant filter separates them)', { timeout: T }, async () => {
    const b = await putSettings(NEW_SETTINGS, '"1"', ADMIN_B);
    expect(b.status).toBe(200);
    expect((await getSettings(ADMIN)).body).toMatchObject({ ...BASE_SETTINGS, version: 1 });
    expect((await getSettings(ADMIN, { bypassRls: true })).body).toMatchObject({ ...BASE_SETTINGS, version: 1 });
    expect((await getSettings(ADMIN_B, { bypassRls: true })).body).toMatchObject({ ...NEW_SETTINGS, version: 2 });
  });
});

describe('F24 PUT', () => {
  it('If-Match "1": 200, every field replaced, version 2, schema-valid; the row and a following GET agree; updated_by is set', { timeout: T }, async () => {
    const r = await putSettings(NEW_SETTINGS, '"1"');
    expect(r.status).toBe(200);
    expect(schemaErrors('FrontdeskSettings', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ ...NEW_SETTINGS, version: 2 });
    const row = await settingsRow(TENANT_A);
    expect(wire(row)).toEqual(NEW_SETTINGS); expect(row.version).toBe(2); expect(row.updated_by).toBeTruthy();
    expect((await getSettings()).body).toMatchObject({ ...NEW_SETTINGS, version: 2 });
  });
  it('contract: `version` in the body is server-set and ignored (If-Match carries it)', { timeout: T }, async () => {
    const r = await putSettings({ ...NEW_SETTINGS, version: 99 }, '"1"');
    expect(r.status).toBe(200); expect(r.body.version).toBe(2); expect((await settingsRow(TENANT_A)).version).toBe(2);
  });
  it('428 common.precondition_required without If-Match; 409 common.version_conflict with a stale one; 400 for a malformed one; the row is untouched each time', { timeout: T }, async () => {
    expect((await putSettingsFails(NEW_SETTINGS, undefined)).code).toBe('common.precondition_required');
    expect((await putSettingsFails(NEW_SETTINGS, '"7"')).code).toBe('common.version_conflict');
    expect((await putSettingsFails(NEW_SETTINGS, '1')).code).toBe('common.validation_failed');
    expect((await putSettingsFails(NEW_SETTINGS, '"0"')).code).toBe('common.validation_failed');
    const row = await settingsRow(TENANT_A);
    expect(wire(row)).toEqual(BASE_SETTINGS); expect(row.version).toBe(1);
  });
  it('a second PUT with the already-used version is a conflict (lost-update guard); with the new version it succeeds', { timeout: T }, async () => {
    expect((await putSettings(NEW_SETTINGS, '"1"')).status).toBe(200);
    expect((await putSettingsFails({ ...NEW_SETTINGS, label_autoprint: true }, '"1"')).code).toBe('common.version_conflict');
    const r = await putSettings({ ...NEW_SETTINGS, label_autoprint: true }, '"2"');
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ label_autoprint: true, version: 3 });
  });
  it('race: two PUTs with the same If-Match -> exactly one 200, the other 409 common.version_conflict; final version 2', { timeout: T }, async () => {
    const res = await Promise.allSettled([putSettings({ ...NEW_SETTINGS, patient_search_min_chars: 5 }, '"1"'), putSettings({ ...NEW_SETTINGS, patient_search_min_chars: 6 }, '"1"')]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const lost = res.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason.code).toBe('common.version_conflict');
    expect((await settingsRow(TENANT_A)).version).toBe(2);
  });

  describe('validation: a 400 common.validation_failed that leaves the row at version 1 (never a DB constraint 500)', () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ['discount_self_limit_bp above 10000', { discount_self_limit_bp: 10001 }],
      ['discount_absolute_max_bp above 10000', { discount_absolute_max_bp: 10001 }],
      ['negative discount_self_limit_bp', { discount_self_limit_bp: -1 }],
      ['negative discount_self_limit_paisa', { discount_self_limit_paisa: -1 }],
      ['non-integer discount_self_limit_paisa', { discount_self_limit_paisa: 1.5 }],
      ['self limit above the absolute max (settings__limits__ck)', { discount_self_limit_bp: 3000, discount_absolute_max_bp: 2000 }],
      ['patient_search_min_chars 1 (DB CHECK is 2..10)', { patient_search_min_chars: 1 }],
      ['patient_search_min_chars 11', { patient_search_min_chars: 11 }],
      ['empty consent_text_version', { consent_text_version: '' }],
      ['consent_text_version of 33 chars', { consent_text_version: 'v'.repeat(33) }],
      ['buyer_pan_pattern of 201 chars', { buyer_pan_pattern: '^' + '1'.repeat(200) }],
      ['buyer_pan_pattern that is not a valid regular expression (registration compiles it)', { buyer_pan_pattern: '([' }],
      ['string instead of boolean', { require_referrer: 'true' }],
      ['null for a required field', { label_autoprint: null }],
      ['unknown field (mass assignment)', { tenant_id: TENANT_B }],
      ['unknown field is_active', { is_active: false }],
    ];
    it.each(bad)('%s', { timeout: T }, async (_n, patch) => {
      const e = await putSettingsFails({ ...NEW_SETTINGS, ...patch }, '"1"');
      expect(e.code).toBe('common.validation_failed');
      const row = await settingsRow(TENANT_A);
      expect(row.version).toBe(1); expect(wire(row)).toEqual(BASE_SETTINGS);
    });
    it('a missing required field (PUT replaces the whole object) and a non-object body', { timeout: T }, async () => {
      for (const k of WIRE) {
        const { [k]: _drop, ...rest } = NEW_SETTINGS as Record<string, unknown>;
        expect((await putSettingsFails(rest, '"1"')).code, `missing ${k}`).toBe('common.validation_failed');
      }
      expect((await putSettingsFails('x', '"1"')).code).toBe('common.validation_failed');
      expect((await putSettingsFails(null, '"1"')).code).toBe('common.validation_failed');
      expect((await settingsRow(TENANT_A)).version).toBe(1);
    });
    it('boundaries that ARE valid: 0 / 10000 limits with self = max, patient_search_min_chars 2 and 10, consent_text_version of 32 chars', { timeout: T }, async () => {
      const edge = { ...NEW_SETTINGS, discount_self_limit_bp: 10000, discount_absolute_max_bp: 10000, patient_search_min_chars: 2, consent_text_version: 'v'.repeat(32) };
      expect((await putSettings(edge, '"1"')).status).toBe(200);
      expect((await putSettings({ ...edge, discount_self_limit_bp: 0, discount_absolute_max_bp: 0, patient_search_min_chars: 10 }, '"2"')).status).toBe(200);
    });
  });

  it('privileged: no grant -> auth.forbidden; front desk (registration.create) -> auth.forbidden; settings.manage at aal1 -> auth.mfa_required; the row stays at version 1', { timeout: T }, async () => {
    expect((await putSettingsFails(NEW_SETTINGS, '"1"', as(ADMIN, { grants: [] }))).code).toBe('auth.forbidden');
    expect((await putSettingsFails(NEW_SETTINGS, '"1"', DESK)).code).toBe('auth.forbidden');
    const e = await putSettingsFails(NEW_SETTINGS, '"1"', as(ADMIN, { mfa: 'aal1' }));
    expect(e.code).toBe('auth.mfa_required'); expect(e.statusCode).toBe(403);
    expect((await settingsRow(TENANT_A)).version).toBe(1);
    const ok = await putSettings(NEW_SETTINGS, '"1"');
    expect(ok.probe.identity.calls.map((c) => c.permission)).toContain(P.settings);   // re-validated on every call (REQ-SEC-062/067)
  });

  it('tenant isolation: A updates only A (also with RLS bypassed); B is untouched', { timeout: T }, async () => {
    expect((await putSettings(NEW_SETTINGS, '"1"', ADMIN, { bypassRls: true })).status).toBe(200);
    const b = await settingsRow(TENANT_B);
    expect(wire(b)).toEqual(BASE_SETTINGS); expect(b.version).toBe(1);
    expect((await settingsRow(TENANT_A)).version).toBe(2);
  });

  it('the submitted pattern text is a setting value, not log material: nothing of the body reaches ctx.log', { timeout: T }, async () => {
    const r = await putSettings(NEW_SETTINGS, '"1"');
    expect(r.status).toBe(200);
    expect(r.probe.logs.join('\n')).not.toContain('^[0-9]{10}$');
  });
});
