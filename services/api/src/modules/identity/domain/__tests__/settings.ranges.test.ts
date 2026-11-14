// T2 settings.ranges.ts (US-C2; 05-SCHEMA §4.6; 04 A8/A10/A3/I8; 08 A13 P-15).
// Assumed API (pure):
//   validateSettingsPatch(patch: Record<string, unknown> /* API snake_case fields of PATCH /settings */)
//     -> { ok: true } | { ok: false; errors: Array<{ pointer: string /* '/idle_timeout_minutes' */; code: 'identity.setting_out_of_range' }> }
//   Format/length failures (05-SCHEMA §4.6 patterns, lengths, counts) -> code 'common.field_invalid' at '/<field>' (02-TRD §5.6);
//   abbreviated_invoice_limit_paisa (a range) -> 'identity.setting_out_of_range'. Return type carries both codes.
//   Nullable cols accept null. *_pattern columns are NOT checked here (numbering-pattern.ts / T16).
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

// ---- §4.6 format / length / count rules (T2-review item 2) ----
const FI = 'common.field_invalid';
const bad = (field: string, v: unknown, code = FI) =>
  expect(check(field, v), `${field}=${JSON.stringify(v)}`).toEqual({ ok: false, errors: [{ pointer: `/${field}`, code }] });
const good = (field: string, v: unknown) => expect(check(field, v), `${field}=${JSON.stringify(v)}`).toEqual({ ok: true });
const rep = (n: number, c = 'A') => c.repeat(n);

describe('prefix patterns', () => {
  // field, max length, nullable
  const PREFIXES: ReadonlyArray<readonly [string, number, boolean]> = [
    ['numbering_prefix', 8, false], ['barcode_prefix', 4, true],
    ['accession_prefix_histology', 4, false], ['accession_prefix_cytology', 4, false],
    ['accession_prefix_ihc', 4, false], ['accession_prefix_molecular', 4, false],
  ];
  describe.each(PREFIXES)('%s ^[A-Z0-9]{0,%i}$', (f, max, nullable) => {
    it('accepts empty, 1 char, digits, max length', () => {
      for (const v of ['', 'A', '9', 'A1', rep(max), rep(max - 1)]) good(f, v);
    });
    it('rejects max+1, lowercase, space, punctuation, non-ASCII, newline', () => {
      for (const v of [rep(max + 1), 'a', 'Ab', 'A B', 'A-1', 'A_', 'क', 'A\n', '\nA']) bad(f, v);
    });
    it('rejects non-strings', () => { for (const v of [1, true, {}, []]) bad(f, v); });
    it(nullable ? 'accepts null' : 'rejects null', () => (nullable ? good(f, null) : bad(f, null)));
  });
});

describe('sms_sender_id ^[A-Za-z0-9]{1,11}$ (nullable)', () => {
  it('accepts 1..11 alphanumerics and null', () => {
    for (const v of ['a', 'Z', '1', 'LabSms01', rep(10), rep(11), 'aB3dE6gH9jK']) good('sms_sender_id', v);
    good('sms_sender_id', null);
  });
  it('rejects empty, 12 chars, space, punctuation, non-ASCII, non-string', () => {
    for (const v of ['', rep(12), 'Lab Sms', 'Lab-Sms', 'लैब', 'A\n', 5, true]) bad('sms_sender_id', v);
  });
});

describe('accent_color ^#[0-9A-Fa-f]{6}$ (nullable)', () => {
  it('accepts valid hex and null', () => {
    for (const v of ['#000000', '#FFFFFF', '#abcdef', '#AbC123']) good('accent_color', v);
    good('accent_color', null);
  });
  it('rejects short/long/no-hash/non-hex/alpha/named/trailing newline', () => {
    for (const v of ['#FFF', '#FFFFF', '#FFFFFFF', 'FFFFFF', '#GGGGGG', '#FFFFFF80', 'red', '', ' #FFFFFF', '#FFFFFF\n', 5]) bad('accent_color', v);
  });
});

describe('website ≤200 and ^https:// (nullable)', () => {
  const pad = (n: number) => 'https://' + rep(n - 8, 'a');
  it('accepts https, exactly 200 chars, null', () => {
    good('website', 'https://example.org'); good('website', pad(200)); good('website', null);
  });
  it('rejects 201 chars, http, other schemes, no scheme, uppercase scheme, non-string', () => {
    for (const v of [pad(201), 'http://example.org', 'ftp://x.org', 'javascript:alert(1)', 'example.org', ' https://x.org', 'HTTPS://x.org', '', 5]) bad('website', v);
  });
});

describe('text length limits', () => {
  it('display_name 1–120, not null', () => {
    good('display_name', 'S'); good('display_name', rep(120));
    bad('display_name', ''); bad('display_name', rep(121)); bad('display_name', null); bad('display_name', 5);
  });
  it('contact_email ≤254 (nullable)', () => {
    const mail = (n: number) => rep(n - 4, 'a') + '@b.c';
    good('contact_email', mail(254)); good('contact_email', 'lab@example.org'); good('contact_email', null);
    bad('contact_email', mail(255)); bad('contact_email', 5);
  });
  it('receipt_footer_note ≤200 (nullable)', () => {
    good('receipt_footer_note', rep(200)); good('receipt_footer_note', ''); good('receipt_footer_note', null);
    bad('receipt_footer_note', rep(201)); bad('receipt_footer_note', 5);
  });
});

describe('array limits', () => {
  it('address_lines ≤4 items, each ≤120', () => {
    good('address_lines', []); good('address_lines', ['a', 'b', 'c', 'd']); good('address_lines', [rep(120)]);
    bad('address_lines', ['a', 'b', 'c', 'd', 'e']); bad('address_lines', [rep(121)]);
    bad('address_lines', ['ok', rep(121)]); bad('address_lines', [5]); bad('address_lines', 'a'); bad('address_lines', null);
  });
  it('phones ≤3 items, each ≤40', () => {
    good('phones', []); good('phones', ['1', '2', '3']); good('phones', [rep(40, '9')]);
    bad('phones', ['1', '2', '3', '4']); bad('phones', [rep(41, '9')]);
    bad('phones', ['1', rep(41, '9')]); bad('phones', [5]); bad('phones', '1'); bad('phones', null);
  });
});

describe('abbreviated_invoice_limit_paisa ≥0 integer, NULL ok (identity.setting_out_of_range)', () => {
  it('accepts null, 0, 1, large integer', () => {
    for (const v of [null, 0, 1, 1_000_000_00]) good('abbreviated_invoice_limit_paisa', v);
  });
  it('rejects -1, fractions, NaN, Infinity, strings, booleans', () => {
    for (const v of [-1, 0.5, NaN, Infinity, '100', true, {}]) bad('abbreviated_invoice_limit_paisa', v, OOR);
  });
});

describe('mixed codes in one patch', () => {
  it('reports each error with its own code and pointer', () => {
    const r = validateSettingsPatch({ idle_timeout_minutes: 99, accent_color: 'red', abbreviated_invoice_limit_paisa: -1, display_name: 'ok' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.map((e) => `${e.pointer}:${e.code}`).sort()).toEqual([
        `/abbreviated_invoice_limit_paisa:${OOR}`, `/accent_color:${FI}`, `/idle_timeout_minutes:${OOR}`,
      ]);
    }
  });
});
