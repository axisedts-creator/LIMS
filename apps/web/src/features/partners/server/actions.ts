'use server';
// Server actions for the staff partner screens (TRD §5.3). Errors become { ok:false, status, code, errors } because a thrown ApiError loses its code across the
// action boundary in production. Versioned writes send If-Match `"<version>"`; writes TRD §5.3 marks "required" send the caller's Idempotency-Key.
// Patient / doctor / credit-party searches travel in a POST body (never a URL) and are capped like the C3/C4 APIs allow.
import 'server-only';
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import {
  KEY_RE, UUID_RE,
  type ActionResult, type Branch, type Centre, type CreditPartyHit, type DoctorHit, type PatientHit, type Settings,
} from './types';

async function run<T>(f: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await f() };
  } catch (e) {
    if (e instanceof ApiError) {
      const p = e.problem;
      return { ok: false, status: e.status, code: p.code, title: p.title, ...(Array.isArray(p['errors']) ? { errors: p['errors'] as { path: string; code: string }[] } : {}) };
    }
    throw e;
  }
}
const bad = () => new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
const uuid = (v: string) => {
  if (!UUID_RE.test(v)) throw bad();
  return v;
};
const A = '/v1/partners/admin';
const json = { 'content-type': 'application/json' };

function send<T>(method: 'POST' | 'PUT', path: string, body: unknown, o: { key?: string; version?: number; etag?: string } = {}) {
  if (o.key !== undefined && !KEY_RE.test(o.key)) throw bad();
  if (o.version !== undefined && (!Number.isInteger(o.version) || o.version < 1)) throw bad();
  if (o.etag !== undefined && !/^"\d+"$/.test(o.etag)) throw bad();
  return serverFetch<T>(path, {
    method,
    headers: { ...json, ...(o.key ? { 'idempotency-key': o.key } : {}), ...(o.version !== undefined ? { 'if-match': `"${o.version}"` } : {}), ...(o.etag ? { 'if-match': o.etag } : {}) },
    body: JSON.stringify(body),
  });
}
const post = <T>(path: string, body: unknown, o?: { key?: string; version?: number }) => send<T>('POST', path, body, o);
const code64 = (s: string) => {
  if (typeof s !== 'string' || s.length < 1 || s.length > 64) throw bad();
  return s;
};

// ---- searches (C4 patient search, C3 doctor / credit-party search, C2 branches / centres) ----
const q = (v: string, max: number) => {
  if (typeof v !== 'string' || v.trim() === '') throw bad();
  return v.slice(0, max);
};
export async function searchPatientsAction(query: string): Promise<ActionResult<PatientHit[]>> {
  return run(async () => (await serverFetch<{ data: PatientHit[] }>('/v1/frontdesk/patients/search', { method: 'POST', headers: json, body: JSON.stringify({ query: q(query, 100), limit: 20 }) })).data);
}
export async function searchDoctorsAction(text: string): Promise<ActionResult<DoctorHit[]>> {
  return run(async () => (await serverFetch<{ data: DoctorHit[] }>('/v1/catalog/doctors/search', { method: 'POST', headers: json, body: JSON.stringify({ q: q(text, 64), limit: 20 }) })).data);
}
/** C3 listCreditParties takes a code/name prefix of at most 20 characters. */
export async function searchCreditPartiesAction(text: string): Promise<ActionResult<CreditPartyHit[]>> {
  return run(async () => (await serverFetch<{ data: CreditPartyHit[] }>(`/v1/catalog/credit-parties?${new URLSearchParams({ q: q(text, 20), limit: '20' })}`)).data);
}
export async function listBranchesAction(): Promise<ActionResult<Branch[]>> {
  return run(async () => (await serverFetch<{ data: { branch_id?: string; id?: string; name: string; is_active?: boolean }[] }>('/v1/identity/branches')).data.filter((b) => b.is_active !== false).map((b) => ({ id: (b.branch_id ?? b.id) as string, name: b.name })));
}
export async function listCentresAction(): Promise<ActionResult<Centre[]>> {
  return run(async () => (await serverFetch<{ data: { centre_id?: string; id?: string; name: string; branch_id?: string; is_active?: boolean }[] }>('/v1/identity/centres')).data.filter((c) => c.is_active !== false).map((c) => ({ id: (c.centre_id ?? c.id) as string, name: c.name, ...(c.branch_id ? { branch_id: c.branch_id } : {}) })));
}

// ---- partners (SA2, SA5, SA6, SA7, SA9, SA10-SA12) ----
export async function createPartnerAction(b: { partner_code: string; name: string; credit_party_id: string; receiving_branch_id: string; receiving_centre_id: string; conversion_mode: string }, key: string) {
  return run(() => post(`${A}/partners`, { ...b, credit_party_id: uuid(b.credit_party_id), receiving_branch_id: uuid(b.receiving_branch_id), receiving_centre_id: uuid(b.receiving_centre_id) }, { key }));
}
export async function suspendPartnerAction(partnerId: string, version: number, reasonCode: string, reasonText?: string) {
  return run(() => post(`${A}/partners/${uuid(partnerId)}/suspend`, { reason_code: code64(reasonCode), ...(reasonText ? { reason_text: reasonText.slice(0, 300) } : {}) }, { version }));
}
export async function reactivatePartnerAction(partnerId: string, version: number) {
  return run(() => post(`${A}/partners/${uuid(partnerId)}/reactivate`, {}, { version }));
}
export async function resyncPartnerAction(partnerId: string, scopes: ('price_list' | 'statements' | 'tracking')[]) {
  return run(() => post(`${A}/partners/${uuid(partnerId)}/resync`, { scopes }));
}
export async function invitePartnerUserAction(partnerId: string, b: { email: string; display_name: string; partner_role: 'partner_admin' | 'partner_member' }, key: string) {
  return run(() => post(`${A}/partners/${uuid(partnerId)}/users`, b, { key }));
}
export async function changePartnerUserRoleAction(userId: string, version: number, role: 'partner_admin' | 'partner_member') {
  return run(() => post(`${A}/partner-users/${uuid(userId)}/role`, { partner_role: role }, { version }));
}
export async function deactivatePartnerUserAction(userId: string, version: number, reasonCode: string) {
  return run(() => post(`${A}/partner-users/${uuid(userId)}/deactivate`, { reason_code: code64(reasonCode) }, { version }));
}
export async function reactivatePartnerUserAction(userId: string, version: number) {
  return run(() => post(`${A}/partner-users/${uuid(userId)}/reactivate`, {}, { version }));
}

// ---- manifests (SI3, SI4, SI5) ----
export async function receiveManifestAction(manifestId: string, version: number, lines: { line_id: string; outcome: 'received' | 'not_received'; reason_code?: string }[], key: string) {
  if (lines.length < 1 || lines.length > 200) throw bad();
  return run(() => post(`${A}/manifests/${uuid(manifestId)}/receive`, { lines: lines.map((l) => ({ line_id: uuid(l.line_id), outcome: l.outcome, ...(l.outcome === 'not_received' ? { reason_code: code64(l.reason_code ?? '') } : {}) })) }, { key, version }));
}
export async function retryLineAction(lineId: string, version: number, patientId: string | undefined, key: string) {
  return run(() => post(`${A}/manifest-lines/${uuid(lineId)}/retry`, patientId ? { patient_id: uuid(patientId) } : {}, { key, version }));
}
export async function markLineNotReceivedAction(lineId: string, version: number, reasonCode: string) {
  return run(() => post(`${A}/manifest-lines/${uuid(lineId)}/not-received`, { reason_code: code64(reasonCode) }, { version }));
}

// ---- pickups (SP2, SP3, SP4) ----
export async function schedulePickupAction(pickupId: string, version: number, b: { scheduled_start: string; scheduled_end: string; assignee_text: string }) {
  if (b.assignee_text.trim() === '' || b.assignee_text.length > 80) throw bad();
  return run(() => post(`${A}/pickup-requests/${uuid(pickupId)}/schedule`, b, { version }));
}
export async function markPickedUpAction(pickupId: string, version: number) {
  return run(() => post(`${A}/pickup-requests/${uuid(pickupId)}/picked-up`, {}, { version }));
}
export async function rejectPickupAction(pickupId: string, version: number, reasonCode: string) {
  return run(() => post(`${A}/pickup-requests/${uuid(pickupId)}/reject`, { reason_code: code64(reasonCode) }, { version }));
}

// ---- referrer mapping (SR2, SR3) ----
export async function mapReferrerAction(referrerId: string, version: number, catalogDoctorId: string) {
  return run(() => post(`${A}/referrers/${uuid(referrerId)}/map`, { catalog_doctor_id: uuid(catalogDoctorId) }, { version }));
}
export async function rejectMappingAction(referrerId: string, version: number, reasonCode: string) {
  return run(() => post(`${A}/referrers/${uuid(referrerId)}/reject-mapping`, { reason_code: code64(reasonCode) }, { version }));
}
export async function unmapReferrerAction(referrerId: string, version: number) {
  return run(() => post(`${A}/referrers/${uuid(referrerId)}/unmap`, {}, { version }));
}

// ---- settings (SS2): the whole object, If-Match = the ETag of the GET ----
export async function saveSettingsAction(s: Settings, etag: string) {
  return run(() => send<Settings>('PUT', `${A}/settings`, s, { etag }));
}
