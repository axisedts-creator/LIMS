// Pure registration-draft logic: request bodies, payment and LD-25 validation. No React, no I/O (unit-testable).
// Money is integer paisa end to end (04-UI-UX §1); the server stays authoritative.
import type { DraftDiscount, NewPatientDraft, OrderableSummary, PaymentIn, PatientSummary, Quote, RegisterBody, RegistrationDraft } from '../server/types';

export type Priority = 'routine' | 'urgent';
export interface Item { orderable: OrderableSummary; priority?: Priority }
export interface PayRow { id: number; method: string; amount?: number; amountTouched: boolean; reference: string; tendered?: number }
export interface Downtime { on: boolean; occurredAt?: string; ref: string }
export interface DraftState {
  centreId: string; patient: PatientSummary | null; newPatient?: NewPatientDraft | null; visit: 'opd' | 'ipd'; billing: 'cash' | 'credit'; creditPartyId?: string;
  referrerId?: string; collection: string; urgentAll: boolean; items: Item[]; discounts: DraftDiscount[];
}

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
    patient: s.patient ? { patient_id: s.patient.id } : { new_patient: s.newPatient as NewPatientDraft }, centre_id: s.centreId, visit_type: s.visit, billing_mode: s.billing,
    priority: s.urgentAll ? 'urgent' : 'routine', collection_mode: s.collection,
    ...(s.billing === 'credit' && s.creditPartyId ? { credit_party_id: s.creditPartyId } : {}),
    ...(s.referrerId ? { referrer_id: s.referrerId } : {}),
    items: s.items.map((i) => ({ orderable_id: i.orderable.id, priority: effectivePriority(i, s.urgentAll) })),
    ...(s.discounts.length ? { discounts: s.discounts } : {}),
  };
}

/** Rows with a positive amount become payments; row 0 shows Net until the cashier edits it. */
export const rowAmount = (r: PayRow, idx: number, net: number): number => (idx === 0 && !r.amountTouched ? net : r.amount ?? 0);

export function paymentsOf(rows: PayRow[], net: number): PaymentIn[] {
  return rows.flatMap((r, i) => {
    const a = rowAmount(r, i, net);
    if (a < 1) return [];
    return [{ method_code: r.method, amount_received_paisa: a, ...(r.reference.trim() ? { reference: r.reference.trim() } : {}), ...(r.tendered !== undefined && r.method === 'cash' ? { tendered_paisa: r.tendered } : {}) }];
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

export function registerBody(draft: RegistrationDraft, quote: Quote, rows: PayRow[], dt: Downtime, approvalId?: string): RegisterBody {
  const net = quote.totals.net.amount_paisa;
  return {
    ...draft, quote_fingerprint: quote.quote_fingerprint,
    payments: draft.billing_mode === 'credit' ? [] : paymentsOf(rows, net),
    ...(approvalId ? { discount_approval_id: approvalId } : {}),
    ...(dt.on && dt.occurredAt ? { entry_mode: 'downtime_backentry' as const, occurred_at: new Date(dt.occurredAt).toISOString(), downtime_ref: dt.ref.trim() } : {}),
  };
}

export const newKey = (): string => crypto.randomUUID();
/** NPR "Rs." text is the kit's; plain amounts in tables use this (no currency prefix). */
export const plain = (paisa: number): string => (paisa / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
