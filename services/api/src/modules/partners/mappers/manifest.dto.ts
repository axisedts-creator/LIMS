// C13 T08 — manifest wire DTOs (02-TRD §5.1 Manifest, ManifestSummary, ManifestLine, PriceListItem; openapi additionalProperties:false).
// Explicit allowlists, snake_case, null columns omitted: tenant_id, partner_id, created_by, orderable_ids, orderables_snapshot, is_redacted,
// resolved_patient_id, conversion_attempt, receiving_*_id, conversion_mode, price_list_id never reach the wire (07-SECURITY AB11).
type Row = Record<string, any>;
export interface CentreName { readonly id: string; readonly name: string }

const pad = (n: number): string => String(n).padStart(2, '0');
const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();
/** pg parses `date` as local midnight (no type parser is set): read the local calendar day back; strings pass through. */
const day = (v: Date | string): string => (typeof v === 'string' ? v.slice(0, 10) : `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`);
const utcDay = (v: Date | string): string => iso(v).slice(0, 10);
const has = (v: unknown): boolean => v !== null && v !== undefined;

export interface LineCounts { readonly converted: number; readonly failed: number }

export function toManifestSummaryDto(r: Row, centre: CentreName, counts: LineCounts = { converted: 0, failed: 0 }) {
  return {
    id: r['id'], manifest_no: r['manifest_no'], state: r['state'], line_count: Number(r['line_count']),
    lines_converted: counts.converted, lines_failed: counts.failed,
    receiving_centre: { id: centre.id, name: centre.name },
    ...(has(r['submitted_at']) ? { submitted_at: iso(r['submitted_at']) } : {}),
    ...(has(r['received_at']) ? { received_at: iso(r['received_at']) } : {}),
    ...(has(r['pickup_request_id']) ? { pickup_request_id: r['pickup_request_id'] } : {}),
    created_at: iso(r['created_at']), version: Number(r['version']),
  };
}

export function toManifestDto(r: Row, centre: CentreName, counts: LineCounts, lines: unknown[]) {
  return {
    ...toManifestSummaryDto(r, centre, counts),
    ...(has(r['notes']) ? { notes: r['notes'] } : {}),
    ...(has(r['collected_on']) ? { collected_on: day(r['collected_on']) } : {}),
    ...(has(r['withdraw_reason_code']) ? { withdraw_reason_code: r['withdraw_reason_code'] } : {}),
    lines,
  };
}

export function toLineDto(r: Row, referrerName: string | undefined) {
  const redacted = r['is_redacted'] === true; // retention job nulled the patient (T21); the schema needs a name and a sex
  return {
    id: r['id'], line_no: Number(r['line_no']), state: r['state'],
    ...(has(r['partner_sample_ref']) ? { partner_sample_ref: r['partner_sample_ref'] } : {}),
    patient: {
      full_name: redacted || !has(r['patient_full_name']) ? '[redacted]' : r['patient_full_name'],
      sex: redacted || !has(r['patient_sex']) ? 'unknown' : r['patient_sex'],
      ...(has(r['patient_birth_on']) ? { birth_on: day(r['patient_birth_on']) } : {}),
      ...(has(r['patient_age_years']) ? { age_years: Number(r['patient_age_years']) } : {}),
      ...(has(r['patient_phone_e164']) ? { phone_e164: r['patient_phone_e164'] } : {}),
    },
    consents: { sms: r['consent_sms'], whatsapp: r['consent_whatsapp'], email: r['consent_email'], share_with_referrer: r['consent_share_with_referrer'], consent_text_version: r['consent_text_version'] },
    orderables: (Array.isArray(r['orderables_snapshot']) ? r['orderables_snapshot'] : []).map((o: Row) => ({ orderable_id: o['orderable_id'], kind: o['kind'], code: o['code'], name: o['name'] })),
    priority: r['priority'],
    ...(has(r['referrer_id']) && referrerName !== undefined ? { referrer: { id: r['referrer_id'], display_name: referrerName } } : {}),
    ...(has(r['collected_at']) ? { collected_at: iso(r['collected_at']) } : {}),
    ...(has(r['clinical_note']) ? { clinical_note: r['clinical_note'] } : {}),
    ...(has(r['order_id']) ? { order: { order_id: r['order_id'], registration_no: r['registration_no'] ?? '' } } : {}),
    ...(has(r['failure_code']) ? { failure: { code: r['failure_code'], message_key: r['failure_code'] } } : {}), // ponytail: message_key = code until the conversion task owns i18n keys
    ...(has(r['not_received_reason_code']) ? { not_received_reason_code: r['not_received_reason_code'] } : {}),
    version: Number(r['version']),
  };
}

export function toPriceListItemDto(r: Row) {
  return {
    orderable_id: r['orderable_id'], kind: r['kind'], code: r['code'], name: r['name'],
    ...(has(r['department_name']) ? { department_name: r['department_name'] } : {}),
    unit_price: { amount_paisa: Number(r['unit_price_paisa']), currency: 'NPR' },
    source: r['source'], price_list_version: Number(r['price_list_version']), effective_from: utcDay(r['effective_from']),
    ...(has(r['effective_to']) ? { effective_to: utcDay(r['effective_to']) } : {}),
  };
}
