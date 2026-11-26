import 'server-only';
// PHLEBO-UI-FULL-1: phlebotomist applications (BFF). listPhleboApplications / decidePhleboApplication.
// Every row is rebuilt from an allow-list; only a uuid reaches a path; the browser is not trusted.
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import type { ApplicationDocument, ApplicationRow } from '../applications.types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9_-]{1,64}$/;
const STATUSES = ['submitted', 'approved', 'rejected'] as const;
const bad = () => new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const int = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);

const toDocument = (d: Record<string, unknown>): ApplicationDocument => ({
  id: str(d['id']), kind: str(d['kind']), file_name: str(d['file_name']), content_type: str(d['content_type']), byte_size: int(d['byte_size']),
});
const toRow = (a: Record<string, unknown>): ApplicationRow => ({
  id: str(a['id']), version: int(a['version']), status: str(a['status']),
  full_name: str(a['full_name']), phone_e164: str(a['phone_e164']), email: str(a['email']), area: str(a['area']),
  employment_type: str(a['employment_type']), shift_count: str(a['shift_count']),
  day_slots: Array.isArray(a['day_slots']) ? a['day_slots'].filter((s): s is string => typeof s === 'string') : [],
  submitted_at: str(a['submitted_at']), decided_at: str(a['decided_at']), decided_by_display: str(a['decided_by_display']), decision_note: str(a['decision_note']),
  documents: Array.isArray(a['documents']) ? (a['documents'] as Record<string, unknown>[]).filter((d) => UUID.test(str(d?.['id']))).map(toDocument) : [],
});

export async function listApplications(status?: string): Promise<{ rows: ApplicationRow[]; submitted: number }> {
  const q = status && (STATUSES as readonly string[]).includes(status) ? `?status=${status}` : '';
  const r = await serverFetch<{ items?: Record<string, unknown>[]; submitted_count?: unknown }>(`/v1/homecollection/applications${q}`);
  const items = Array.isArray(r?.items) ? r!.items! : [];
  return { rows: items.filter((a) => UUID.test(str(a?.['id']))).map(toRow), submitted: int(r?.submitted_count) };
}

/** Roles an approved phlebotomist can be given: active roles that can use the phlebotomist app. */
export async function listPhleboRoles(): Promise<{ id: string; name: string }[]> {
  const r = await serverFetch<{ data?: Record<string, unknown>[] }>('/v1/identity/roles');
  return (Array.isArray(r?.data) ? r!.data! : [])
    .filter((x) => x['is_active'] === true && UUID.test(str(x['role_id'])) && Array.isArray(x['permission_codes']) && x['permission_codes'].includes('homecollection.sync.upload'))
    .map((x) => ({ id: str(x['role_id']), name: str(x['name']) }));
}

/**
 * Approve = invite + decide. The applicant's name, email and phone are read again from the API (never taken from the browser).
 * The invite uses an Idempotency-Key fixed to the application, so a retry after a half-finished approval replays the same
 * invite instead of failing or creating a second account. The applicant then gets the lab's normal invite email and sets a password.
 */
export async function approveApplication(id: string, version: number, roleId: string, centreId: string, key: string): Promise<{ status?: string; version?: number }> {
  if (!UUID.test(id) || !UUID.test(roleId) || !UUID.test(centreId) || !KEY.test(key) || !Number.isSafeInteger(version) || version < 0) throw bad();
  const a = await serverFetch<Record<string, unknown>>(`/v1/homecollection/applications/${id}`);
  if (!a || str(a['status']) !== 'submitted' || int(a['version']) !== version) throw new ApiError(409, problem('common.version_conflict', 'Version conflict', 409));
  await serverFetch<Record<string, unknown>>('/v1/identity/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': `phlebo-application-${id}` },
    body: JSON.stringify({ email: str(a['email']), display_name: str(a['full_name']), phone_e164: str(a['phone_e164']), role_ids: [roleId], all_centres: false, centre_ids: [centreId] }),
  });
  return decideApplication(id, version, 'approve', undefined, key);
}

export async function decideApplication(id: string, version: number, decision: 'approve' | 'reject', note: string | undefined, key: string): Promise<{ status?: string; version?: number }> {
  if (!UUID.test(id) || !KEY.test(key) || !Number.isSafeInteger(version) || version < 0 || (decision !== 'approve' && decision !== 'reject')) throw bad();
  const text = note?.trim();
  if ((text && text.length > 500) || (decision === 'reject' && !text)) throw bad();
  const r = await serverFetch<Record<string, unknown>>(`/v1/homecollection/applications/${id}/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'if-match': `"${version}"`, 'Idempotency-Key': key },
    body: JSON.stringify({ decision, ...(text ? { note: text } : {}) }),
  });
  return { status: str(r?.['status']), version: int(r?.['version']) };
}
