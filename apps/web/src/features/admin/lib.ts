// Shared (client + server) helpers for the tenant admin screens (C2 04-UI-UX §3, §6). No server imports here.

export type SP = Record<string, string | string[] | undefined>;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Path segment guard for ids sent back to the API (UUIDs in production; never a slash, dot or query). */
export const SEG_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const E164_RE = /^\+[1-9][0-9]{7,14}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const ROLE_CODE_RE = /^[a-z][a-z0-9_]{1,39}$/;
export const UNIT_CODE_RE = /^[A-Za-z0-9-]{1,16}$/;
export const DAY_MS = 86_400_000;
export const MAX_RANGE_DAYS = 31;

/** Permissions whose holders receive or work on samples (08 A13 D-13(2), A17 D-63; 04-UI-UX AD-2). */
const HUB_EXACT = new Set(['lab.specimen.receive', 'micro.culture.read', 'micro.culture.work', 'anatomic.case.read', 'anatomic.case.work', 'anatomic.case.signout']);
export const isHubLabPermission = (code: string) => HUB_EXACT.has(code) || code.startsWith('lab.result.');
export const HUB_USER_COPY =
  'These roles receive or work on samples. Staff who process samples from other collection centres need All centres or every collection centre whose samples they process. Before receipt, a sample is visible only at its collection centre.';
export const HUB_ROLE_COPY =
  'Members with these permissions who process samples from other collection centres need All centres or every collection centre whose samples they process.';
export const SESSION_WARNING = 'Saving logs this user out of all sessions.';
export const CONFLICT_COPY = 'This record was changed by someone else. Reload to see the latest version.';
export const MFA_REQUIRED_COPY = 'This action needs two-step verification. Log in again with your authenticator code.';
export const SAVED_COPY = 'Saved. Other screens update within 30 seconds.';
export const RANGE_COPY = 'Choose 31 days or fewer';

/** Error code → user copy (04-UI-UX §3: codes are never shown raw). Unknown codes get the generic line. */
const COPY: Record<string, string> = {
  'identity.user_exists': 'This email cannot be invited. Use a different email or contact the LIMS provider support.',
  'identity.last_admin_protected': 'This change would leave the lab without an administrator. Give another user the administrator role first.',
  'identity.role_unknown': 'One of the selected roles is no longer available. Reload and choose again.',
  'identity.self_action_forbidden': 'You cannot do this to your own account. Ask another administrator.',
  'identity.code_duplicate': 'This code is already in use. Choose a different code.',
  'identity.setting_out_of_range': 'A value is outside the allowed range. Check the highlighted field.',
  'identity.export_too_large': 'This export is too large. Choose a shorter date range or fewer records.',
  'common.validation_failed': 'Some values are not valid. Check the highlighted fields.',
  'common.unsupported_media_type': 'This file type is not accepted. Use a PNG or JPEG image.',
  'common.upload_quarantined': 'This file did not pass the security scan. Upload a different file.',
  'common.payload_too_large': 'This file is too large.',
  'common.rate_limited': 'Too many requests. Wait a moment and try again.',
  'common.not_found': 'This record was not found.',
  'auth.forbidden': 'You do not have permission to do this.',
  'auth.password_breached': 'This password appears in known data breaches. Choose a different one.',
  'auth.password_policy_violation': 'Use at least 12 characters (and no more than 72 bytes).',
  'auth.login_failed': 'Your current password is incorrect.',
  'auth.invalid_credentials': 'Your current password is incorrect.',
};
export const GENERIC_COPY = 'Something went wrong. Try again; if it keeps failing, contact support with the reference.';
export const copyFor = (code: string | undefined) => (code && COPY[code]) || GENERIC_COPY;

export const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
export const pick = (v: string | string[] | undefined, allowed: readonly string[]) => { const s = one(v); return s !== undefined && allowed.includes(s) ? s : undefined; };
export const idParam = (v: string | string[] | undefined) => { const s = one(v); return s !== undefined && UUID_RE.test(s) ? s : undefined; };
export const segParam = (v: string | string[] | undefined) => { const s = one(v); return s !== undefined && SEG_RE.test(s) ? s : undefined; };

/** Date range filter (AD-10/12): default last 24 h; over 31 days → error and no request. */
export function rangeFrom(sp: SP, now = Date.now()): { from: string; to: string; error?: string } {
  const f = Date.parse(one(sp['occurred_at_from']) ?? '');
  const t = Date.parse(one(sp['occurred_at_to']) ?? '');
  const to = Number.isNaN(t) ? now : t;
  const from = Number.isNaN(f) ? to - DAY_MS : f;
  const out = { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
  if (from > to) return { ...out, error: 'The start must be before the end.' };
  return to - from > MAX_RANGE_DAYS * DAY_MS ? { ...out, error: RANGE_COPY } : out;
}

const DT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kathmandu', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
/** A.D. display DD/MM/YYYY hh:mm A in Asia/Kathmandu (04-UI-UX §3). */
export function fmt(iso: string | undefined | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : DT.format(d).replace(',', '').toUpperCase();
}
export const fmtNum = (n: number | undefined | null) => (n === undefined || n === null ? '—' : n.toLocaleString('en-US'));
/** Lists show the IP with the last octet masked (04-UI-UX §3). */
export const maskIp = (ip: string | undefined | null) => (!ip ? '—' : ip.includes(':') ? ip.replace(/:[^:]*$/, ':x') : ip.replace(/\.\d+$/, '.x'));
export const shortId = (id: string) => (id.length > 8 ? `${id.slice(0, 8)}…` : id);
export const qs = (o: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export interface RoleRef { role_id: string; code: string; name: string }
export interface Role extends RoleRef { description?: string; is_default: boolean; mfa_required: boolean; permission_codes: string[]; member_count: number; is_active: boolean; version: number }
export interface Permission { code: string; privileged: boolean; module: string; phase: string; assignable: boolean }
export interface Branch { branch_id: string; code: string; name: string; address_text?: string; phone?: string; is_processing_lab: boolean; is_active: boolean; version: number }
export interface Centre { centre_id: string; code: string; name: string; branch_id: string; kind: 'own' | 'franchise' | 'home_collection'; address_text?: string; phone?: string; is_active: boolean; version: number }
export interface UserSummary { membership_id: string; display_name: string; email_masked: string; status: 'invited' | 'active' | 'deactivated'; is_locked: boolean; roles: RoleRef[]; all_centres: boolean; centre_count: number; mfa_enrolled: boolean; last_login_at?: string; version: number }
export interface UserDetail extends UserSummary { phone_masked?: string; branch_ids?: string[]; centre_ids?: string[]; signatory?: { display_title?: string; registration_no?: string; signature_asset_id?: string } }
export interface SessionSummary { session_id: string; membership_id?: string; display_name?: string; state: string; aal: string; created_at: string; last_seen_at?: string; idle_expires_at?: string; absolute_expires_at?: string; client_ip_masked?: string; user_agent_family?: string; is_support: boolean }
export interface Page<T> { data: T[]; page?: { limit?: number; next_cursor?: string } }

export const STATUS_LABEL: Record<string, string> = { invited: 'Invited', active: 'Active', deactivated: 'Deactivated' };
export const rolesText = (roles: RoleRef[]) => {
  const names = roles.map((r) => r.name);
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
};
/** Codes granted by a set of roles (lookups from listRoles). */
export const codesOf = (roleIds: readonly string[], roles: readonly Role[]) => roles.filter((r) => roleIds.includes(r.role_id)).flatMap((r) => r.permission_codes);
