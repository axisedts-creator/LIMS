import 'server-only';
// H3 assign, H4 unassign, H5 schedule, H6 cancel (Idempotency-Key from the caller + If-Match = visit version), H11 resequence (If-Match = route version).
// HC-T20: H15 confirm handover + H17 wipe phone (Idempotency-Key + If-Match), H19 PUT settings (If-Match).
// Only a uuid reaches a path, and every value is re-validated here: the browser is not trusted.
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import type { ScheduleBody, SettingsBody } from '../types';

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
  return { 'Idempotency-Key': key };
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

/** H15 confirmHandover: exactly the handover's items, each received true/false. Idempotency-Key from the caller (a retry re-sends it) + If-Match = handover version. */
export function confirmHandover(id: string, version: number, items: readonly { specimen_id: string; received: boolean }[], key: string) {
  if (!UUID.test(id) || items.length < 1 || items.length > 50) throw bad();
  if (!items.every((i) => UUID.test(i.specimen_id) && typeof i.received === 'boolean')) throw bad();
  return serverFetch<Out>(`/v1/homecollection/handovers/${id}/confirm`, {
    method: 'POST', headers: { ...json, ...idem(key), ...ver(version) },
    body: JSON.stringify({ items: items.map((i) => ({ specimen_id: i.specimen_id, received: i.received })) }),
  });
}

/** H17 requestDeviceWipe. */
export function wipeDevice(id: string, version: number, reasonCode: string, reasonText: string | undefined, key: string) {
  if (!UUID.test(id) || !CODE.test(reasonCode)) throw bad();
  const t = text(reasonText, 500);
  return serverFetch<Out>(`/v1/homecollection/devices/${id}/wipe`, {
    method: 'POST', headers: { ...json, ...idem(key), ...ver(version) }, body: JSON.stringify({ reason_code: reasonCode, ...(t ? { reason_text: t } : {}) }),
  });
}

const PAYMENT_CODES = ['cash', 'card', 'esewa', 'khalti', 'fonepay_qr', 'bank_transfer'];
const SEMVER = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const RANGES: Record<string, readonly [number, number]> = {
  sync_interval_seconds: [60, 900], offline_purge_hours: [4, 24], gps_retention_days: [7, 365], handover_overdue_hours: [1, 24], max_visits_per_route: [1, 60], clock_tolerance_seconds: [60, 3600],
};
const BOOLS = ['capture_gps', 'map_handoff_enabled', 'manual_barcode_entry_allowed', 'handover_confirmation_required', 'notify_phlebotomist_on_assign', 'notify_patient_on_assign'];

/** H19 updateHomecollectionSettings: the whole mutable set, re-validated here (the browser is not trusted). If-Match = settings version. */
export function saveSettings(version: number, b: SettingsBody) {
  const out: Record<string, unknown> = {};
  for (const [k, [lo, hi]] of Object.entries(RANGES)) {
    const n = (b as unknown as Record<string, unknown>)[k];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < lo || n > hi) throw bad();
    out[k] = n;
  }
  for (const k of BOOLS) {
    const v = (b as unknown as Record<string, unknown>)[k];
    if (typeof v !== 'boolean') throw bad();
    out[k] = v;
  }
  if (typeof b.min_app_version !== 'string' || b.min_app_version.length > 20 || !SEMVER.test(b.min_app_version)) throw bad();
  if (typeof b.collection_consent_text_version !== 'string' || b.collection_consent_text_version.length < 1 || b.collection_consent_text_version.length > 40) throw bad();
  if (typeof b.collection_consent_text !== 'string' || b.collection_consent_text.trim().length < 1 || b.collection_consent_text.length > 2000) throw bad();
  if (b.second_identifier !== 'phone' && b.second_identifier !== 'birth_date') throw bad();
  const pm = b.payment_methods;
  if (!Array.isArray(pm) || pm.length < 1 || pm.length > 10) throw bad();
  const seen = new Set<string>();
  for (const p of pm) {
    if (!PAYMENT_CODES.includes(p.code) || seen.has(p.code) || typeof p.display !== 'string' || p.display.trim().length < 1 || p.display.length > 40 || typeof p.requires_reference !== 'boolean') throw bad();
    seen.add(p.code);
  }
  return serverFetch<Out>('/v1/homecollection/settings', {
    method: 'PUT', headers: { ...json, ...ver(version) },
    body: JSON.stringify({
      ...out, min_app_version: b.min_app_version, second_identifier: b.second_identifier,
      collection_consent_text_version: b.collection_consent_text_version, collection_consent_text: b.collection_consent_text,
      payment_methods: pm.map((p) => ({ code: p.code, display: p.display.trim(), requires_reference: p.requires_reference })),
    }),
  });
}

/** H11 resequenceHomeRoute: the server checks the set equals the route's active visits. */
export function resequenceRoute(id: string, version: number, visitIds: readonly string[]) {
  if (!UUID.test(id) || visitIds.length < 1 || visitIds.length > 60 || !visitIds.every((v) => UUID.test(v))) throw bad();
  return serverFetch<Out>(`/v1/homecollection/routes/${id}/sequence`, { method: 'POST', headers: { ...json, ...ver(version) }, body: JSON.stringify({ visit_ids: visitIds }) });
}
