// PartnerContext wire DTO (02-TRD §5.1): explicit allowlist, snake_case; no membership/tenant/credit-party/e-mail columns can reach the wire.
import type { PartnerContextRow } from '../service/partner-context.service.js';

export interface PartnerContextDto {
  partner: { id: string; partner_code: string; name: string };
  user: { partner_user_id: string; display_name: string; partner_role: string; mfa_enrolled: boolean };
  tenant: { display_name: string; calendar_display: string; timezone: string };
  permissions: string[];
  features: { access_slip_enabled: boolean; conversion_mode: string; include_default_price_list: boolean };
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
