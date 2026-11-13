'use server';
// Platform console server actions (PL-1..PL-8). Every action re-checks the platform permission and validates its inputs
// before calling /v1/identity/platform/* — the browser can call actions directly, so the client checks are only UX.
import { call, P, platformPermissions, qs } from './server';
import {
  ANNEX_STATUSES, CURSOR_RE, DATE_RE, EMAIL_RE, IDEMPOTENCY_RE, MAX_CIDRS, MAX_UPLOAD_BYTES, PAN_RE, PERM, TENANT_CODE_RE, UNIT_CODE_RE, UPLOAD_TYPES,
  isCidr, isUuid,
  type AnnexRecord, type AnnexStatus, type DeadLetter, type Fail, type LifecycleAction, type PageOf, type PlatformSession, type Result,
  type Settings, type StaffMember, type SupportSession, type Tenant,
} from './shared';

const invalid = (): Fail => ({ ok: false, status: 400, code: 'common.validation_failed' });
const forbidden = (): Fail => ({ ok: false, status: 403, code: 'auth.forbidden' });
const isVersion = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const str = (v: unknown, min: number, max: number): v is string => typeof v === 'string' && v.trim().length >= min && v.length <= max;
const json = (method: string, body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const ifMatch = (v: number) => ({ 'if-match': `"${v}"` });

async function need(perm: string): Promise<boolean> {
  return (await platformPermissions()).has(perm);
}

// ------------------------------------------------------------------ tenants (PL-2, PL-3)
export async function loadTenantsAction(cursor: string): Promise<Result<PageOf<Tenant>>> {
  if (!(await need(PERM.read))) return forbidden();
  if (!CURSOR_RE.test(cursor)) return invalid();
  return call(`${P}/tenants${qs({ limit: '50', cursor })}`);
}

export interface ProvisionInput {
  code: string; legal_name: string; display_name: string; pan?: string; calendar_display?: string;
  first_branch: { code: string; name: string; address_text?: string };
  first_centre: { code: string; name: string; kind: string; address_text?: string };
  first_admin: { email: string; display_name: string };
}
export async function provisionTenantAction(input: ProvisionInput, key: string): Promise<Result<Tenant>> {
  if (!(await need(PERM.manage))) return forbidden();
  const b = input?.first_branch, c = input?.first_centre, a = input?.first_admin;
  const ok = IDEMPOTENCY_RE.test(key) && TENANT_CODE_RE.test(input?.code ?? '') && str(input.legal_name, 1, 200) && str(input.display_name, 1, 120)
    && (input.pan === undefined || PAN_RE.test(input.pan))
    && (input.calendar_display === undefined || ['AD', 'BS', 'AD_BS', 'BS_AD'].includes(input.calendar_display))
    && !!b && UNIT_CODE_RE.test(b.code) && str(b.name, 1, 120) && (b.address_text === undefined || str(b.address_text, 0, 300))
    && !!c && UNIT_CODE_RE.test(c.code) && str(c.name, 1, 120) && ['own', 'franchise', 'home_collection'].includes(c.kind) && (c.address_text === undefined || str(c.address_text, 0, 300))
    && !!a && str(a.email, 3, 254) && EMAIL_RE.test(a.email) && str(a.display_name, 1, 120);
  if (!ok) return invalid();
  const body = {
    code: input.code, legal_name: input.legal_name, display_name: input.display_name, timezone: 'Asia/Kathmandu',
    ...(input.pan ? { pan: input.pan } : {}), ...(input.calendar_display ? { calendar_display: input.calendar_display } : {}),
    first_branch: { code: b.code, name: b.name, ...(b.address_text ? { address_text: b.address_text } : {}) },
    first_centre: { code: c.code, name: c.name, kind: c.kind, ...(c.address_text ? { address_text: c.address_text } : {}) },
    first_admin: { email: a.email, display_name: a.display_name },
  };
  return call(`${P}/tenants`, json('POST', body, { 'idempotency-key': key }));
}

export async function tenantLifecycleAction(
  tenantId: string, action: LifecycleAction, version: number, extra: { reason_text?: string; confirm_code?: string } = {},
): Promise<Result<Tenant>> {
  if (!(await need(PERM.manage))) return forbidden();
  if (!isUuid(tenantId) || !isVersion(version) || !['activate', 'suspend', 'reactivate', 'terminate'].includes(action)) return invalid();
  let body: Record<string, string> | undefined;
  if (action === 'suspend') {
    if (!str(extra.reason_text, 1, 500)) return invalid();
    body = { reason_text: extra.reason_text };
  } else if (action === 'terminate') {
    if (!str(extra.reason_text, 1, 500) || !TENANT_CODE_RE.test(extra.confirm_code ?? '')) return invalid();
    body = { confirm_code: extra.confirm_code!, reason_text: extra.reason_text };
  }
  return call(`${P}/tenants/${tenantId}/${action}`, body ? json('POST', body, ifMatch(version)) : { method: 'POST', headers: ifMatch(version) });
}

export async function getTenantSettingsAction(tenantId: string): Promise<Result<Settings>> {
  if (!(await need(PERM.read))) return forbidden();
  if (!isUuid(tenantId)) return invalid();
  return call(`${P}/tenants/${tenantId}/settings`);
}

export async function patchTenantSettingsAction(tenantId: string, version: number, patch: Record<string, unknown>): Promise<Result<Settings>> {
  if (!(await need(PERM.manage))) return forbidden();
  const keys = Object.keys(patch ?? {});
  if (!isUuid(tenantId) || !isVersion(version) || keys.length === 0 || keys.some((k) => !/^[a-z][a-z0-9_]{1,63}$/.test(k) || k === 'version')) return invalid();
  return call(`${P}/tenants/${tenantId}/settings`, json('PATCH', patch, ifMatch(version)));
}

// LD-114: no feature-flag actions; the platform flag list read is not approved, so PL-3's Feature flags tab is an empty state.

export async function inviteTenantAdminAction(tenantId: string, email: string, displayName: string, key: string): Promise<Result<unknown>> {
  if (!(await need(PERM.manage))) return forbidden();
  if (!isUuid(tenantId) || !IDEMPOTENCY_RE.test(key) || !str(email, 3, 254) || !EMAIL_RE.test(email) || !str(displayName, 1, 120)) return invalid();
  return call(`${P}/tenants/${tenantId}/admin-invitations`, json('POST', { email, display_name: displayName }, { 'idempotency-key': key }));
}

// ------------------------------------------------------------------ IRD annexes (PL-4)
export async function listAnnexesAction(tenantId: string): Promise<Result<{ data: AnnexRecord[] }>> {
  if (!(await need(PERM.read))) return forbidden();
  if (!isUuid(tenantId)) return invalid();
  return call(`${P}/ird-annexes${qs({ tenant_id: tenantId })}`);
}

export interface TransitionInput { to_status: AnnexStatus; submitted_on?: string; completed_on?: string; reference_no?: string; note?: string }
export async function transitionAnnexAction(recordId: string, version: number, input: TransitionInput): Promise<Result<AnnexRecord>> {
  if (!(await need(PERM.manage))) return forbidden();
  if (!isUuid(recordId) || !isVersion(version) || !ANNEX_STATUSES.includes(input?.to_status)) return invalid();
  const body: Record<string, string> = { to_status: input.to_status };
  if (input.submitted_on !== undefined) { if (!DATE_RE.test(input.submitted_on)) return invalid(); body['submitted_on'] = input.submitted_on; }
  if (input.completed_on !== undefined) { if (!DATE_RE.test(input.completed_on)) return invalid(); body['completed_on'] = input.completed_on; }
  if (input.reference_no !== undefined) { if (!str(input.reference_no, 1, 100)) return invalid(); body['reference_no'] = input.reference_no; }
  if (input.note !== undefined) { if (!str(input.note, 1, 1000)) return invalid(); body['note'] = input.note; }
  return call(`${P}/ird-annexes/${recordId}/transition`, json('POST', body, ifMatch(version)));
}

export async function uploadAnnexDocumentAction(recordId: string, form: FormData, key: string): Promise<Result<unknown>> {
  if (!(await need(PERM.manage))) return forbidden();
  const file = form?.get('file') as (Blob & { name?: string }) | null;
  if (!isUuid(recordId) || !IDEMPOTENCY_RE.test(key) || !file || typeof file !== 'object' || typeof file.size !== 'number' || typeof file.arrayBuffer !== 'function') return invalid();
  if (file.size > MAX_UPLOAD_BYTES) return { ok: false, status: 413, code: 'common.payload_too_large' };
  if (!(UPLOAD_TYPES as readonly string[]).includes(file.type)) return { ok: false, status: 415, code: 'common.unsupported_media_type' };
  // [CONV] the multipart body is encoded here (one `file` part) so it does not depend on which FormData/Blob implementation the runtime provides.
  const boundary = `----lims${newBoundary()}`;
  const name = (file.name ?? 'document').replace(/[^\w.\- ]/g, '_').slice(0, 200) || 'document';
  const head = new TextEncoder().encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${file.type}\r\n\r\n`);
  const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  const data = new Uint8Array(await file.arrayBuffer());
  const body = new Uint8Array(head.length + data.length + tail.length);
  body.set(head, 0); body.set(data, head.length); body.set(tail, head.length + data.length);
  return call(`${P}/ird-annexes/${recordId}/documents`, {
    method: 'POST', body, headers: { 'idempotency-key': key, 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
}
const newBoundary = () => globalThis.crypto.randomUUID().replace(/-/g, '');

// ------------------------------------------------------------------ support sessions (PL-5)
export async function listTenantSupportSessionsAction(tenantId: string): Promise<Result<PageOf<SupportSession>>> {
  if (!(await need(PERM.read))) return forbidden();
  if (!isUuid(tenantId)) return invalid();
  return call(`${P}/support-sessions${qs({ tenant_id: tenantId })}`);
}

export interface OpenSupportInput { tenant_id: string; scope: string; reason_text: string; ticket_ref: string; duration_minutes: number }
export async function openSupportSessionAction(input: OpenSupportInput, key: string): Promise<Result<SupportSession>> {
  const perms = await platformPermissions();
  if (!perms.has(PERM.supportOpen)) return forbidden();
  // 07-SECURITY E-6: Admin scope only for superadmin (platform.tenant.manage) [CONV]
  if (input?.scope === 'admin' && !perms.has(PERM.manage)) return forbidden();
  const d = input?.duration_minutes;
  if (!IDEMPOTENCY_RE.test(key) || !isUuid(input?.tenant_id) || !['read_only', 'admin'].includes(input.scope) || !str(input.reason_text, 10, 500)
    || !str(input.ticket_ref, 1, 60) || !Number.isInteger(d) || d < 5 || d > 60) return invalid();
  const body = { tenant_id: input.tenant_id, scope: input.scope, reason_text: input.reason_text, ticket_ref: input.ticket_ref, duration_minutes: d };
  return call(`${P}/support-sessions`, json('POST', body, { 'idempotency-key': key }));
}

export async function activateSupportSessionAction(id: string, version: number): Promise<Result<SupportSession>> {
  if (!(await need(PERM.supportOpen))) return forbidden();
  if (!isUuid(id) || !isVersion(version)) return invalid();
  return call(`${P}/support-sessions/${id}/activate`, { method: 'POST', headers: ifMatch(version) });
}

export async function endSupportSessionAction(id: string): Promise<Result<SupportSession>> {
  if (!(await need(PERM.supportOpen))) return forbidden();
  if (!isUuid(id)) return invalid();
  return call(`${P}/support-sessions/${id}/end`, { method: 'POST' });
}

// ------------------------------------------------------------------ dead letters (PL-6)
export async function resolveDeadLetterAction(id: string, op: 'replay' | 'discard', version: number, reasonText?: string): Promise<Result<DeadLetter>> {
  if (!(await need(PERM.deadLetters))) return forbidden();
  if (!isUuid(id) || !isVersion(version) || (op !== 'replay' && op !== 'discard')) return invalid();
  if (op === 'discard' && !str(reasonText, 1, 500)) return invalid();
  if (reasonText !== undefined && !str(reasonText, 1, 500)) return invalid();
  return call(`${P}/dead-letters/${id}/${op}`, json('POST', reasonText ? { reason_text: reasonText } : {}, ifMatch(version)));
}

// ------------------------------------------------------------------ platform staff (PL-7)
export interface StaffInviteInput { email: string; display_name: string; role_code: string; allowed_cidrs: string[] }
export async function inviteStaffAction(input: StaffInviteInput, key: string): Promise<Result<StaffMember>> {
  if (!(await need(PERM.staff))) return forbidden();
  const cidrs = input?.allowed_cidrs;
  if (!IDEMPOTENCY_RE.test(key) || !str(input?.email, 3, 254) || !EMAIL_RE.test(input.email) || !str(input.display_name, 1, 120)
    || !['platform_superadmin', 'platform_support'].includes(input.role_code)
    || !Array.isArray(cidrs) || cidrs.length > MAX_CIDRS || !cidrs.every((c) => typeof c === 'string' && c.length <= 43 && isCidr(c))) return invalid();
  const body = { email: input.email, display_name: input.display_name, role_code: input.role_code, allowed_cidrs: cidrs };
  return call(`${P}/staff`, json('POST', body, { 'idempotency-key': key }));
}

export async function listPlatformSessionsAction(): Promise<Result<{ data: PlatformSession[] }>> {
  if (!(await need(PERM.staff))) return forbidden();
  return call(`${P}/sessions`);
}

export async function revokePlatformSessionAction(id: string): Promise<Result<unknown>> {
  if (!(await need(PERM.staff))) return forbidden();
  if (!isUuid(id)) return invalid();
  return call(`${P}/sessions/${id}/revoke`, { method: 'POST' });
}
