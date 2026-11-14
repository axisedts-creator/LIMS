// PartnerContext wire DTO (02-TRD §5.1): explicit allowlist, snake_case; no membership/tenant/credit-party/e-mail columns can reach the wire.
import type { PartnerContextRow } from '../service/partner-context.service.js';

export interface PartnerContextDto {
  partner: { id: string; partner_code: string; name: string };
  user: { partner_user_id: string; display_name: string; partner_role: string; mfa_enrolled: boolean };
  tenant: { display_name: string; calendar_display: string; timezone: string };
  permissions: string[];
  features: { access_slip_enabled: boolean; conversion_mode: string; include_default_price_list: boolean };
}

// ---- staff DTOs (TRD §5.3 SA1–SA7; openapi PartnerAdmin / PartnerAdminSummary, additionalProperties:false) ----
// Explicit allowlist: tenant_id, credit_party_id, suspend_reason_text and the audit columns never reach the wire; null columns are omitted.
export interface CreditPartyRef { readonly id: string; readonly party_code: string; readonly name: string }
export interface CentreRef { readonly id: string; readonly code: string; readonly name: string }
export interface PartnerRow {
  id: string; partner_code: string; name: string; status: string; credit_party_id: string; receiving_branch_id: string; receiving_centre_id: string; conversion_mode: string;
  contact_email?: string | null; contact_phone_e164?: string | null; address_text?: string | null; suspend_reason_code?: string | null;
  created_at: Date | string; created_key?: string | null; version: number | string; active_users: number | string; open_manifests: number | string;
  price_list_synced_at?: Date | string | null; statements_synced_at?: Date | string | null;
}
const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

export function toPartnerAdminSummaryDto(r: PartnerRow, cp: CreditPartyRef, centre: CentreRef) {
  return {
    id: r.id, partner_code: r.partner_code, name: r.name, status: r.status,
    credit_party: { id: cp.id, party_code: cp.party_code, name: cp.name },
    receiving_centre: { id: centre.id, code: centre.code, name: centre.name },
    active_users: Number(r.active_users), open_manifests: Number(r.open_manifests),
  };
}

export function toPartnerAdminDto(r: PartnerRow, cp: CreditPartyRef, centre: CentreRef) {
  const projection = {
    ...(r.price_list_synced_at ? { price_list_synced_at: iso(r.price_list_synced_at) } : {}),
    ...(r.statements_synced_at ? { statements_synced_at: iso(r.statements_synced_at) } : {}),
  };
  return {
    ...toPartnerAdminSummaryDto(r, cp, centre),
    receiving_branch_id: r.receiving_branch_id, conversion_mode: r.conversion_mode,
    ...(r.contact_email != null ? { contact_email: r.contact_email } : {}),
    ...(r.contact_phone_e164 != null ? { contact_phone_e164: r.contact_phone_e164 } : {}),
    ...(r.address_text != null ? { address_text: r.address_text } : {}),
    ...(r.suspend_reason_code != null ? { suspend_reason_code: r.suspend_reason_code } : {}),
    created_at: iso(r.created_at), version: Number(r.version),
    ...(Object.keys(projection).length > 0 ? { projection_status: projection } : {}),
  };
}

export function toPartnerContextDto(
  row: PartnerContextRow,
  facts: { mfaEnrolled: boolean; permissions: readonly string[]; tenantDisplayName: string; calendarDisplay: string; timezone: string },
): PartnerContextDto {
  return {
    partner: { id: row.partner_id, partner_code: row.partner_code, name: row.partner_name },
    user: { partner_user_id: row.partner_user_id, display_name: row.display_name, partner_role: row.partner_role, mfa_enrolled: facts.mfaEnrolled },
    tenant: { display_name: facts.tenantDisplayName, calendar_display: facts.calendarDisplay.toLowerCase(), timezone: facts.timezone },
    permissions: [...facts.permissions],
    // 05-SCHEMA §3.8 defaults when the tenant has no partners.settings row
    features: {
      access_slip_enabled: row.access_slip_enabled ?? false,
      conversion_mode: row.conversion_mode,
      include_default_price_list: row.include_default_price_list ?? true,
    },
  };
}
