'use server';
// C13.T19 manifest write actions (M1, M4–M10) + the line-form lookups (P2, F1) through the partner BFF (partnerApi: session, CSRF, path guard).
// Only a small allowlisted result reaches the browser: ok/id/version, a code, and validation messages (errors[].message, partner-safe by contract). No upstream body, no failure codes.
import 'server-only';
import { partnerApi } from '@/core/api';
import { isUuid } from '../common/api';

export interface FieldIssue { path?: string; message: string }
export type ActionResult = { ok: true; id?: string; version?: number } | { ok: false; code: string; issues?: FieldIssue[] };

const KEY = /^[A-Za-z0-9_-]{8,64}$/;
const bad: ActionResult = { ok: false, code: 'common.validation_failed' };
const ifMatch = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? { 'if-match': `"${v}"` } : undefined);

async function send(path: string, method: string, body: unknown, headers: Record<string, string> = {}): Promise<ActionResult> {
  const r = await partnerApi<{ id?: string; version?: number }>(path, { method, ...(body !== undefined ? { body } : {}), headers });
  if (r.ok) return { ok: true, ...(typeof r.data?.id === 'string' ? { id: r.data.id } : {}), ...(typeof r.data?.version === 'number' ? { version: r.data.version } : {}) };
  const raw = (r.problem as { errors?: unknown }).errors;
  const issues = Array.isArray(raw)
    ? raw.slice(0, 50).flatMap((e: { path?: unknown; message?: unknown }) => (typeof e?.message === 'string' ? [{ ...(typeof e.path === 'string' ? { path: e.path.slice(0, 200) } : {}), message: e.message.slice(0, 300) }] : []))
    : [];
  return { ok: false, code: typeof r.problem.code === 'string' ? r.problem.code : 'common.internal', ...(issues.length ? { issues } : {}) };
}

/** M1 createManifest: the draft number is assigned by the API (US-04.1). */
export async function createManifestAction(idempotencyKey: string): Promise<ActionResult> {
  if (!KEY.test(idempotencyKey)) return bad;
  return send('/v1/partners/manifests', 'POST', {}, { 'idempotency-key': idempotencyKey });
}

/** M4 updateManifest: empty values are sent as unset[]. */
export async function updateManifestAction(manifestId: string, version: number, v: { notes: string; collected_on: string }): Promise<ActionResult> {
  const h = ifMatch(version);
  if (!isUuid(manifestId) || !h || v.notes.length > 500 || (v.collected_on !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(v.collected_on))) return bad;
  const unset = [v.notes === '' ? 'notes' : '', v.collected_on === '' ? 'collected_on' : ''].filter(Boolean);
  return send(`/v1/partners/manifests/${manifestId}`, 'PATCH', { ...(v.notes ? { notes: v.notes } : {}), ...(v.collected_on ? { collected_on: v.collected_on } : {}), ...(unset.length ? { unset } : {}) }, h);
}

/** M5 addManifestLine (If-Match = manifest version) / M6 replaceManifestLine (If-Match = line version). `input` is validated by the API; only its shape is checked here. */
export async function saveLineAction(manifestId: string, lineId: string | null, version: number, input: unknown, idempotencyKey: string): Promise<ActionResult> {
  const h = ifMatch(version);
  if (!isUuid(manifestId) || (lineId !== null && !isUuid(lineId)) || !h || typeof input !== 'object' || input === null) return bad;
  if (lineId === null) {
    if (!KEY.test(idempotencyKey)) return bad;
    return send(`/v1/partners/manifests/${manifestId}/lines`, 'POST', input, { ...h, 'idempotency-key': idempotencyKey });
  }
  return send(`/v1/partners/manifests/${manifestId}/lines/${lineId}`, 'PUT', input, h);
}

/** M7 deleteManifestLine. */
export async function removeLineAction(manifestId: string, lineId: string, lineVersion: number): Promise<ActionResult> {
  const h = ifMatch(lineVersion);
  if (!isUuid(manifestId) || !isUuid(lineId) || !h) return bad;
  return send(`/v1/partners/manifests/${manifestId}/lines/${lineId}`, 'DELETE', undefined, h);
}

/** M8 submitManifest (all errors at once come back as issues). */
export async function submitManifestAction(manifestId: string, version: number, idempotencyKey: string): Promise<ActionResult> {
  const h = ifMatch(version);
  if (!isUuid(manifestId) || !h || !KEY.test(idempotencyKey)) return bad;
  return send(`/v1/partners/manifests/${manifestId}/submit`, 'POST', {}, { ...h, 'idempotency-key': idempotencyKey });
}

/** M10 discardManifest. */
export async function discardManifestAction(manifestId: string, version: number): Promise<ActionResult> {
  const h = ifMatch(version);
  if (!isUuid(manifestId) || !h) return bad;
  return send(`/v1/partners/manifests/${manifestId}/discard`, 'POST', {}, h);
}

const WITHDRAW = new Set(['entered_in_error', 'samples_not_sent', 'duplicate_manifest', 'other']); // 05-SCHEMA §7 manifest_withdraw_reasons
/** M9 withdrawManifest. */
export async function withdrawManifestAction(manifestId: string, version: number, reasonCode: string, reasonText: string, idempotencyKey: string): Promise<ActionResult> {
  const h = ifMatch(version);
  if (!isUuid(manifestId) || !h || !WITHDRAW.has(reasonCode) || reasonText.length > 300 || !KEY.test(idempotencyKey)) return bad;
  return send(`/v1/partners/manifests/${manifestId}/withdraw`, 'POST', { reason_code: reasonCode, ...(reasonText ? { reason_text: reasonText } : {}) }, { ...h, 'idempotency-key': idempotencyKey });
}

export interface OrderableOption { orderable_id: string; kind: string; code: string; name: string; amount_paisa?: number }
/** P2 searchPartnerOrderables for the line form's Tests combobox (non-PHI search text). */
export async function searchOrderablesAction(q: string): Promise<OrderableOption[]> {
  const term = q.replace(/[\u0000-\u001f\u007f/\\]/g, ' ').replace(/\.{2,}/g, '.').trim().slice(0, 64);
  if (!term) return [];
  const r = await partnerApi<{ data?: { orderable_id: string; kind: string; code: string; name: string; unit_price?: { amount_paisa?: number } }[] }>(`/v1/partners/orderables?${new URLSearchParams({ q: term, limit: '20' })}`);
  if (!r.ok || !Array.isArray(r.data?.data)) return [];
  return r.data.data.map((o) => ({ orderable_id: String(o.orderable_id), kind: String(o.kind), code: String(o.code), name: String(o.name), ...(typeof o.unit_price?.amount_paisa === 'number' ? { amount_paisa: o.unit_price.amount_paisa } : {}) }));
}

/** F1 listPartnerReferrers (active only) for the line form's Doctor combobox. */
export async function listReferrersAction(): Promise<{ id: string; display_name: string; mapping_state?: string }[]> {
  const r = await partnerApi<{ data?: { id: string; display_name: string; mapping_state?: string }[] }>('/v1/partners/referrers?is_active=true');
  if (!r.ok || !Array.isArray(r.data?.data)) return [];
  return r.data.data.map((x) => ({ id: String(x.id), display_name: String(x.display_name), ...(typeof x.mapping_state === 'string' ? { mapping_state: x.mapping_state } : {}) }));
}
