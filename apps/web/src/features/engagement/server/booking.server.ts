import 'server-only';
// C16.T-B6 BFF calls for W1–W5 (contracts/openapi/engagement.yaml S1–S14; C4 frontdesk patients; C3 catalog orderables; identity centres).
// The bearer token is added by serverFetch on the server. Ids are shape-checked before they reach a URL.
import { serverFetch } from '@/core/api/server-fetch';
import { UUID_RE, has } from './queue.server';
import type {
  BookingKind, CancelReason, Centre, PatientHit, SlotBlackout, SlotTemplate, StaffBookableItem, StaffBooking, StaffSlot, Transition,
} from '../components/booking-model';
import type { BookingsQuery } from '../components/BookingsList';
import type { CreateBookingBody } from '../components/BookingNew';
import type { SlotBlackoutBody, SlotTemplateBody } from '../components/SlotsAdmin';
import type { CatalogHit } from '../components/BookableCatalogue';

export const PERM = {
  bookingRead: 'engagement.booking.read',
  bookingManage: 'engagement.booking.manage',
  bookingCancel: 'engagement.booking.cancel',
  slotManage: 'engagement.slot.manage',
  bookableManage: 'engagement.bookable_item.manage',
  patientRead: 'frontdesk.patient.read',
} as const;

const json = (method: string, body?: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});
const ifMatch = (v: number) => ({ 'If-Match': `"${v}"` });
const idem = (k: string) => ({ 'Idempotency-Key': k });
const rows = <T,>(r: { data?: T[] } | undefined): T[] => (Array.isArray(r?.data) ? r.data : []);
const uuid = (v: string) => { if (!UUID_RE.test(v)) throw new Error('invalid id'); return v; };
const id = (v: string) => encodeURIComponent(uuid(v));
const qs = (p: Record<string, string | undefined>) => new URLSearchParams(Object.entries(p).filter((e): e is [string, string] => e[1] !== undefined)).toString();

/** Today's A.D. date in Asia/Kathmandu. */
export const todayKathmandu = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kathmandu' }).format(new Date());

// ---- reference data ----
export async function listCentres(): Promise<Centre[]> {
  const r = await serverFetch<{ data?: { centre_id: string; name: string; kind: string; is_active?: boolean }[] }>('/v1/identity/centres?is_active=true').catch(() => undefined);
  return rows(r).map((c) => ({ id: c.centre_id, display_name: c.name, is_home_collection: c.kind === 'home_collection' }));
}
export async function listCancelReasons(): Promise<CancelReason[]> {
  const r = await serverFetch<{ data?: { code: string; display: string }[] }>(`/v1/engagement/coded-sets/booking_cancel_reasons`).catch(() => undefined);
  return rows(r).map((c) => ({ code: c.code, label: c.display }));
}

// ---- patient names (W1: C4 GET /v1/frontdesk/patients/{id} server-side; no frontdesk.patient.read or a failure → null → "—") ----
async function patientName(patientId: string): Promise<string | null> {
  const r = await serverFetch<{ full_name?: string }>(`/v1/frontdesk/patients/${id(patientId)}`).catch(() => undefined);
  return r?.full_name ?? null;
}
export async function withPatientNames<T extends { patient_id: string }>(list: T[]): Promise<(T & { patient_name: string | null })[]> {
  if (!(await has(PERM.patientRead))) return list.map((b) => ({ ...b, patient_name: null }));
  const ids = [...new Set(list.map((b) => b.patient_id))];
  const names = new Map(await Promise.all(ids.map(async (p) => [p, await patientName(p)] as const)));
  return list.map((b) => ({ ...b, patient_name: names.get(b.patient_id) ?? null }));
}
export async function searchPatients(q: string): Promise<PatientHit[]> {
  const r = await serverFetch<{ data?: { id: string; full_name: string; patient_code: string; age_display?: string; sex?: string }[] }>(
    '/v1/frontdesk/patients/search', json('POST', { query: q, mode: 'auto', limit: 20 }));
  return rows(r).map((p) => ({ id: p.id, name: p.full_name, patient_code: p.patient_code, age: p.age_display ?? '', sex: p.sex ?? '' }));
}

// ---- S1–S6 bookings + slots ----
export async function listBookings(q: BookingsQuery): Promise<StaffBooking[]> {
  const query = qs({ centre_id: uuid(q.centre_id), booking_kind: q.booking_kind, status: q.status.join(','), slot_start_from: q.slot_start_from, slot_start_to: q.slot_start_to, sort: q.sort, limit: '100' });
  return withPatientNames(rows(await serverFetch<{ data?: StaffBooking[] }>(`/v1/engagement/bookings?${query}`)));
}
export const getBooking = (bookingId: string) => serverFetch<StaffBooking & { transitions?: Transition[] }>(`/v1/engagement/bookings/${id(bookingId)}`);
export const createBooking = (body: CreateBookingBody, key: string) => serverFetch<StaffBooking>(`/v1/engagement/bookings`, json('POST', body, idem(key)));
export const cancelBooking = (bookingId: string, version: number, body: { reason_code: string }, key: string) =>
  serverFetch<StaffBooking>(`/v1/engagement/bookings/${id(bookingId)}/cancel`, json('POST', body, { ...ifMatch(version), ...idem(key) }));
export const checkInBooking = (bookingId: string, version: number, body: Record<string, unknown>, key: string) =>
  serverFetch<unknown>(`/v1/engagement/bookings/${id(bookingId)}/check-in`, json('POST', body, { ...ifMatch(version), ...idem(key) }));
export const listSlots = async (centreId: string, kind: BookingKind, date: string) =>
  rows(await serverFetch<{ data?: StaffSlot[] }>(`/v1/engagement/slots?${qs({ centre_id: uuid(centreId), booking_kind: kind, date_from: date, date_to: date })}`));

// ---- S7–S11 slot templates + blackouts ----
export const listTemplates = async () => rows(await serverFetch<{ data?: SlotTemplate[] }>(`/v1/engagement/slot-templates`));
export const createTemplate = (body: SlotTemplateBody, key: string) => serverFetch<SlotTemplate & { affected?: { overbooked_slots: number } }>(`/v1/engagement/slot-templates`, json('POST', body, idem(key)));
export const updateTemplate = (templateId: string, version: number, body: SlotTemplateBody) =>
  serverFetch<SlotTemplate & { affected?: { overbooked_slots: number } }>(`/v1/engagement/slot-templates/${id(templateId)}`, json('PUT', body, ifMatch(version)));
export const deactivateTemplate = (templateId: string, version: number) => serverFetch<unknown>(`/v1/engagement/slot-templates/${id(templateId)}/deactivate`, json('POST', undefined, ifMatch(version)));
export const listBlackouts = async () => rows(await serverFetch<{ data?: SlotBlackout[] }>(`/v1/engagement/slot-blackouts`));
export const createBlackout = (body: SlotBlackoutBody, key: string) => serverFetch<SlotBlackout & { affected?: { future_bookings: number } }>(`/v1/engagement/slot-blackouts`, json('POST', body, idem(key)));
export const deactivateBlackout = (blackoutId: string, version: number) => serverFetch<unknown>(`/v1/engagement/slot-blackouts/${id(blackoutId)}/deactivate`, json('POST', undefined, ifMatch(version)));

// ---- S12–S14 bookable items ----
export const listBookableItems = async () => rows(await serverFetch<{ data?: StaffBookableItem[] }>(`/v1/engagement/bookable-items?limit=200`));
export const upsertBookableItem = (orderableId: string, body: { orderable_kind: string; booking_kinds: BookingKind[]; sort_order: number; is_active: boolean }, key: string, version?: number) =>
  serverFetch<StaffBookableItem>(`/v1/engagement/bookable-items/${id(orderableId)}`, json('PUT', body, { ...idem(key), ...(version !== undefined ? ifMatch(version) : {}) }));
export const syncBookableItems = () => serverFetch<unknown>(`/v1/engagement/bookable-items/sync`, json('POST'));
export async function searchCatalog(q: string): Promise<CatalogHit[]> {
  const r = await serverFetch<{ data?: { id: string; kind: 'test' | 'panel'; code: string; name: string }[] }>(`/v1/catalog/orderables?${qs({ q, limit: '20' })}`);
  return rows(r).map((o) => ({ orderable_id: o.id, orderable_kind: o.kind, code: o.code, display_name: o.name }));
}
