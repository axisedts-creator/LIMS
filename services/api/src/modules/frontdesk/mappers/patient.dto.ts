// Row -> DTO for F1-F6 (frontdesk.yaml PatientSummary / Patient / ConsentRecord / OrderSummaryDto). Pure; no I/O.
import { LimsError } from '../../../core/errors.js';
import { ageDisplay } from '../domain/patient.js';

type Row = Record<string, any>;

/** pg `date` -> 'YYYY-MM-DD' (string when the type parser is identity, local-midnight Date otherwise). */
export function dateOnly(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  return String(v).slice(0, 10);
}
export const isoUtc = (v: unknown): string | undefined => (v == null ? undefined : new Date(v as string | Date).toISOString());

/** +9779812345678 -> +977*******78 (country code + last 2 digits only; length preserved). */
export function maskPhone(e164: unknown): string {
  if (typeof e164 !== 'string' || e164.length < 8) return '';
  return `${e164.slice(0, 4)}${'*'.repeat(e164.length - 6)}${e164.slice(-2)}`;
}

const strip = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export function consentsDto(c: Row | undefined) {
  return {
    processing: c?.processing === true, sms: c?.sms === true, whatsapp: c?.whatsapp === true, email: c?.email === true,
    share_with_referrer: c?.share_with_referrer === true, consent_text_version: String(c?.consent_text_version ?? 'none'),
  };
}

const ageOf = (r: Row, today: string): string => { const b = dateOnly(r['birth_on']); return b ? ageDisplay(b, today) : 'Unknown'; };

export function patientSummaryDto(r: Row, today: string) {
  const anon = r['anonymised_at'] != null;
  return strip({
    id: r['id'], patient_code: r['patient_code'], full_name: anon ? '' : String(r['full_name'] ?? ''), sex: r['sex'], age_display: ageOf(r, today),
    phone_masked: anon ? '' : maskPhone(r['phone_e164']), last_visit_at: isoUtc(r['last_visit_at']), is_anonymised: anon,
  });
}

/** LD-310 pick: '*' x (length - 4) + last 4 characters; 4 characters or fewer are fully masked. Code points, so a surrogate pair is never split. */
export function maskTail4(v: string): string {
  const c = [...v];
  return c.length > 4 ? '*'.repeat(c.length - 4) + c.slice(-4).join('') : '*'.repeat(c.length);
}
const PARITY_TEXT = ['title', 'external_patient_id', 'nationality', 'government_id_type', 'address_province', 'address_district', 'address_municipality',
  'address_ward', 'address_tole', 'address_postal_code', 'profile_photo_attachment_id'] as const;

/** T0B-REGAPI-1 (LD-310): the 13 T0C-REGPARITY-1 fields; a null column is an absent key, so a patient without them reads exactly as before. */
function parityFields(r: Row, fullGovId: boolean): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of PARITY_TEXT) if (r[k] != null) o[k] = String(r[k]);
  if (r['government_id_number'] != null) o['government_id_number'] = fullGovId ? String(r['government_id_number']) : maskTail4(String(r['government_id_number']));
  if (r['custom_fields'] != null && typeof r['custom_fields'] === 'object') o['custom_fields'] = Object.entries(r['custom_fields']).map(([code, value]) => ({ code, value: String(value) }));
  return o;
}

/** `pii` = caller holds frontdesk.registration.create: only then phone_e164 / email / address_text leave the server.
 *  `fullGovId` = the single patient read (getPatient, frontdesk.patient.read): the only reply with the unmasked government_id_number (LD-310). */
export function patientDto(r: Row, consent: Row | undefined, today: string, pii: boolean, fullGovId = false) {
  const anon = r['anonymised_at'] != null;
  return strip({
    ...patientSummaryDto(r, today),
    birth_on: anon ? undefined : dateOnly(r['birth_on']), is_birth_on_estimated: r['is_birth_on_estimated'] === true,
    ...(pii && !anon ? { phone_e164: r['phone_e164'] ?? undefined, email: r['email'] ?? undefined, address_text: r['address_text'] ?? undefined } : {}),
    ...(anon ? {} : parityFields(r, fullGovId)),
    consents: consentsDto(consent), version: Number(r['version']),
  });
}

export const consentRecordDto = (c: Row, actor: { membershipId: string; displayName: string }) => ({
  id: c['id'], patient_id: c['patient_id'], consents: consentsDto(c), recorded_at: isoUtc(c['captured_at'])!,
  recorded_by: { membership_id: actor.membershipId, display_name: actor.displayName },
});

export const orderSummaryDto = (o: Row, patientDisplay: string) => strip({
  id: o['id'], registration_no: o['registration_no'], patient_id: o['patient_id'], patient_display: patientDisplay, centre_id: o['centre_id'], status: o['status'],
  billing_mode: o['billing_mode'], source: o['source'], registered_at: isoUtc(o['registered_at']), item_count: Number(o['item_count']),
  has_open_flag: o['has_open_flag'] === true, version: Number(o['version']),
});

// ---- opaque keyset cursor: base64url(JSON [sort, sort_key (µs-exact UTC text), id]) ----
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
export const encodeCursor = (sort: string, key: string, id: string): string => Buffer.from(JSON.stringify([sort, key, id]), 'utf8').toString('base64url');
export function decodeCursor(raw: unknown, sort: string): readonly [string, string] {
  const bad = () => new LimsError('common.invalid_cursor');
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(raw)) throw bad();
  let v: unknown;
  try { v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { throw bad(); }
  if (!Array.isArray(v) || v.length !== 3 || v[0] !== sort || typeof v[1] !== 'string' || !STAMP.test(v[1]) || typeof v[2] !== 'string' || !UUID.test(v[2])) throw bad();
  return [v[1], v[2]];
}
