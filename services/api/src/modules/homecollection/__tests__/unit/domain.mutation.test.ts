// C17 HC-T02 — mutation type registry + payload validators (02-TRD §3.1 domain/mutation.ts "mirrors spec oneOf"; §6.3 table;
// contracts/openapi/homecollection.yaml Mutation* schemas, additionalProperties:false; _common.yaml Uuid/Uuidv7/Code/DecimalString).
// Interface expected from the writer (../../domain/mutation.ts) — SEAMS:
//   export const MUTATION_TYPES: readonly MutationType[]   the 9 types, exactly as in the spec table
//   export function isMutationType(x: unknown): x is MutationType
//   export function mutationRequiresVisitId(type: MutationType): boolean   false only for 'handover.recorded'
//   export function validateMutationPayload(type: unknown, payload: unknown): { ok: true } | { ok: false; errors: readonly string[] }
//        pure, never throws (device input is untrusted); unknown type / non-object payload / extra property => ok:false, errors non-empty.
import { describe, expect, it } from 'vitest';
import { isMutationType, MUTATION_TYPES, mutationRequiresVisitId, validateMutationPayload } from '../../domain/mutation.js';

const U = '01a1a98a-ac40-7000-8000-000000090011'; // Uuidv7-shaped synthetic id (03-IC example ids)
const U2 = '01a1a98a-ac40-7000-8000-000000020002';
const GPS_OFF = { status: 'off' };
const GPS_OK = { status: 'ok', latitude: '27.717245', longitude: '85.323961', accuracy_m: 12 };

const VALID: Record<string, unknown> = {
  'visit.arrived': { gps: GPS_OFF },
  'visit.identity_checked': { name_check: 'matches', second_identifier: 'phone', second_check: 'matches' },
  'visit.consent_recorded': { consent_text_version: 'hc-consent-v1', given: true },
  'specimen.collected': { specimen_id: U, scanned_barcode: 'E2600000042', scan_method: 'camera', specimen_type_code: 'EDTA_WB', gps: GPS_OFF },
  'specimen.not_collected': { specimen_id: U, reason_code: 'unable_to_draw' },
  'payment.captured': { order_id: U, payment_method_code: 'cash', amount: { amount_paisa: 180000, currency: 'NPR' } },
  'visit.completed': { outcome: 'collected' },
  'visit.failed': { reason_code: 'patient_not_home', gps: GPS_OFF },
  'handover.recorded': { handover_id: U, to_centre_id: U2, specimen_ids: [U] },
};
const ok = (t: string, p: unknown): boolean => validateMutationPayload(t, p).ok;
const mut = (t: string, over: Record<string, unknown>): Record<string, unknown> => ({ ...(VALID[t] as object), ...over });
const without = (t: string, f: string): Record<string, unknown> => { const c = { ...(VALID[t] as Record<string, unknown>) }; delete c[f]; return c; };

describe('registry', () => {
  it('has exactly the nine spec types', () => {
    expect([...MUTATION_TYPES].sort()).toEqual(Object.keys(VALID).sort());
  });
  it('isMutationType accepts the nine and nothing else', () => {
    for (const t of MUTATION_TYPES) expect(isMutationType(t)).toBe(true);
    for (const x of ['visit.cancelled', 'visit.arrived ', 'VISIT.ARRIVED', '', null, undefined, 7, {}, '__proto__', 'constructor']) expect(isMutationType(x)).toBe(false);
  });
  it('visit_id is required for every type except handover.recorded', () => {
    for (const t of MUTATION_TYPES) expect(mutationRequiresVisitId(t)).toBe(t !== 'handover.recorded');
  });
});

describe('every type: valid example passes; empty / null / array / extra property fail', () => {
  it.each(Object.keys(VALID))('%s', (t) => {
    expect(validateMutationPayload(t, VALID[t])).toEqual({ ok: true });
    expect(ok(t, {})).toBe(false);
    expect(ok(t, null)).toBe(false);
    expect(ok(t, undefined)).toBe(false);
    expect(ok(t, [])).toBe(false);
    expect(ok(t, 'x')).toBe(false);
    const bad = validateMutationPayload(t, { ...(VALID[t] as object), surprise: 1 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.length).toBeGreaterThan(0);
  });
  it('unknown type is never valid', () => {
    for (const t of ['visit.cancelled', '', 'toString', '__proto__']) expect(ok(t, {})).toBe(false);
    expect(ok('visit.arrived', { gps: GPS_OFF, __proto__x: 1 })).toBe(false);
  });
  it('every required field is required', () => {
    const REQ: Record<string, string[]> = {
      'visit.arrived': ['gps'],
      'visit.identity_checked': ['name_check', 'second_identifier', 'second_check'],
      'visit.consent_recorded': ['consent_text_version', 'given'],
      'specimen.collected': ['specimen_id', 'scanned_barcode', 'scan_method', 'specimen_type_code', 'gps'],
      'specimen.not_collected': ['specimen_id', 'reason_code'],
      'payment.captured': ['order_id', 'payment_method_code', 'amount'],
      'visit.completed': ['outcome'],
      'visit.failed': ['reason_code', 'gps'],
      'handover.recorded': ['handover_id', 'to_centre_id', 'specimen_ids'],
    };
    for (const [t, fields] of Object.entries(REQ)) for (const f of fields) expect(ok(t, without(t, f)), `${t} without ${f}`).toBe(false);
  });
});

describe('gps', () => {
  it('accepts every status; coordinates only with ok', () => {
    for (const status of ['off', 'denied', 'unavailable']) expect(ok('visit.arrived', { gps: { status } })).toBe(true);
    expect(ok('visit.arrived', { gps: GPS_OK })).toBe(true);
  });
  it('rejects an unknown status', () => expect(ok('visit.arrived', { gps: { status: 'maybe' } })).toBe(false));
  it('rejects coordinates when status is not ok', () => {
    for (const status of ['off', 'denied', 'unavailable']) {
      expect(ok('visit.arrived', { gps: { status, latitude: '27.7', longitude: '85.3' } }), status).toBe(false);
    }
  });
  it('DecimalString: numbers and garbage are not valid coordinates', () => {
    expect(ok('visit.arrived', { gps: { ...GPS_OK, latitude: 27.7 } })).toBe(false);
    expect(ok('visit.arrived', { gps: { ...GPS_OK, longitude: '85.3E1' } })).toBe(false);
    expect(ok('visit.arrived', { gps: { ...GPS_OK, latitude: "27.7'; DROP TABLE" } })).toBe(false);
  });
  it('accuracy_m is an integer 0..10000', () => {
    for (const a of [0, 1, 10000]) expect(ok('visit.arrived', { gps: { ...GPS_OK, accuracy_m: a } }), String(a)).toBe(true);
    for (const a of [-1, 10001, 1.5, '5', null]) expect(ok('visit.arrived', { gps: { ...GPS_OK, accuracy_m: a } }), String(a)).toBe(false);
  });
  it('gps must be an object with status', () => {
    for (const g of [null, 'off', [], {}]) expect(ok('visit.arrived', { gps: g })).toBe(false);
  });
});

describe('visit.identity_checked / visit.consent_recorded', () => {
  it('check enums', () => {
    expect(ok('visit.identity_checked', mut('visit.identity_checked', { name_check: 'mismatch', second_check: 'mismatch' }))).toBe(true);
    expect(ok('visit.identity_checked', mut('visit.identity_checked', { second_identifier: 'birth_date' }))).toBe(true);
    expect(ok('visit.identity_checked', mut('visit.identity_checked', { name_check: 'yes' }))).toBe(false);
    expect(ok('visit.identity_checked', mut('visit.identity_checked', { second_identifier: 'email' }))).toBe(false);
    expect(ok('visit.identity_checked', mut('visit.identity_checked', { second_check: true }))).toBe(false);
  });
  it('consent_text_version <= 40 chars, given is a boolean (false is a valid fact)', () => {
    expect(ok('visit.consent_recorded', { consent_text_version: 'v'.repeat(40), given: false })).toBe(true);
    expect(ok('visit.consent_recorded', { consent_text_version: 'v'.repeat(41), given: true })).toBe(false);
    expect(ok('visit.consent_recorded', { consent_text_version: 'hc-consent-v1', given: 'true' })).toBe(false);
    expect(ok('visit.consent_recorded', { consent_text_version: 7, given: true })).toBe(false);
  });
});

describe('specimen.collected', () => {
  it('scanned_barcode ^[A-Z0-9]{1,20}$', () => {
    for (const b of ['A', 'E2600000042', 'A'.repeat(20)]) expect(ok('specimen.collected', mut('specimen.collected', { scanned_barcode: b })), b).toBe(true);
    for (const b of ['', 'a1', 'A'.repeat(21), 'AB-12', 'AB 12', 'AB\n', '१२३', 12]) expect(ok('specimen.collected', mut('specimen.collected', { scanned_barcode: b })), String(b)).toBe(false);
  });
  it('scan_method camera | hid | manual', () => {
    for (const m of ['camera', 'hid', 'manual']) expect(ok('specimen.collected', mut('specimen.collected', { scan_method: m }))).toBe(true);
    expect(ok('specimen.collected', mut('specimen.collected', { scan_method: 'nfc' }))).toBe(false);
  });
  it('specimen_id must be a uuid, specimen_type_code a Code', () => {
    expect(ok('specimen.collected', mut('specimen.collected', { specimen_id: 'not-a-uuid' }))).toBe(false);
    expect(ok('specimen.collected', mut('specimen.collected', { specimen_type_code: '' }))).toBe(false);
    expect(ok('specimen.collected', mut('specimen.collected', { specimen_type_code: 'bad code!' }))).toBe(false);
  });
});

describe('specimen.not_collected / visit.failed / visit.completed', () => {
  it('reason_text <= 200 chars (optional)', () => {
    expect(ok('specimen.not_collected', mut('specimen.not_collected', { reason_text: 'x'.repeat(200) }))).toBe(true);
    expect(ok('specimen.not_collected', mut('specimen.not_collected', { reason_text: 'x'.repeat(201) }))).toBe(false);
    expect(ok('visit.failed', mut('visit.failed', { reason_text: 'x'.repeat(200) }))).toBe(true);
    expect(ok('visit.failed', mut('visit.failed', { reason_text: 'x'.repeat(201) }))).toBe(false);
  });
  it('visit.completed outcome collected | partial only', () => {
    expect(ok('visit.completed', { outcome: 'partial' })).toBe(true);
    expect(ok('visit.completed', { outcome: 'none' })).toBe(false); // outcome=none is server-derived (V9), never sent
    expect(ok('visit.completed', { outcome: 'failed' })).toBe(false);
  });
});

describe('payment.captured', () => {
  const pay = (amount: unknown, extra: Record<string, unknown> = {}): boolean => ok('payment.captured', mut('payment.captured', { amount, ...extra }));
  it('amount 1..50,000,000 paisa, integer, NPR', () => {
    for (const a of [1, 180000, 50_000_000]) expect(pay({ amount_paisa: a, currency: 'NPR' }), String(a)).toBe(true);
    for (const a of [0, -1, 50_000_001, 1.5, '100', null, Number.NaN]) expect(pay({ amount_paisa: a, currency: 'NPR' }), String(a)).toBe(false);
  });
  it('Money shape: currency NPR only, no extra keys, no bare number', () => {
    expect(pay({ amount_paisa: 100, currency: 'USD' })).toBe(false);
    expect(pay({ amount_paisa: 100 })).toBe(false);
    expect(pay({ amount_paisa: 100, currency: 'NPR', extra: 1 })).toBe(false);
    expect(pay(100)).toBe(false);
  });
  it('reference optional, 1..100 chars', () => {
    const m = { amount_paisa: 100, currency: 'NPR' };
    expect(pay(m, { reference: 'x'.repeat(100) })).toBe(true);
    expect(pay(m, { reference: 'x'.repeat(101) })).toBe(false);
    expect(pay(m, { reference: '' })).toBe(false);
  });
});

describe('handover.recorded', () => {
  it('handover_id must be a UUIDv7, to_centre_id a uuid', () => {
    expect(ok('handover.recorded', mut('handover.recorded', { handover_id: '01a1a98a-ac40-4000-8000-000000090011' }))).toBe(false); // v4
    expect(ok('handover.recorded', mut('handover.recorded', { handover_id: 'x' }))).toBe(false);
    expect(ok('handover.recorded', mut('handover.recorded', { to_centre_id: 'x' }))).toBe(false);
  });
  it('specimen_ids 1..50 uuids', () => {
    const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `01a1a98a-ac40-7000-8000-${String(i).padStart(12, '0')}`);
    expect(ok('handover.recorded', mut('handover.recorded', { specimen_ids: ids(1) }))).toBe(true);
    expect(ok('handover.recorded', mut('handover.recorded', { specimen_ids: ids(50) }))).toBe(true);
    expect(ok('handover.recorded', mut('handover.recorded', { specimen_ids: [] }))).toBe(false);
    expect(ok('handover.recorded', mut('handover.recorded', { specimen_ids: ids(51) }))).toBe(false);
    expect(ok('handover.recorded', mut('handover.recorded', { specimen_ids: ['nope'] }))).toBe(false);
    expect(ok('handover.recorded', mut('handover.recorded', { specimen_ids: 'x' }))).toBe(false);
  });
});
