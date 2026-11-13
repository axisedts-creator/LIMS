'use server';
// C16.T-B6 server actions behind W1–W5. Server actions are public endpoints: permission, ids, keys and body shapes are re-checked here before
// anything reaches the API (which checks the permission again). Only ApiError maps to { ok:false }; anything else rethrows.
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import { UUID_RE, has } from './queue.server';
import * as api from './booking.server';
import { PERM } from './booking.server';

export type ActionResult<T = unknown> = { ok: true; data: T } | { ok: false; status: number; code: string };

const KEY = /^[A-Za-z0-9_-]{8,64}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = ['centre_visit', 'home_collection'] as const;
const STATUSES = ['confirmed', 'checked_in', 'completed', 'cancelled'] as const;
type Kind = (typeof KINDS)[number];
const bad = (): ActionResult<never> => ({ ok: false, status: 400, code: 'common.validation_failed' });
const uuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s);
const ver = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0;
const obj = (b: unknown): b is Record<string, unknown> => !!b && typeof b === 'object' && !Array.isArray(b);
const kind = (k: unknown): k is Kind => KINDS.includes(k as Kind);
const iso = (s: unknown): s is string => typeof s === 'string' && s.length <= 30 && !Number.isNaN(Date.parse(s));
const int = (n: unknown, min: number, max: number): n is number => Number.isInteger(n) && (n as number) >= min && (n as number) <= max;
const str = (s: unknown, max: number, min = 0): s is string => typeof s === 'string' && s.trim().length >= min && s.length <= max;

async function run<T>(perm: string, fn: () => Promise<T>): Promise<ActionResult<T>> {
  if (!(await has(perm))) return { ok: false, status: 403, code: 'auth.forbidden' };
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    return { ok: false, status: e.status, code: e.problem.code };
  }
}

// ---- W1/W2 (S1, S4, S5) ----
export async function listBookingsAction(q: unknown) {
  if (!obj(q) || !uuid(q['centre_id']) || (q['booking_kind'] !== undefined && !kind(q['booking_kind'])) || !iso(q['slot_start_from']) || !iso(q['slot_start_to'])) return bad();
  const status = q['status'];
  if (!Array.isArray(status) || status.length < 1 || status.length > 4 || !status.every((s) => STATUSES.includes(s))) return bad();
  if (Date.parse(q['slot_start_to']) - Date.parse(q['slot_start_from']) > 31 * 86_400_000) return bad();
  const query = {
    centre_id: q['centre_id'], ...(q['booking_kind'] ? { booking_kind: q['booking_kind'] as Kind } : {}), status: status as (typeof STATUSES)[number][],
    slot_start_from: q['slot_start_from'], slot_start_to: q['slot_start_to'], sort: 'slot_start' as const,
  };
  return run(PERM.bookingRead, () => api.listBookings(query));
}
export async function checkInAction(bookingId: string, version: number, body: unknown, key: string) {
  if (!uuid(bookingId) || !ver(version) || !KEY.test(key) || !obj(body) || typeof body['issue_token'] !== 'boolean') return bad();
  let b: Record<string, unknown> = { issue_token: false };
  if (body['issue_token']) {
    if (!uuid(body['queue_id']) || !['normal', 'priority'].includes(body['priority'] as string)) return bad();
    b = { issue_token: true, queue_id: body['queue_id'], priority: body['priority'] };
  }
  return run(PERM.bookingManage, async () => { await api.checkInBooking(bookingId, version, b, key); });
}
export async function cancelAction(bookingId: string, version: number, body: unknown, key: string) {
  if (!uuid(bookingId) || !ver(version) || !KEY.test(key) || !obj(body) || typeof body['reason_code'] !== 'string' || !/^[a-z0-9_]{1,64}$/.test(body['reason_code'])) return bad();
  const reason = body['reason_code'];
  return run(PERM.bookingCancel, async () => { await api.cancelBooking(bookingId, version, { reason_code: reason }, key); });
}

// ---- W3 (C4 search, S6, S3) ----
export async function searchPatientsAction(q: string) {
  if (!str(q, 100, 3)) return bad();
  return run(PERM.patientRead, () => api.searchPatients(q.trim()));
}
export async function listSlotsAction(q: unknown) {
  if (!obj(q) || !uuid(q['centre_id']) || !kind(q['booking_kind']) || typeof q['date'] !== 'string' || !DATE.test(q['date'])) return bad();
  const [c, k, d] = [q['centre_id'], q['booking_kind'], q['date']];
  return run(PERM.bookingRead, () => api.listSlots(c, k, d));
}
const address = (a: unknown) => {
  if (!obj(a) || !['home', 'work', 'other'].includes(a['label'] as string) || !str(a['address_text'], 300, 1)) return undefined;
  const opt = (k: string, max: number) => (a[k] === undefined ? {} : str(a[k], max) ? { [k]: a[k] } : null);
  const parts = [opt('landmark', 120), opt('municipality', 80), opt('district', 60), a['ward_no'] === undefined ? {} : int(a['ward_no'], 1, 99) ? { ward_no: a['ward_no'] } : null];
  if (parts.includes(null)) return undefined;
  return Object.assign({ label: a['label'] as 'home' | 'work' | 'other', address_text: a['address_text'] as string }, ...parts);
};
export async function createBookingAction(body: unknown, key: string) {
  if (!KEY.test(key) || !obj(body) || !uuid(body['patient_id']) || !kind(body['booking_kind']) || !iso(body['slot_start'])) return bad();
  if (body['centre_id'] !== undefined && !uuid(body['centre_id'])) return bad();
  const ids = body['orderable_ids'];
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 20 || !ids.every(uuid) || new Set(ids).size !== ids.length) return bad();
  const home = body['booking_kind'] === 'home_collection' ? address(body['home_address']) : undefined;
  if (body['booking_kind'] === 'home_collection' && !home) return bad();
  const b = {
    patient_id: body['patient_id'], booking_kind: body['booking_kind'], ...(body['centre_id'] ? { centre_id: body['centre_id'] as string } : {}),
    slot_start: body['slot_start'], orderable_ids: ids as string[], ...(home ? { home_address: home } : {}),
  };
  return run(PERM.bookingManage, () => api.createBooking(b, key));
}

// ---- W4 (S7–S11) ----
const templateBody = (b: unknown) => {
  if (!obj(b) || !uuid(b['centre_id']) || !kind(b['booking_kind'])) return undefined;
  const w = b['weekdays'];
  if (!Array.isArray(w) || w.length < 1 || w.length > 7 || !w.every((d) => int(d, 1, 7)) || new Set(w).size !== w.length) return undefined;
  const [s, e] = [b['start_local'], b['end_local']];
  if (typeof s !== 'string' || typeof e !== 'string' || !HHMM.test(s) || !HHMM.test(e) || e <= s) return undefined;
  if (!int(b['slot_minutes'], 5, 240) || b['slot_minutes'] % 5 !== 0 || !int(b['capacity'], 1, 100)) return undefined;
  const [from, to] = [b['effective_from'], b['effective_to']];
  if (typeof from !== 'string' || !DATE.test(from) || (to !== undefined && (typeof to !== 'string' || !DATE.test(to) || to < from))) return undefined;
  return {
    centre_id: b['centre_id'], booking_kind: b['booking_kind'], weekdays: w as number[], start_local: s, end_local: e, slot_minutes: b['slot_minutes'], capacity: b['capacity'],
    effective_from: from, ...(to ? { effective_to: to as string } : {}),
  };
};
export async function createTemplateAction(body: unknown, key: string) {
  const b = templateBody(body);
  return b && KEY.test(key) ? run(PERM.slotManage, () => api.createTemplate(b, key)) : bad();
}
export async function updateTemplateAction(templateId: string, version: number, body: unknown) {
  const b = templateBody(body);
  return b && uuid(templateId) && ver(version) ? run(PERM.slotManage, () => api.updateTemplate(templateId, version, b)) : bad();
}
export async function deactivateTemplateAction(templateId: string, version: number) {
  return uuid(templateId) && ver(version) ? run(PERM.slotManage, async () => { await api.deactivateTemplate(templateId, version); }) : bad();
}
export async function createBlackoutAction(body: unknown, key: string) {
  if (!KEY.test(key) || !obj(body) || !uuid(body['centre_id']) || (body['booking_kind'] !== undefined && !kind(body['booking_kind'])) || !iso(body['starts_at']) || !iso(body['ends_at'])) return bad();
  const span = Date.parse(body['ends_at']) - Date.parse(body['starts_at']);
  if (span <= 0 || span > 31 * 86_400_000 || !['holiday', 'maintenance', 'other'].includes(body['reason_code'] as string)) return bad();
  if (body['note'] !== undefined && !str(body['note'], 200)) return bad();
  const b = {
    centre_id: body['centre_id'], ...(body['booking_kind'] ? { booking_kind: body['booking_kind'] as Kind } : {}), starts_at: body['starts_at'], ends_at: body['ends_at'],
    reason_code: body['reason_code'] as 'holiday' | 'maintenance' | 'other', ...(body['note'] ? { note: body['note'] as string } : {}),
  };
  return run(PERM.slotManage, () => api.createBlackout(b, key));
}
export async function deactivateBlackoutAction(blackoutId: string, version: number) {
  return uuid(blackoutId) && ver(version) ? run(PERM.slotManage, async () => { await api.deactivateBlackout(blackoutId, version); }) : bad();
}

// ---- W5 (S12–S14, C3 catalog search) ----
export async function searchCatalogAction(q: string) {
  if (!str(q, 64, 1)) return bad();
  return run(PERM.bookableManage, () => api.searchCatalog(q.trim()));
}
export async function upsertBookableAction(orderableId: string, body: unknown, key: string, version?: number) {
  if (!uuid(orderableId) || !KEY.test(key) || (version !== undefined && !ver(version)) || !obj(body)) return bad();
  const kinds = body['booking_kinds'];
  if (!['test', 'panel'].includes(body['orderable_kind'] as string) || !Array.isArray(kinds) || kinds.length < 1 || kinds.length > 2 || !kinds.every(kind) || new Set(kinds).size !== kinds.length) return bad();
  if (typeof body['is_active'] !== 'boolean' || !int(body['sort_order'] ?? 0, 0, 9999)) return bad();
  const b = { orderable_kind: body['orderable_kind'] as string, booking_kinds: kinds as Kind[], sort_order: (body['sort_order'] as number | undefined) ?? 0, is_active: body['is_active'] };
  return run(PERM.bookableManage, async () => { await api.upsertBookableItem(orderableId, b, key, version); });
}
export async function syncBookableAction() {
  return run(PERM.bookableManage, async () => { await api.syncBookableItems(); });
}
