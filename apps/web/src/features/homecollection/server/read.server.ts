import 'server-only';
// H1 listHomeVisits, H10 listHomeRoutes, H12 listAvailablePhlebotomists, H20 coded sets, identity centres (BFF reads).
// Every row is rebuilt from an allow-list so nothing else the API sends (phone, coordinates, notes, device ids) can reach a client component.
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import type { Centre, CodedValue, PersonRef, PhlebotomistOption, RouteDto, SpecimensSummary, VisitAddress, VisitDto } from '../types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const SETS = ['visit_cancel_reasons', 'unassign_reasons'] as const;
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
