// Tenant-settings ranges, enums and format rules (US-C2; 05-SCHEMA §4.6; 04 A3/A8/A10/I8; 08 A13 P-15). Pure.
// Fields are the snake_case wire names of PATCH /settings; only keys present in the patch are checked.

const OOR = 'identity.setting_out_of_range' as const;
const FI = 'common.field_invalid' as const; // format/length failures at JSON pointer (02-TRD §5.6)

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

const str = (re: RegExp, nullable: boolean, min = 0, max = Infinity) => (v: unknown) =>
  (nullable && v === null) || (typeof v === 'string' && v.length >= min && v.length <= max && re.test(v));
const list = (items: number, each: number) => (v: unknown) =>
  Array.isArray(v) && v.length <= items && v.every((x) => typeof x === 'string' && x.length <= each);
const ANY = /^/;
const PREFIX4 = /^[A-Z0-9]{0,4}$/;

// 05-SCHEMA §4.6 pattern/length/count rules -> common.field_invalid.
// *_pattern columns are validated by numbering-pattern.ts; wiring them into PATCH /settings is T16.
export const SETTING_FORMATS: Readonly<Record<string, (v: unknown) => boolean>> = Object.freeze({
  numbering_prefix: str(/^[A-Z0-9]{0,8}$/, false),
  barcode_prefix: str(PREFIX4, true),
  accession_prefix_histology: str(PREFIX4, false),
  accession_prefix_cytology: str(PREFIX4, false),
  accession_prefix_ihc: str(PREFIX4, false),
  accession_prefix_molecular: str(PREFIX4, false),
  sms_sender_id: str(/^[A-Za-z0-9]{1,11}$/, true),
  accent_color: str(/^#[0-9A-Fa-f]{6}$/, true),
  website: str(/^https:\/\//, true, 0, 200),
  display_name: str(ANY, false, 1, 120),
  contact_email: str(ANY, true, 0, 254),
  receipt_footer_note: str(ANY, true, 0, 200),
  address_lines: list(4, 120),
  phones: list(3, 40),
});

type SettingsError = { pointer: string; code: typeof OOR | typeof FI };
export type SettingsRangeResult = { ok: true } | { ok: false; errors: SettingsError[] };

const inRange = (field: string, value: unknown): boolean => {
  if (field === 'abbreviated_invoice_limit_paisa') return value === null || (Number.isSafeInteger(value) && (value as number) >= 0); // bigint NULL ≥0 (04 L9)
  const r = SETTING_RANGES[field];
  if (r) return Number.isInteger(value) && (value as number) >= r.min && (value as number) <= r.max;
  return typeof value === 'string' && (SETTING_ENUMS[field] ?? []).includes(value);
};

export function validateSettingsPatch(patch: Record<string, unknown>): SettingsRangeResult {
  const errors: SettingsError[] = [];
  for (const [field, value] of Object.entries(patch)) {
    const pointer = `/${field}`;
    if (field === 'abbreviated_invoice_limit_paisa' || Object.hasOwn(SETTING_RANGES, field) || Object.hasOwn(SETTING_ENUMS, field)) {
      if (!inRange(field, value)) errors.push({ pointer, code: OOR });
    } else if (Object.hasOwn(SETTING_FORMATS, field) && !SETTING_FORMATS[field]?.(value)) {
      errors.push({ pointer, code: FI });
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}
