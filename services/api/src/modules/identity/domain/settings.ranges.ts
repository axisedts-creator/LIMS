// Tenant-settings ranges and enums (US-C2; 05-SCHEMA §4.6; 04 A3/A8/A10/I8; 08 A13 P-15). Pure.
// Fields are the snake_case wire names of PATCH /settings; only keys present in the patch are checked.

const OOR = 'identity.setting_out_of_range' as const;

export const SETTING_RANGES: Readonly<Record<string, { min: number; max: number }>> = Object.freeze({
  idle_timeout_minutes: { min: 15, max: 30 },
  absolute_session_hours: { min: 1, max: 12 },
  report_link_ttl_days: { min: 30, max: 90 },
  password_min_length: { min: 12, max: 64 },
  retention_clinical_years: { min: 5, max: 50 },
  retention_audit_years: { min: 5, max: 50 },
  retention_raw_instrument_years: { min: 1, max: 50 },
});

export const SETTING_ENUMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  timezone: ['Asia/Kathmandu'], // v1 rule (08 A13 P-15)
  support_access_mode: ['notify', 'approval_required'],
  calendar_display: ['AD', 'BS', 'AD_BS', 'BS_AD'],
  westgard_mode: ['classic', 'modern'],
  letterhead_default: ['with', 'without'],
});

export type SettingsRangeResult =
  | { ok: true }
  | { ok: false; errors: Array<{ pointer: string; code: typeof OOR }> };

export function validateSettingsPatch(patch: Record<string, unknown>): SettingsRangeResult {
  const errors: Array<{ pointer: string; code: typeof OOR }> = [];
  for (const [field, value] of Object.entries(patch)) {
    const range = Object.hasOwn(SETTING_RANGES, field) ? SETTING_RANGES[field] : undefined;
    const allowed = Object.hasOwn(SETTING_ENUMS, field) ? SETTING_ENUMS[field] : undefined;
    const bad = range
      ? !(Number.isInteger(value) && (value as number) >= range.min && (value as number) <= range.max)
      : allowed
        ? !(typeof value === 'string' && allowed.includes(value))
        : false;
    if (bad) errors.push({ pointer: `/${field}`, code: OOR });
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}
