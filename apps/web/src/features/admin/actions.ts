'use server';
// Server actions for the tenant admin screens (C2 04-UI-UX §6). Each action maps to ONE identity operation; bodies are built from
// typed arguments only (never tenant_id/permissions, REQ-SEC-080); ids are checked as single path segments before use.
// The API enforces permissions; these actions add no authority of their own.
import { call, type Result } from './server/api';
import { SEG_RE } from './lib';

const ID = '/v1/identity';
const IMAGE_TYPES = ['image/png', 'image/jpeg']; // server re-checks magic bytes and scans (P-19)
const bad = <T>(): Result<T> => ({ ok: false, status: 400, code: 'common.validation_failed', pointers: [] });
const seg = (id: string) => (SEG_RE.test(id) ? encodeURIComponent(id) : undefined);
async function on<T>(id: string, f: (s: string) => Promise<Result<T>>): Promise<Result<T>> {
  const s = seg(id);
  return s ? f(s) : bad<T>();
}
const only = <T extends object>(o: T, keys: readonly string[]) => Object.fromEntries(Object.entries(o).filter(([k, v]) => keys.includes(k) && v !== undefined)) as Partial<T>;

// ---------------------------------------------------------------- users (AD-1..AD-3)
export async function searchUsers(query: string) {
  if (query.length < 2 || query.length > 100) return bad<{ data: unknown[] }>();
  return call<{ data: unknown[] }>('POST', `${ID}/users/search`, { body: { query } });
}
export interface InviteBody { email: string; display_name: string; phone_e164?: string; role_ids: string[]; all_centres: boolean; centre_ids?: string[]; branch_ids?: string[] }
export async function inviteUser(b: InviteBody) {
  return call<{ membership_id: string }>('POST', `${ID}/users`, { body: only(b, ['email', 'display_name', 'phone_e164', 'role_ids', 'all_centres', 'centre_ids', 'branch_ids']), idempotent: true });
}
export interface UserPatch { display_name?: string; phone_e164?: string; signatory_title?: string; signatory_registration_no?: string; unset?: string[] }
export async function updateUser(id: string, version: number, p: UserPatch) {
  return on(id, (s) => call<{ version: number }>('PATCH', `${ID}/users/${s}`, { body: only(p, ['display_name', 'phone_e164', 'signatory_title', 'signatory_registration_no', 'unset']), version }));
}
export async function setUserRoles(id: string, version: number, role_ids: string[]) {
  return on(id, (s) => call<{ version: number }>('PUT', `${ID}/users/${s}/roles`, { body: { role_ids }, version }));
}
export async function setUserCentreScope(id: string, version: number, b: { all_centres: boolean; centre_ids: string[]; branch_ids: string[] }) {
  return on(id, (s) => call<{ version: number }>('PUT', `${ID}/users/${s}/centre-scope`, { body: only(b, ['all_centres', 'centre_ids', 'branch_ids']), version }));
}
export type UserOp = 'lock' | 'unlock' | 'deactivate' | 'reactivate' | 'resend-invitation' | 'reset-mfa' | 'revoke-sessions';
const OPS: readonly UserOp[] = ['lock', 'unlock', 'deactivate', 'reactivate', 'resend-invitation', 'reset-mfa', 'revoke-sessions'];
const NEEDS_VERSION = new Set<UserOp>(['lock', 'unlock', 'deactivate', 'reactivate', 'reset-mfa']);
/** Membership actions; body is {reason_code, reason_text?} for lock/deactivate, {reason_text} for reset-mfa, none otherwise. */
export async function userAction(id: string, op: UserOp, version: number, reason?: { reason_code?: string; reason_text?: string }) {
  if (!OPS.includes(op)) return bad<{ version?: number }>();
  const body = op === 'lock' || op === 'deactivate' ? only(reason ?? {}, ['reason_code', 'reason_text']) : op === 'reset-mfa' ? only(reason ?? {}, ['reason_text']) : undefined;
  return on(id, (s) => call<{ version?: number }>('POST', `${ID}/users/${s}/${op}`, { ...(body ? { body } : {}), ...(NEEDS_VERSION.has(op) ? { version } : {}) }));
}
export async function uploadUserSignature(id: string, form: FormData) {
  const f = form.get('file');
  if (!(f instanceof Blob) || !IMAGE_TYPES.includes(f.type) || f.size > 1024 * 1024) return bad<{ version: number }>();
  return on(id, (s) => call<{ version: number }>('POST', `${ID}/users/${s}/signature`, { upload: { file: f, filename: (f as File).name || 'signature' }, idempotent: true }));
}
export async function revokeSession(sessionId: string) {
  return on(sessionId, (s) => call<null>('POST', `${ID}/sessions/${s}/revoke`));
}
export async function userHistory(membershipId: string) {
  return on(membershipId, () => call<{ data: Array<Record<string, unknown>> }>('GET', `${ID}/audit-entries`, { query: { row_id: membershipId, limit: '50' } }));
}

// ---------------------------------------------------------------- roles (AD-5)
export interface RoleBody { name: string; description?: string; permission_codes: string[]; mfa_required: boolean }
export async function createRole(b: RoleBody & { code: string }) {
  return call<{ role_id: string }>('POST', `${ID}/roles`, { body: only(b, ['code', 'name', 'description', 'permission_codes', 'mfa_required']), idempotent: true });
}
export async function updateRole(id: string, version: number, b: RoleBody) {
  return on(id, (s) => call<{ version: number }>('PUT', `${ID}/roles/${s}`, { body: only(b, ['name', 'description', 'permission_codes', 'mfa_required']), version }));
}
export async function deactivateRole(id: string, version: number) {
  return on(id, (s) => call<{ version: number }>('POST', `${ID}/roles/${s}/deactivate`, { version }));
}

// ---------------------------------------------------------------- branches / centres (AD-6, AD-7)
export type UnitKind = 'branches' | 'centres';
const UNIT_KEYS = { branches: ['code', 'name', 'address_text', 'phone', 'is_processing_lab', 'unset'], centres: ['code', 'name', 'branch_id', 'kind', 'address_text', 'phone', 'unset'] } as const;
export async function createUnit(kind: UnitKind, b: Record<string, unknown>) {
  if (!(kind in UNIT_KEYS)) return bad<Record<string, unknown>>();
  return call<Record<string, unknown>>('POST', `${ID}/${kind}`, { body: only(b, UNIT_KEYS[kind]), idempotent: true });
}
export async function updateUnit(kind: UnitKind, id: string, version: number, b: Record<string, unknown>) {
  if (!(kind in UNIT_KEYS)) return bad<Record<string, unknown>>();
  return on(id, (s) => call<Record<string, unknown>>('PATCH', `${ID}/${kind}/${s}`, { body: only(b, UNIT_KEYS[kind].filter((k) => k !== 'code')), version }));
}
export async function setUnitActive(kind: UnitKind, id: string, version: number, active: boolean) {
  if (!(kind in UNIT_KEYS)) return bad<Record<string, unknown>>();
  return on(id, (s) => call<Record<string, unknown>>('POST', `${ID}/${kind}/${s}/${active ? 'reactivate' : 'deactivate'}`, { version }));
}

// ---------------------------------------------------------------- settings (AD-8)
/** Tenant-editable TenantSettingsPatch fields (legal name, timezone and PAN are platform-managed). */
const SETTINGS_KEYS = [
  'calendar_display', 'idle_timeout_minutes', 'absolute_session_hours', 'password_min_length', 'support_access_mode', 'report_link_ttl_days', 'release_requires_payment',
  'partial_release_allowed', 'letterhead_default', 'numbering_prefix', 'patient_code_pattern', 'registration_no_pattern', 'barcode_pattern', 'invoice_no_pattern',
  'credit_note_no_pattern', 'receipt_no_pattern', 'barcode_prefix', 'accession_no_pattern', 'accession_prefix_histology', 'accession_prefix_cytology', 'accession_prefix_ihc',
  'accession_prefix_molecular', 'whatsapp_enabled', 'sms_enabled', 'email_enabled', 'sms_sender_id', 'retention_clinical_years', 'retention_audit_years',
  'retention_raw_instrument_years', 'auto_verification_enabled', 'westgard_mode', 'cbms_realtime_required', 'abbreviated_invoice_limit_paisa', 'display_name', 'address_lines',
  'phones', 'contact_email', 'website', 'receipt_footer_note', 'accent_color', 'logo_asset_id', 'letterhead_header_asset_id', 'letterhead_footer_asset_id', 'unset',
] as const;
export async function updateSettings(version: number, patch: Record<string, unknown>) {
  return call<Record<string, unknown> & { version: number }>('PATCH', `${ID}/settings`, { body: only(patch, SETTINGS_KEYS), version });
}
export async function uploadBrandingAsset(form: FormData) {
  const f = form.get('file');
  const kind = String(form.get('kind'));
  if (!(f instanceof Blob) || !IMAGE_TYPES.includes(f.type) || f.size > 2 * 1024 * 1024 || !['logo', 'letterhead_header', 'letterhead_footer'].includes(kind)) return bad<{ asset_id: string; kind: string; scan_state?: string }>();
  return call<{ asset_id: string; kind: string; scan_state?: string }>('POST', `${ID}/settings/branding-assets`, { upload: { file: f, filename: (f as File).name || kind, fields: { kind } }, idempotent: true });
}
export async function setFeatureFlag(code: string, version: number | undefined, is_enabled: boolean) {
  return on(code, (s) => call<{ is_enabled: boolean; version?: number }>('PUT', `${ID}/feature-flags/${s}`, { body: { is_enabled }, ...(version !== undefined ? { version } : {}) }));
}

// ---------------------------------------------------------------- my account (ME-1)
export async function changeOwnPassword(current_password: string, new_password: string) {
  return call<null>('POST', `${ID}/me/password`, { body: { current_password, new_password } });
}
export async function revokeOwnSession(id: string) {
  return on(id, (s) => call<null>('POST', `${ID}/me/sessions/${s}/revoke`));
}
export async function removeOwnMfaFactor(id: string) {
  return on(id, (s) => call<null>('POST', `${ID}/me/mfa-factors/${s}/remove`));
}

// ---------------------------------------------------------------- audit / support / exports / review (AD-12..AD-15)
export async function listAuthEvents(q: { occurred_at_from: string; occurred_at_to: string; event_type?: string; membership_id?: string }) {
  return call<{ data: Array<Record<string, unknown>>; page?: { next_cursor?: string } }>('GET', `${ID}/auth-events`, { query: { ...q, limit: '50' } });
}
export async function supportAction(id: string, op: 'approve' | 'deny' | 'revoke', version: number, reason_text?: string) {
  if (!['approve', 'deny', 'revoke'].includes(op)) return bad<Record<string, unknown>>();
  return on(id, (s) =>
    call<Record<string, unknown>>('POST', `${ID}/support-sessions/${s}/${op}`, { ...(op === 'approve' ? { version } : {}), ...(op === 'deny' ? { body: { reason_text } } : {}) }));
}
export async function createAuditExport(b: { source: string; occurred_at_from: string; occurred_at_to: string }) {
  if (!['audit_log', 'access_log', 'auth_events'].includes(b.source)) return bad<Record<string, unknown>>();
  return call<Record<string, unknown>>('POST', `${ID}/audit-exports`, { body: { source: b.source, occurred_at_from: b.occurred_at_from, occurred_at_to: b.occurred_at_to, format: 'csv' }, idempotent: true });
}
export async function recordAccessReview(memberships_reviewed: number, notes?: string) {
  return call<Record<string, unknown>>('POST', `${ID}/access-reviews`, { body: { memberships_reviewed, ...(notes ? { notes } : {}) }, idempotent: true });
}
