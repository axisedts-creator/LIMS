import 'server-only';
// H3 assign, H4 unassign, H5 schedule, H6 cancel (Idempotency-Key from the caller + If-Match = visit version), H11 resequence (If-Match = route version).
// Only a uuid reaches a path, and every value is re-validated here: the browser is not trusted.
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import type { ScheduleBody } from '../types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9_-]{1,64}$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DEC = /^-?\d{1,3}(\.\d{1,6})?$/;
const bad = () => new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
const json = { 'content-type': 'application/json' };

const ver = (version: number) => {
  if (!Number.isSafeInteger(version) || version < 0) throw bad();
  return { 'if-match': `"${version}"` };
};
const idem = (key: string) => {
  if (!KEY.test(key)) throw bad();
  return { 'idempotency-key': key };
};
const visitPath = (id: string, op: string) => {
  if (!UUID.test(id)) throw bad();
  return `/v1/homecollection/visits/${id}/${op}`;
};
const text = (v: string | undefined, max: number) => {
  const t = v?.trim();
  if (t && t.length > max) throw bad();
  return t || undefined;
};
const instant = (v: string) => {
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw bad();
  return new Date(t).toISOString();
};

export interface Out { status?: string; version?: number }
const UNSET = ['note_for_phlebotomist', 'landmark', 'coordinates'];

/** H5 scheduleHomeVisit. */
export function scheduleVisit(id: string, version: number, b: ScheduleBody, key: string) {
  const p = visitPath(id, 'schedule');
  const a = b.address;
  const addressText = text(a?.address_text, 500);
  const landmark = text(a?.landmark, 200);
  const note = text(b.note_for_phlebotomist, 500);
  if (!addressText || (a.latitude === undefined) !== (a.longitude === undefined)) throw bad();
  if (a.latitude !== undefined && (!DEC.test(a.latitude) || Math.abs(+a.latitude) > 90 || !DEC.test(a.longitude!) || Math.abs(+a.longitude!) > 180)) throw bad();
  const unset = [...new Set(b.unset ?? [])];
  if (unset.some((u) => !UNSET.includes(u))) throw bad();
  const start = instant(b.window_start);
  const end = instant(b.window_end);
  if (Date.parse(end) <= Date.parse(start) || Date.parse(end) - Date.parse(start) > 12 * 3_600_000) throw bad();
  return serverFetch<Out>(p, {
    method: 'POST', headers: { ...json, ...idem(key), ...ver(version) },
    body: JSON.stringify({
      window_start: start, window_end: end,
      address: { address_text: addressText, ...(landmark ? { landmark } : {}), ...(a.latitude !== undefined ? { latitude: a.latitude, longitude: a.longitude } : {}) },
      ...(note ? { note_for_phlebotomist: note } : {}),
      ...(unset.length ? { unset } : {}),
    }),
  });
}

/** H3 assignHomeVisit (also the reassign path). `route_sequence` only when given. */
export function assignVisit(id: string, version: number, b: { membershipId: string; routeDate: string; position?: number }, key: string) {
  const p = visitPath(id, 'assign');
  if (!UUID.test(b.membershipId) || !DAY.test(b.routeDate)) throw bad();
  if (b.position !== undefined && (!Number.isSafeInteger(b.position) || b.position < 1 || b.position > 60)) throw bad();
  return serverFetch<Out>(p, {
    method: 'POST', headers: { ...json, ...idem(key), ...ver(version) },
    body: JSON.stringify({ phlebotomist_membership_id: b.membershipId, route_date: b.routeDate, ...(b.position !== undefined ? { route_sequence: b.position } : {}) }),
  });
}

/** H4 unassignHomeVisit. */
export function unassignVisit(id: string, version: number, reasonCode: string, reasonText: string | undefined, key: string) {
  const p = visitPath(id, 'unassign');
  if (!CODE.test(reasonCode)) throw bad();
  const t = text(reasonText, 500);
  return serverFetch<Out>(p, { method: 'POST', headers: { ...json, ...idem(key), ...ver(version) }, body: JSON.stringify({ reason_code: reasonCode, ...(t ? { reason_text: t } : {}) }) });
}

/** H6 cancelHomeVisit. */
export function cancelVisit(id: string, version: number, reasonCode: string, reasonText: string | undefined, key: string) {
  const p = visitPath(id, 'cancel');
  if (!CODE.test(reasonCode)) throw bad();
  const t = text(reasonText, 500);
  return serverFetch<Out>(p, { method: 'POST', headers: { ...json, ...idem(key), ...ver(version) }, body: JSON.stringify({ reason_code: reasonCode, ...(t ? { reason_text: t } : {}) }) });
}

/** H11 resequenceHomeRoute: the server checks the set equals the route's active visits. */
export function resequenceRoute(id: string, version: number, visitIds: readonly string[]) {
  if (!UUID.test(id) || visitIds.length < 1 || visitIds.length > 60 || !visitIds.every((v) => UUID.test(v))) throw bad();
  return serverFetch<Out>(`/v1/homecollection/routes/${id}/sequence`, { method: 'POST', headers: { ...json, ...ver(version) }, body: JSON.stringify({ visit_ids: visitIds }) });
}
