import 'server-only';
// H1 listHomeVisits, H10 listHomeRoutes, H12 listAvailablePhlebotomists, H20 coded sets, identity centres (BFF reads).
// Every row is rebuilt from an allow-list so nothing else the API sends (phone, coordinates, notes, device ids) can reach a client component.
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import type { Assignment, Centre, Collection, CodedValue, DeviceRow, HandoverDetail, HandoverItem, HandoverSummary, Payment, PersonRef, PhlebotomistOption, RouteDto, SettingsDto, SpecimenRow, SpecimensSummary, Transition, VisitAddress, VisitDetail, VisitDto, VisitFlag } from '../types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const SETS = ['visit_cancel_reasons', 'unassign_reasons', 'wipe_reasons', 'review_reasons', 'flag_resolutions', 'revisit_reasons'] as const;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
export type CodedSetName = (typeof SETS)[number];
export interface Page<T> { data?: T[]; page?: { limit?: number; next_cursor?: string } }

const bad = () => new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
const arr = <T,>(r: { data?: T[] } | undefined): T[] => (Array.isArray(r?.data) ? r!.data! : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const int = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : d);
const opt = <V,>(k: string, v: V | undefined): Record<string, V> => (v === undefined ? {} : { [k]: v });
const person = (v: unknown): PersonRef | undefined => {
  const p = v as { membership_id?: unknown; display_name?: unknown } | undefined;
  return p && typeof p.membership_id === 'string' ? { membership_id: p.membership_id, display_name: str(p.display_name) ?? '' } : undefined;
};
const summary = (v: unknown): SpecimensSummary => {
  const s = (v ?? {}) as Record<string, unknown>;
  return { expected: int(s['expected']), collected: int(s['collected']), held: int(s['held']), received: int(s['received']), rejected: int(s['rejected']) };
};
const address = (v: unknown): VisitAddress | undefined => {
  const a = v as Record<string, unknown> | undefined;
  if (!a || typeof a !== 'object') return undefined;
  const out: VisitAddress = { ...opt('address_text', str(a['address_text'])), ...opt('landmark', str(a['landmark'])), ...opt('latitude', str(a['latitude'])), ...opt('longitude', str(a['longitude'])) };
  return Object.keys(out).length ? out : undefined;
};

export const toVisit = (v: VisitDto): VisitDto => ({
  id: String(v.id), version: int(v.version), kind: String(v.kind), status: String(v.status), centre_id: String(v.centre_id),
  patient_display_name: str(v.patient_display_name) ?? '',
  open_flag_kinds: Array.isArray(v.open_flag_kinds) ? v.open_flag_kinds.filter((k): k is string => typeof k === 'string') : [],
  specimens_summary: summary(v.specimens_summary),
  ...opt('window_start', str(v.window_start)), ...opt('window_end', str(v.window_end)), ...opt('area_hint', str(v.area_hint)),
  ...opt('route_id', str(v.route_id)), ...opt('route_date', str(v.route_date)),
  ...(typeof v.route_sequence === 'number' && Number.isSafeInteger(v.route_sequence) ? { route_sequence: v.route_sequence } : {}),
  ...opt('phlebotomist', person(v.phlebotomist)), ...opt('order_id', str(v.order_id)), ...opt('address', address(v.address)),
  ...opt('note_for_phlebotomist', str(v.note_for_phlebotomist)),
});
const toRoute = (r: RouteDto): RouteDto => ({
  id: String(r.id), version: int(r.version), centre_id: String(r.centre_id), route_date: String(r.route_date),
  phlebotomist: person(r.phlebotomist) ?? { membership_id: '', display_name: '' },
  visit_ids_in_order: Array.isArray(r.visit_ids_in_order) ? r.visit_ids_in_order.filter((i): i is string => typeof i === 'string') : [],
  active_visits: int(r.active_visits), completed_visits: int(r.completed_visits), ...opt('last_ack_at', str(r.last_ack_at)),
});

/** H1: `q` is already reduced to a whitelist by query.ts. */
export async function listVisits(q: URLSearchParams): Promise<{ rows: VisitDto[]; next?: string }> {
  const r = await serverFetch<Page<VisitDto>>(`/v1/homecollection/visits?${q.toString()}`);
  const next = str(r?.page?.next_cursor);
  return { rows: arr(r).map(toVisit), ...(next ? { next } : {}) };
}
/** H10. */
export async function listRoutes(q: URLSearchParams): Promise<RouteDto[]> {
  return arr(await serverFetch<Page<RouteDto>>(`/v1/homecollection/routes?${q.toString()}`)).map(toRoute);
}
/** H20: active values only, in the API's order. */
export async function listReasons(set: CodedSetName): Promise<CodedValue[]> {
  if (!SETS.includes(set)) throw bad();
  return arr(await serverFetch<{ data?: CodedValue[] }>(`/v1/homecollection/reasons?set=${set}`))
    .filter((c) => c && typeof c.code === 'string' && c.is_active !== false)
    .map((c) => ({ code: c.code, display: str(c.display) ?? c.code, requires_text: c.requires_text === true, is_active: true }));
}

// ---- HC-T20 ----
const unexpected = () => new ApiError(500, problem('common.internal', 'Unexpected response', 500));
const bool = (v: unknown): boolean => { if (typeof v !== 'boolean') throw unexpected(); return v; };
const num = (v: unknown): number => { if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw unexpected(); return v; };
const text = (v: unknown): string => { if (typeof v !== 'string') throw unexpected(); return v; };

const toHandover = (h: Record<string, unknown>): HandoverSummary => ({
  id: String(h['id']), version: int(h['version']), status: String(h['status']),
  from: { display_name: str((h['from'] as { display_name?: unknown } | undefined)?.display_name) ?? '' },
  to_centre_id: String(h['to_centre_id']), handed_over_at: String(h['handed_over_at']), item_count: int(h['item_count']),
  ...(typeof h['received_count'] === 'number' && Number.isSafeInteger(h['received_count']) ? { received_count: h['received_count'] } : {}),
});
/** H13: `q` is already reduced to a whitelist by query.ts. */
export async function listHandovers(q: URLSearchParams): Promise<{ rows: HandoverSummary[]; next?: string }> {
  const r = await serverFetch<Page<Record<string, unknown>>>(`/v1/homecollection/handovers?${q.toString()}`);
  const next = str(r?.page?.next_cursor);
  return { rows: arr(r).map(toHandover), ...(next ? { next } : {}) };
}
/** H14: items carry barcode + specimen type only (D-125); a visit id never leaves this function. */
export async function getHandover(id: string): Promise<HandoverDetail> {
  if (!UUID.test(id)) throw bad();
  const h = await serverFetch<Record<string, unknown>>(`/v1/homecollection/handovers/${id}`);
  const items = (Array.isArray(h?.['items']) ? (h['items'] as Record<string, unknown>[]) : [])
    .filter((i) => i && typeof i['specimen_id'] === 'string' && typeof i['barcode'] === 'string')
    .map((i): HandoverItem => ({ specimen_id: String(i['specimen_id']), barcode: String(i['barcode']), specimen_type_code: str(i['specimen_type_code']) ?? '', ...opt('outcome', str(i['outcome'])) }));
  return { ...toHandover(h), items, ...opt('received_by_display', str(h['received_by_display'])), ...opt('received_at', str(h['received_at'])) };
}

const toDevice = (d: Record<string, unknown>): DeviceRow => ({
  id: String(d['id']), version: int(d['version']),
  membership_id: UUID.test(String(d['membership_id'])) ? String(d['membership_id']) : '',
  display_name: str(d['display_name']) ?? '', platform: str(d['platform']) ?? '', model: str(d['model']) ?? '',
  app_version: str(d['app_version']) ?? '', status: String(d['status']),
  ...opt('last_seen_at', str(d['last_seen_at'])), ...opt('last_push_at', str(d['last_push_at'])), ...opt('last_snapshot_at', str(d['last_snapshot_at'])),
});
/** H16. */
export async function listDevices(q: URLSearchParams): Promise<{ rows: DeviceRow[]; next?: string }> {
  const r = await serverFetch<Page<Record<string, unknown>>>(`/v1/homecollection/devices?${q.toString()}`);
  const next = str(r?.page?.next_cursor);
  return { rows: arr(r).map(toDevice), ...(next ? { next } : {}) };
}

/** H18: every key is rebuilt; a response that does not have them all is an error, not a guess. */
export async function getSettings(): Promise<SettingsDto> {
  const s = await serverFetch<Record<string, unknown>>('/v1/homecollection/settings');
  if (!s || typeof s !== 'object' || !Array.isArray(s['payment_methods'])) throw unexpected();
  return {
    version: int(s['version']), min_app_version: text(s['min_app_version']), sync_interval_seconds: num(s['sync_interval_seconds']), offline_purge_hours: num(s['offline_purge_hours']),
    capture_gps: bool(s['capture_gps']), gps_retention_days: num(s['gps_retention_days']), map_handoff_enabled: bool(s['map_handoff_enabled']),
    manual_barcode_entry_allowed: bool(s['manual_barcode_entry_allowed']), second_identifier: text(s['second_identifier']),
    collection_consent_text_version: text(s['collection_consent_text_version']), collection_consent_text: text(s['collection_consent_text']),
    payment_methods: (s['payment_methods'] as Record<string, unknown>[]).map((p) => ({ code: text(p['code']), display: text(p['display']), requires_reference: p['requires_reference'] === true })),
    handover_confirmation_required: bool(s['handover_confirmation_required']), handover_overdue_hours: num(s['handover_overdue_hours']),
    max_visits_per_route: num(s['max_visits_per_route']), notify_phlebotomist_on_assign: bool(s['notify_phlebotomist_on_assign']),
    notify_patient_on_assign: bool(s['notify_patient_on_assign']), clock_tolerance_seconds: num(s['clock_tolerance_seconds']),
  };
}

/** Centres the actor may use. A failure is the caller's to tolerate. */
export async function listCentres(): Promise<Centre[]> {
  return arr(await serverFetch<{ data?: Centre[] }>('/v1/identity/centres'))
    .filter((c) => c && typeof c.id === 'string' && UUID.test(c.id))
    .map((c) => ({ id: c.id, name: str(c.name) ?? '' }));
}
/** H12: only a uuid and a day reach the URL. */
export async function listPhlebotomists(centreId: string, routeDate: string): Promise<PhlebotomistOption[]> {
  if (!UUID.test(centreId) || !DAY.test(routeDate)) throw bad();
  const q = new URLSearchParams({ centre_id: centreId, route_date: routeDate });
  return arr(await serverFetch<{ data?: PhlebotomistOption[] }>(`/v1/homecollection/phlebotomists?${q.toString()}`))
    .filter((p) => p && typeof p.membership_id === 'string')
    .map((p) => ({ membership_id: p.membership_id, display_name: str(p.display_name) ?? '', active_visits: int(p.active_visits), route_full: p.route_full === true }));
}

// ---- HC-T19: H2 getHomeVisit (VisitDetailDto, no phone: H21 only). Every nested row is rebuilt from an allow-list. ----
type Row = Record<string, unknown>;
const rows = (v: unknown): Row[] => (Array.isArray(v) ? v.filter((r): r is Row => !!r && typeof r === 'object') : []);
const toSpecimen = (s: Row): SpecimenRow => ({
  specimen_id: String(s['specimen_id']), specimen_type_code: str(s['specimen_type_code']) ?? '', status: str(s['status']) ?? '',
  ...opt('container_code', str(s['container_code'])), ...opt('collected_at', str(s['collected_at'])), ...opt('collection_status', str(s['collection_status'])),
  ...opt('scan_method', str(s['scan_method'])), ...(typeof s['barcode_verified'] === 'boolean' ? { barcode_verified: s['barcode_verified'] } : {}),
});
const toCollection = (c: Row): Collection => {
  const rv = c['review'] as Row | undefined;
  const by = (c['collected_by'] as Row | undefined)?.['display_name'];
  return {
    id: String(c['id']), version: int(c['version']), specimen_id: String(c['specimen_id']), status: str(c['status']) ?? '',
    ...opt('hold_code', str(c['hold_code'])), ...opt('scan_method', str(c['scan_method'])), ...opt('collected_at', str(c['collected_at'])),
    ...(typeof c['barcode_verified'] === 'boolean' ? { barcode_verified: c['barcode_verified'] } : {}),
    ...(typeof by === 'string' ? { collected_by: { display_name: by } } : {}),
    ...(rv && typeof rv === 'object' && typeof rv['decision'] === 'string'
      ? { review: { decision: rv['decision'], reason_code: str(rv['reason_code']) ?? '', ...opt('by_display', str(rv['by_display'])), ...opt('at', str(rv['at'])) } }
      : {}),
  };
};
const toFlag = (f: Row): VisitFlag => ({
  id: String(f['id']), version: int(f['version']), kind: str(f['kind']) ?? '', status: str(f['status']) ?? '', created_at: str(f['created_at']) ?? '',
  ...opt('resolved_at', str(f['resolved_at'])), ...opt('resolution_code', str(f['resolution_code'])), ...opt('resolved_by_display', str(f['resolved_by_display'])),
});
const toAssignment = (a: Row): Assignment => ({
  display_name: str(a['display_name']) ?? '', route_date: str(a['route_date']) ?? '', assigned_at: str(a['assigned_at']) ?? '', ...opt('assigned_by_display', str(a['assigned_by_display'])),
});
const toTransition = (t: Row): Transition => ({ to: str(t['to']) ?? '', at: str(t['at']) ?? '', ...opt('from', str(t['from'])), ...opt('actor_display', str(t['actor_display'])) });
const toPayment = (p: Row): Payment => {
  const m = (p['amount'] ?? {}) as Row;
  return { method_code: str(p['method_code']) ?? '', amount: { amount_paisa: int(m['amount_paisa']), currency: 'NPR' }, ...opt('captured_at', str(p['captured_at'])), ...opt('outcome', str(p['outcome'])) };
};

/** H2. One call (it writes the access-log row). Address, landmark, coordinates and note are kept only for `visit.assign` holders (`withPatient`). */
export async function getVisit(id: string, withPatient: boolean): Promise<VisitDetail> {
  if (!isUuid(id)) throw bad();
  const v = await serverFetch<VisitDto & Row>(`/v1/homecollection/visits/${id}`);
  const s = toVisit(v);
  if (!withPatient) { delete s.address; delete s.note_for_phlebotomist; }
  return {
    ...s,
    ...opt('outcome', str(v['outcome'])), ...opt('registration_no', str(v['registration_no'])), ...opt('last_device_ack_at', str(v['last_device_ack_at'])),
    specimens: rows(v['specimens']).map(toSpecimen), collections: rows(v['collections']).map(toCollection), flags: rows(v['flags']).map(toFlag),
    assignments: rows(v['assignments']).map(toAssignment), transitions: rows(v['transitions']).map(toTransition), payments: rows(v['payments']).map(toPayment),
  };
}
