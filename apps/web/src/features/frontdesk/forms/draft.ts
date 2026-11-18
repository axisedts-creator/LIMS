// Pure registration-draft logic: request bodies, payment and LD-25 validation. No React, no I/O (unit-testable).
// Money is integer paisa end to end (04-UI-UX §1); the server stays authoritative.
import { UUID_RE, type DraftDiscount, type NewPatientDraft, type OrderFields, type OrderableSummary, type PaymentIn, type PatientSummary, type Quote, type RegisterBody, type RegistrationDraft } from '../server/types';

export type Priority = 'routine' | 'urgent';
export interface Item { orderable: OrderableSummary; priority?: Priority; icd?: string }
export interface PayRow { id: number; method: string; amount?: number; amountTouched: boolean; reference: string; tendered?: number; cardHolder?: string; remark?: string }
export interface Downtime { on: boolean; occurredAt?: string; ref: string }
export interface DraftState {
  centreId: string; patient: PatientSummary | null; newPatient?: NewPatientDraft | null; visit: 'opd' | 'ipd'; billing: 'cash' | 'credit'; creditPartyId?: string;
  referrerId?: string; collection: string; urgentAll: boolean; items: Item[]; discounts: DraftDiscount[];
  /** LD-310 / T0D-REGSCREEN-2 F8 extras; 0 / empty = absent. */
  coupon?: string; visitingPaisa?: number; redeemPoints?: number;
}
/** Contract pattern of coupon_code (RegistrationDraft); the UI upper-cases first. */
export const COUPON_RE = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;

export const MAX_ITEMS = 50;
export const MAX_PAY_ROWS = 5;
/** LD-25 (2026-11-07): constant window; front_desk cannot read the tenant setting `downtime_backentry_max_hours` (CR FD-T06-ld25-gaps). */
export const DOWNTIME_MAX_HOURS = 72;
export const DOWNTIME_REF_MAX = 32;

export const effectivePriority = (i: Item, urgentAll: boolean): Priority => i.priority ?? (urgentAll ? 'urgent' : 'routine');

/** The F8/F9 draft; null while a quote cannot be asked for (no patient, no items, no centre; credit without a party). */
export function buildDraft(s: DraftState): RegistrationDraft | null {
  if ((!s.patient && !s.newPatient) || s.items.length === 0 || !s.centreId) return null;
  if (s.billing === 'credit' && !s.creditPartyId) return null;
  return {
    // LD-310 (b): the Government ID number rides only in F9 (registerBody), never in the quote; the quote fingerprint covers lines, discounts and totals only.
    patient: s.patient ? { patient_id: s.patient.id } : { new_patient: withoutGovNo(s.newPatient as NewPatientDraft) }, centre_id: s.centreId, visit_type: s.visit, billing_mode: s.billing,
    priority: s.urgentAll ? 'urgent' : 'routine', collection_mode: s.collection,
    ...(s.billing === 'credit' && s.creditPartyId ? { credit_party_id: s.creditPartyId } : {}),
    ...(s.referrerId ? { referrer_id: s.referrerId } : {}),
    items: s.items.map((i) => ({ orderable_id: i.orderable.id, priority: effectivePriority(i, s.urgentAll), ...(i.icd ? { icd_code: i.icd } : {}) })),
    ...(s.discounts.length ? { discounts: s.discounts } : {}),
    ...(s.coupon ? { coupon_code: s.coupon } : {}),
    ...(s.visitingPaisa ? { visiting_charge_paisa: s.visitingPaisa } : {}),
    ...(s.redeemPoints ? { redeem_reward_points: s.redeemPoints } : {}),
  };
}
const withoutGovNo = ({ government_id_number: _n, ...p }: NewPatientDraft): NewPatientDraft => p;

/** Rows with a positive amount become payments; row 0 shows Net until the cashier edits it. */
export const rowAmount = (r: PayRow, idx: number, net: number): number => (idx === 0 && !r.amountTouched ? net : r.amount ?? 0);

export function paymentsOf(rows: PayRow[], net: number): PaymentIn[] {
  return rows.flatMap((r, i) => {
    const a = rowAmount(r, i, net);
    if (a < 1) return [];
    const holder = r.method === 'card' ? r.cardHolder?.trim() : undefined; // a name typed under Card is dropped once the method changes
    const remark = r.remark?.trim();
    return [{
      method_code: r.method, amount_received_paisa: a, ...(r.reference.trim() ? { reference: r.reference.trim() } : {}), ...(r.tendered !== undefined && r.method === 'cash' ? { tendered_paisa: r.tendered } : {}),
      ...(holder ? { card_holder_name: holder } : {}), ...(remark ? { payment_remark: remark } : {}),
    }];
  });
}

/** 13–19 digit runs (spaces and hyphens ignored) look like a card number (04-UI-UX §3.2 F). */
export const looksLikeCardNumber = (ref: string): boolean => /\d{13,19}/.test(ref.replace(/[\s-]/g, ''));

export interface PayErrors { amount: Record<number, string>; reference: Record<number, string>; tendered: Record<number, string> }
export function validatePayments(rows: PayRow[], net: number, requiresReference: (method: string) => boolean): PayErrors {
  const e: PayErrors = { amount: {}, reference: {}, tendered: {} };
  let sum = 0;
  rows.forEach((r, i) => {
    const a = rowAmount(r, i, net);
    sum += a;
    if (looksLikeCardNumber(r.reference)) e.reference[i] = 'Do not enter card numbers';
    else if (a > 0 && requiresReference(r.method) && r.reference.trim() === '') e.reference[i] = 'Reference is required for this method';
    if (r.tendered !== undefined && r.method === 'cash' && a > 0 && r.tendered < a) e.tendered[i] = 'Tendered must be at least the amount';
  });
  if (sum > net) rows.forEach((r, i) => { if (rowAmount(r, i, net) > 0) e.amount[i] = 'Payments are more than the bill'; });
  return e;
}
export const hasPayErrors = (e: PayErrors) => [e.amount, e.reference, e.tendered].some((m) => Object.keys(m).length > 0);

export interface DowntimeErrors { occurredAt?: string; ref?: string }
/** LD-25: occurred_at must be ≤ now and ≥ now − 72 h; downtime_ref 1–32 chars. */
export function validateDowntime(d: Downtime, now = Date.now()): DowntimeErrors {
  if (!d.on) return {};
  const e: DowntimeErrors = {};
  const t = d.occurredAt ? Date.parse(d.occurredAt) : NaN;
  if (!Number.isFinite(t)) e.occurredAt = 'Enter the original time from the paper form';
  else if (t > now) e.occurredAt = 'The original time cannot be in the future';
  else if (t < now - DOWNTIME_MAX_HOURS * 3_600_000) e.occurredAt = `The original time is more than ${DOWNTIME_MAX_HOURS} hours ago`;
  const ref = d.ref.trim();
  if (ref === '') e.ref = 'Enter the paper form serial';
  else if (ref.length > DOWNTIME_REF_MAX) e.ref = `At most ${DOWNTIME_REF_MAX} characters`;
  return e;
}

export function registerBody(draft: RegistrationDraft, quote: Quote, rows: PayRow[], dt: Downtime, approvalId?: string, newPatient?: NewPatientDraft | null, order: OrderFields = {}): RegisterBody {
  const net = quote.totals.net.amount_paisa;
  return {
    ...draft, ...(newPatient && 'new_patient' in draft.patient ? { patient: { new_patient: newPatient } } : {}), ...order, quote_fingerprint: quote.quote_fingerprint,
    payments: draft.billing_mode === 'credit' ? [] : paymentsOf(rows, net),
    ...(approvalId ? { discount_approval_id: approvalId } : {}),
    ...(dt.on && dt.occurredAt ? { entry_mode: 'downtime_backentry' as const, occurred_at: new Date(dt.occurredAt).toISOString(), downtime_ref: dt.ref.trim() } : {}),
  };
}

/** Trimmed text or absent (contract minLength 1: never ""). */
export const opt = <K extends string>(k: K, v: string | undefined): Partial<Record<K, string>> => (v?.trim() ? ({ [k]: v.trim() } as Record<K, string>) : {});

// LD-310 / T0D-REGSCREEN-2 drafts. The payload is MINIMAL: no quote_fingerprint, payments, card holder name, Government ID number or health text
// (sensitive or stale values are not parked at rest). Items keep code/name/kind [CONV]: no contract read turns an orderable id back into its name.
export interface DraftPayload {
  patient?: { patient_id: string } | { new_patient: NewPatientDraft };
  centre_id?: string; visit_type?: 'opd' | 'ipd'; collection_mode?: string; priority?: Priority;
  items: (OrderableSummary & { priority?: Priority; icd_code?: string })[];
  coupon_code?: string; visiting_charge_paisa?: number;
  collected_by_name?: string; mr_number?: string; external_reference?: string; insurance_code?: string;
}
const DRAFT_PATIENT_KEYS = ['full_name', 'sex', 'birth_on', 'age', 'phone_e164', 'email', 'address_text', 'title', 'external_patient_id', 'nationality', 'address_province', // Government ID type and number: neither (they go together)
  'address_district', 'address_municipality', 'address_ward', 'address_tole', 'address_postal_code', 'profile_photo_attachment_id', 'custom_fields', 'consents'] as const;
/** The new patient as a draft may hold it: the known keys minus the Government ID (type and number go together, the number is never parked). */
export const draftPatient = (p: NewPatientDraft): NewPatientDraft => Object.fromEntries(DRAFT_PATIENT_KEYS.filter((k) => p[k] !== undefined).map((k) => [k, p[k]])) as unknown as NewPatientDraft;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);
/** Reads a stored draft defensively: only known keys with the right shapes survive; anything else is null (never throws). */
export function parseDraftPayload(text: string): DraftPayload | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!isObj(raw) || !Array.isArray(raw['items'])) return null;
  const items: DraftPayload['items'] = [];
  for (const i of raw['items']) {
    if (!isObj(i) || typeof i['orderable_id'] !== 'string' || !UUID_RE.test(i['orderable_id'])) return null;
    const code = str(i['code'], 64), name = str(i['name'], 200);
    if (!code || !name) return null;
    items.push({ id: i['orderable_id'], code, name, kind: i['kind'] === 'panel' ? 'panel' : 'test', ...(i['priority'] === 'urgent' || i['priority'] === 'routine' ? { priority: i['priority'] } : {}), ...(str(i['icd_code'], 16) ? { icd_code: i['icd_code'] as string } : {}) });
  }
  let patient: DraftPayload['patient'];
  const p = raw['patient'];
  if (p !== undefined) {
    if (!isObj(p)) return null;
    if (typeof p['patient_id'] === 'string' && UUID_RE.test(p['patient_id'])) patient = { patient_id: p['patient_id'] };
    else if (isObj(p['new_patient']) && str(p['new_patient']['full_name'], 200) && isObj(p['new_patient']['consents'])) {
      patient = { new_patient: draftPatient(p['new_patient'] as unknown as NewPatientDraft) };
    } else return null;
  }
  if (!patient && items.length === 0) return null;
  const n = (v: unknown) => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : undefined);
  const s = (k: string, max: number) => (str(raw[k], max) ? { [k]: raw[k] as string } : {});
  return {
    ...(patient ? { patient } : {}), items, ...s('centre_id', 36), ...s('collection_mode', 32), ...s('coupon_code', 32), ...s('collected_by_name', 200), ...s('mr_number', 64), ...s('external_reference', 64), ...s('insurance_code', 64),
    ...(raw['visit_type'] === 'ipd' || raw['visit_type'] === 'opd' ? { visit_type: raw['visit_type'] } : {}), ...(raw['priority'] === 'urgent' ? { priority: 'urgent' as const } : {}),
    ...(n(raw['visiting_charge_paisa']) ? { visiting_charge_paisa: n(raw['visiting_charge_paisa'])! } : {}),
  };
}

export const newKey = (): string => crypto.randomUUID();
/** NPR "Rs." text is the kit's; plain amounts in tables use this (no currency prefix). */
export const plain = (paisa: number): string => (paisa / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
