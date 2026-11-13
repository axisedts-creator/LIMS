// Platform console (PL-1..PL-8) — client-safe constants, types, validators and labels. No server imports here.
// Field names and enums copied from contracts/openapi/identity.yaml (/v1/identity/platform/*).

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TENANT_CODE_RE = /^[a-z][a-z0-9_]{2,31}$/; // TenantProvisionRequest.code
export const UNIT_CODE_RE = /^[A-Za-z0-9-]{1,16}$/; // first_branch.code / first_centre.code
export const PAN_RE = /^[0-9]{9}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const CURSOR_RE = /^[A-Za-z0-9_=-]{1,512}$/;
export const IDEMPOTENCY_RE = /^[A-Za-z0-9_-]{16,128}$/;
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
export const UPLOAD_TYPES = ['application/pdf', 'image/png', 'image/jpeg'] as const;
export const MAX_CIDRS = 20;

export const PERM = {
  read: 'platform.tenant.read',
  manage: 'platform.tenant.manage',
  supportOpen: 'platform.support_session.open',
  deadLetters: 'platform.dead_letter.manage',
  staff: 'platform.staff.manage',
} as const;

// ------------------------------------------------------------------ results returned by server actions (never throw across the boundary)
export interface Fail { ok: false; status: number; code: string; requestId?: string }
export type Result<T> = { ok: true; data: T } | Fail;

// ------------------------------------------------------------------ DTOs (subset of fields the UI reads)
export type TenantStatus = 'provisioning' | 'active' | 'suspended' | 'offboarded';
export interface Tenant { tenant_id: string; code: string; legal_name: string; display_name: string; status: TenantStatus; timezone: string; created_at: string; version: number }
export interface TenantDetail extends Tenant {
  status_reason?: string;
  counts: { users: number; branches: number; centres: number };
  annex_readiness: string;
  status_history: { from_status?: string; to_status: string; occurred_at: string }[];
}
export interface PageOf<T> { data: T[]; page: { limit: number; next_cursor?: string } }
export interface DeadLetter {
  id: string; tenant_id?: string; task_identifier: string; last_error_code: string; last_error_message_redacted: string; attempts: number;
  first_failed_at: string; dead_at: string; state: string; resolved_by?: string; resolved_at?: string; resolution_note?: string; version: number;
}
export interface SupportSession {
  support_session_id: string; tenant_id: string; platform_staff_display_name: string; scope: string; reason_text: string; ticket_ref: string;
  duration_minutes: number; status: string; requested_at: string; started_at?: string; expires_at?: string; ended_at?: string; end_reason?: string; version: number;
}
export type AnnexCode = 'annex_1' | 'annex_2' | 'annex_3' | 'annex_7';
export type AnnexStatus = 'not_started' | 'in_preparation' | 'submitted' | 'completed' | 'rejected' | 'superseded';
export interface AnnexRecord {
  record_id: string; tenant_id?: string; annex_code: AnnexCode; status: AnnexStatus; reference_no?: string; tax_office?: string; counterparty?: string;
  software_version?: string; submitted_on?: string; completed_on?: string; notes?: string; version: number;
}
export interface StaffMember { platform_staff_id: string; display_name: string; email_masked: string; role_code: string; allowed_cidrs: string[]; is_active: boolean; last_login_at?: string; version: number }
export interface PlatformSession { session_id: string; display_name?: string; state: string; aal: string; created_at: string; last_seen_at?: string; client_ip_masked?: string; user_agent_family?: string }
export interface AuthEvent { auth_event_id: string; tenant_id?: string; user_id?: string; membership_id?: string; platform_staff_id?: string; event_type: string; reason_code?: string; client_ip?: string; user_agent?: string; occurred_at: string }
export type Settings = Record<string, unknown> & { version: number };

// ------------------------------------------------------------------ labels
const TENANT_STATUS: Record<string, string> = { provisioning: 'Provisioning', active: 'Active', suspended: 'Suspended', offboarded: 'Offboarded' };
export const tenantStatusLabel = (s: string) => TENANT_STATUS[s] ?? s;
const ANNEX_STATUS: Record<string, string> = {
  not_started: 'Not started', in_preparation: 'In preparation', submitted: 'Submitted', completed: 'Completed', rejected: 'Rejected', superseded: 'Superseded',
};
export const annexStatusLabel = (s: string) => ANNEX_STATUS[s] ?? s;
export const ANNEX_CODES: readonly AnnexCode[] = ['annex_1', 'annex_2', 'annex_3', 'annex_7'];
export const ANNEX_STATUSES: readonly AnnexStatus[] = ['not_started', 'in_preparation', 'submitted', 'completed', 'rejected', 'superseded'];
export const annexLabel = (c: string) => `Annex ${c.replace('annex_', '')}`;
const SS_STATUS: Record<string, string> = { requested: 'Waiting for tenant approval', approved: 'Approved', denied: 'Denied', active: 'Active', ended: 'Ended', expired: 'Expired', revoked: 'Revoked' };
export const supportStatusLabel = (s: string) => SS_STATUS[s] ?? s;
export const scopeLabel = (s: string) => (s === 'admin' ? 'Admin' : s === 'read_only' ? 'Read only' : s);
const ROLE: Record<string, string> = { platform_superadmin: 'Superadmin', platform_support: 'Support' };
export const roleLabel = (r: string) => ROLE[r] ?? r;
export const DEAD_LETTER_STATES = ['open', 'replayed', 'discarded'] as const;

/** IRD annex transitions IR2..IR8 (03-APP-FLOW §2.5). */
export const ANNEX_NEXT: Record<AnnexStatus, readonly AnnexStatus[]> = {
  not_started: ['in_preparation'],
  in_preparation: ['submitted', 'not_started'],
  submitted: ['completed', 'rejected'],
  completed: ['superseded'],
  rejected: ['in_preparation'],
  superseded: [],
};
/** Tenant lifecycle T2..T5 (03-APP-FLOW §2.3). */
export type LifecycleAction = 'activate' | 'suspend' | 'reactivate' | 'terminate';
export const TENANT_NEXT: Record<TenantStatus, readonly LifecycleAction[]> = {
  provisioning: ['activate', 'terminate'],
  active: ['suspend'],
  suspended: ['reactivate', 'terminate'],
  offboarded: [],
};

export const AUTH_EVENT_TYPES = [
  'login_failed', 'login_password_ok', 'login_succeeded', 'login_step_up_required', 'login_rate_limited', 'login_blocked_locked', 'login_blocked_inactive',
  'login_blocked_tenant_suspended', 'login_blocked_ip', 'mfa_verified', 'mfa_challenge_failed', 'mfa_enrolled', 'mfa_factor_removed', 'mfa_reset', 'password_changed',
  'password_reset_requested', 'recovery_link_opened', 'password_reset_completed', 'invite_sent', 'invite_link_opened', 'invite_accepted', 'session_revoked',
  'session_expired_idle', 'session_expired_absolute', 'logout', 'refresh_failed', 'account_locked', 'account_unlocked', 'membership_deactivated',
  'membership_reactivated', 'login_ip_throttled', 'session_token_reused',
] as const;

// ------------------------------------------------------------------ validators
export function isCidr(s: string): boolean {
  const m = /^([^/]+)\/(\d{1,3})$/.exec(s.trim());
  if (!m) return false;
  const [, addr, bits] = m as unknown as [string, string, string];
  const n = Number(bits);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) return n <= 32 && addr.split('.').every((o) => Number(o) <= 255 && String(Number(o)) === o);
  if (!/^[0-9a-fA-F:]+$/.test(addr) || !addr.includes(':') || n > 128) return false;
  const dbl = addr.split('::');
  if (dbl.length > 2) return false;
  const groups = dbl.flatMap((p) => (p === '' ? [] : p.split(':')));
  if (groups.some((g) => g === '' || g.length > 4)) return false;
  return dbl.length === 2 ? groups.length < 8 : groups.length === 8;
}

/** Masks the last IPv4 octet / the IPv6 tail for list display (PL-8). */
export function maskIp(ip: string | undefined): string {
  if (!ip) return '';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip.replace(/\.\d{1,3}$/, '.x');
  if (ip.includes(':')) return `${ip.split(':').slice(0, 3).join(':')}:x`;
  return 'x';
}

export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s);

export const ERR: Record<string, string> = {
  'identity.code_duplicate': 'This tenant code is already in use.',
  'identity.tenant_not_ready': 'Tenant not ready to activate.',
  'identity.setting_out_of_range': 'A value is out of the allowed range.',
  'identity.user_exists': 'A user with this email already exists for this tenant.',
  'identity.annex_invalid_transition': 'This status change is no longer allowed. Reload to see the current status.',
  'auth.forbidden': 'You are not allowed to do this.',
  'common.validation_failed': 'Some values are not valid.',
  'common.not_found': 'Not found.',
  'common.payload_too_large': 'The file is larger than 15 MB.',
  'common.unsupported_media_type': 'Only PDF, PNG or JPEG files can be uploaded.',
  'common.upload_quarantined': 'The file is still being scanned.',
};
export const errorText = (f: Fail) => ERR[f.code] ?? 'Something went wrong. Try again.';
export const RELOAD_COPY = 'This record was changed by someone else. Reload to see the latest version.';
export const MFA_COPY = 'This action needs two-step verification. Log in again with your authenticator code.';
