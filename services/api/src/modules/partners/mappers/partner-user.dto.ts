// PartnerUser wire DTO (02-TRD §5.2, partners.yaml PartnerUser): explicit allowlist, snake_case.
// Never carries tenant_id, partner_id, membership_id, invited_by_actor_type, deactivate_reason_code or any e-mail in clear (REQ-SEC-080, 05-SCHEMA §3.2).

export interface PartnerUserRow {
  readonly id: string; readonly display_name: string; readonly email_masked: string;
  readonly partner_role: string; readonly status: string; readonly version: number | string;
}

export interface PartnerUserDto {
  id: string; display_name: string; email_masked: string; partner_role: string; status: string; mfa_enrolled: boolean; version: number;
}

// [CONV] mfa_enrolled / last_login_at have no source in C13 (05-SCHEMA §3.2 has no column, IdentityPort has no per-membership read): the boolean is
// reported false and last_login_at is omitted — interim behaviour of CR-C13-T06 (.orchestra/cr/C13.T06.md) until it gives a source.
export const toPartnerUserDto = (r: PartnerUserRow): PartnerUserDto => ({
  id: r.id, display_name: r.display_name, email_masked: r.email_masked, partner_role: r.partner_role, status: r.status,
  mfa_enrolled: false, version: Number(r.version),
});

/** a***@p***.invalid — first character of the local part and of the domain plus the last label; 3..64 chars (partner_users__email__ck). */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  const local = Array.from(email.slice(0, at)), domain = email.slice(at + 1);
  const tld = domain.slice(domain.lastIndexOf('.') + 1).slice(0, 16);
  return `${local[0] ?? '*'}***@${Array.from(domain)[0] ?? '*'}***.${tld}`;
}
