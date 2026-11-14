// Dispatch-board URL -> H1 / H10 query. Only whitelisted, well-formed, single values reach the API; anything else is dropped (07-SECURITY §3).
import { dayNpt, isRealDay } from './labels';
import type { BoardFilter, Centre } from './types';

type SP = Record<string, string | string[] | undefined>;

export const VISIT_STATUSES = ['unassigned', 'assigned', 'in_progress', 'completed', 'failed', 'cancelled'] as const;
export const VISIT_KINDS = ['booking', 'front_desk', 'recollection', 'revisit'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;

/** A single string value; an array (repeated parameter) is dropped. */
const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);
/** A comma list where EVERY token must be allowed; one bad token drops the whole parameter. */
const list = (v: string | string[] | undefined, allowed: readonly string[]): string[] => {
  const s = one(v);
  if (!s) return [];
  const toks = s.split(',');
  return toks.every((t) => allowed.includes(t)) ? [...new Set(toks)] : [];
};

export const HANDOVER_STATUSES = ['pending', 'confirmed', 'discrepancy'] as const;
export const DEVICE_STATUSES = ['active', 'signed_off', 'wipe_requested', 'wiped'] as const;

/** Handovers URL -> H13 query: status (default pending), one centre (default the first the actor may use), cursor. Nothing else is forwarded. */
export function handoverQuery(sp: SP, centres: readonly Centre[]) {
  const st = list(sp['status'], HANDOVER_STATUSES);
  const status = st.length ? st.join(',') : 'pending';
  const c = one(sp['centre_id']);
  const known = centres.length === 0 || centres.some((x) => x.id === c);
  const centreId = c && UUID.test(c) && known ? c : centres[0]?.id;
  const cursor = one(sp['cursor']);
  const q = new URLSearchParams({ status, limit: '50' });
  if (centreId) q.set('to_centre_id', centreId);
  if (cursor && CURSOR.test(cursor)) q.set('cursor', cursor);
  return { status, centreId, q };
}

/** Phones URL -> H16 query: whitelisted status, cursor. */
export function deviceQuery(sp: SP) {
  const status = list(sp['status'], DEVICE_STATUSES);
  const cursor = one(sp['cursor']);
  const q = new URLSearchParams({ limit: '100' });
  if (status.length) q.set('status', status.join(','));
  if (cursor && CURSOR.test(cursor)) q.set('cursor', cursor);
  return { q };
}

export function dispatchQuery(sp: SP, now: number, centres: readonly Centre[]) {
  const d = one(sp['date']);
  const date = isRealDay(d) ? d : dayNpt(now);
  const c = one(sp['centre_id']);
  const known = centres.length === 0 || centres.some((x) => x.id === c);
  const centreId = c && UUID.test(c) && known ? c : centres[0]?.id;
  const status = list(sp['status'], VISIT_STATUSES);
  const kind = list(sp['kind'], VISIT_KINDS)[0];
  const flags = one(sp['has_open_flags']) === 'true';
  const cursor = one(sp['cursor']);

  const visits = new URLSearchParams({ route_date: date });
  const routes = new URLSearchParams({ route_date: date });
  if (centreId) { visits.set('centre_id', centreId); routes.set('centre_id', centreId); }
  if (status.length) visits.set('status', status.join(','));
  if (kind) visits.set('kind', kind);
  if (flags) visits.set('has_open_flags', 'true');
  visits.set('limit', '100');
  if (cursor && CURSOR.test(cursor)) visits.set('cursor', cursor);
  const filter: BoardFilter = { status, ...(kind ? { kind } : {}), ...(flags ? { has_open_flags: true } : {}) };
  return { date, centreId, visits, routes, filter };
}
