// T2 settings.ranges.ts (US-C2; 05-SCHEMA §4.6; 04 A8/A10/A3/I8; 08 A13 P-15).
// Assumed API (pure):
//   validateSettingsPatch(patch: Record<string, unknown> /* API snake_case fields of PATCH /settings */)
//     -> { ok: true } | { ok: false; errors: Array<{ pointer: string /* '/idle_timeout_minutes' */; code: 'identity.setting_out_of_range' }> }
//   Only keys present in `patch` are checked; keys this module does not range-check are ignored. Collects ALL errors.
//   SETTING_RANGES: Record<field, { min?: number; max?: number }>
import { describe, expect, it } from 'vitest';
import { SETTING_RANGES, validateSettingsPatch } from '../settings.ranges.js';

const OOR = 'identity.setting_out_of_range';
const check = (field: string, value: unknown) => validateSettingsPatch({ [field]: value });

// field, min, max — bounds copied from 05-SCHEMA §4.6
const RANGES: ReadonlyArray<readonly [string, number, number]> = [
  ['idle_timeout_minutes', 15, 30],
  ['absolute_session_hours', 1, 12],
  ['report_link_ttl_days', 30, 90],
  ['password_min_length', 12, 64],
  ['retention_clinical_years', 5, 50],
  ['retention_audit_years', 5, 50],
  ['retention_raw_instrument_years', 1, 50],
];

describe.each(RANGES)('%s in [%i, %i]', (field, min, max) => {
  it.each([min, min + 1, max - 1, max])('accepts %i', (v) => expect(check(field, v)).toEqual({ ok: true }));
  it.each([min - 1, max + 1])('rejects %i with identity.setting_out_of_range at the field pointer', (v) => {
    expect(check(field, v)).toEqual({ ok: false, errors: [{ pointer: `/${field}`, code: OOR }] });
  });
  it('rejects non-integers, strings, null, NaN, Infinity, booleans, objects', () => {
    for (const v of [min + 0.5, String(min), null, NaN, Infinity, -Infinity, true, {}, []]) {
      expect(check(field, v), `value ${String(v)}`).toMatchObject({ ok: false });
    }
  });
  it('rejects 0 and negative values', () => {
    expect(check(field, 0)).toMatchObject({ ok: false });
    expect(check(field, -1)).toMatchObject({ ok: false });
  });
});

describe('US-C2 headline cases', () => {
  it('idle 14/31, absolute 0/13, link TTL 29/91, retention clinical 4, audit 4, raw instrument 0 all fail', () => {
    const cases = [
      ['idle_timeout_minutes', 14], ['idle_timeout_minutes', 31], ['absolute_session_hours', 0],
      ['absolute_session_hours', 13], ['report_link_ttl_days', 29], ['report_link_ttl_days', 91],
      ['retention_clinical_years', 4], ['retention_audit_years', 4], ['retention_raw_instrument_years', 0],
    ] as const;
    for (const [f, v] of cases) {
      expect(check(f, v), `${f}=${v}`).toMatchObject({ ok: false, errors: [{ pointer: `/${f}`, code: OOR }] });
    }
  });
  it('defaults are all inside their ranges', () => {
    expect(validateSettingsPatch({
      idle_timeout_minutes: 15, absolute_session_hours: 12, password_min_length: 12, report_link_ttl_days: 30,
      retention_clinical_years: 5, retention_audit_years: 5, retention_raw_instrument_years: 1,
    })).toEqual({ ok: true });
  });
  it('collects every offending field in one result', () => {
    const r = validateSettingsPatch({ idle_timeout_minutes: 99, report_link_ttl_days: 1, absolute_session_hours: 6 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.pointer).sort()).toEqual(['/idle_timeout_minutes', '/report_link_ttl_days']);
  });
  it('empty patch and unrelated keys are ok', () => {
    expect(validateSettingsPatch({})).toEqual({ ok: true });
    expect(validateSettingsPatch({ display_name: 'Synthetic Lab', whatsapp_enabled: true })).toEqual({ ok: true });
  });
  it('SETTING_RANGES exposes the same bounds', () => {
    for (const [f, min, max] of RANGES) expect(SETTING_RANGES[f]).toMatchObject({ min, max });
  });
});

describe('timezone (v1 rule, 08 A13 P-15)', () => {
  it('Asia/Kathmandu ok', () => expect(check('timezone', 'Asia/Kathmandu')).toEqual({ ok: true }));
  it.each(['UTC', 'Asia/Kolkata', 'asia/kathmandu', 'Asia/Kathmandu ', 'Asia/Katmandu', '', 'Europe/London'])(
    'rejects %j at /timezone', (tz) => {
      expect(check('timezone', tz)).toEqual({ ok: false, errors: [{ pointer: '/timezone', code: OOR }] });
    });
  it('rejects non-string timezone', () => {
    for (const v of [null, 5, {}, ['Asia/Kathmandu']]) expect(check('timezone', v)).toMatchObject({ ok: false });
  });
});

describe('enum settings (05-SCHEMA §4.6)', () => {
  it('support_access_mode: notify, approval_required ok; others rejected', () => {
    expect(check('support_access_mode', 'notify')).toEqual({ ok: true });
    expect(check('support_access_mode', 'approval_required')).toEqual({ ok: true });
    expect(check('support_access_mode', 'off')).toMatchObject({ ok: false, errors: [{ pointer: '/support_access_mode', code: OOR }] });
  });
  it('calendar_display: AD, BS, AD_BS, BS_AD', () => {
    for (const v of ['AD', 'BS', 'AD_BS', 'BS_AD']) expect(check('calendar_display', v)).toEqual({ ok: true });
    expect(check('calendar_display', 'ad')).toMatchObject({ ok: false });
    expect(check('calendar_display', 'NP')).toMatchObject({ ok: false });
  });
  it('westgard_mode: classic, modern; letterhead_default: with, without', () => {
    expect(check('westgard_mode', 'classic')).toEqual({ ok: true });
    expect(check('westgard_mode', 'modern')).toEqual({ ok: true });
    expect(check('westgard_mode', 'x')).toMatchObject({ ok: false });
    expect(check('letterhead_default', 'with')).toEqual({ ok: true });
    expect(check('letterhead_default', 'without')).toEqual({ ok: true });
    expect(check('letterhead_default', 'both')).toMatchObject({ ok: false });
  });
});
