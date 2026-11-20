import 'server-only';
// T0D-PARTYSET-1 (LD-321): BFF reads of the party settings screens (T0C-PARTYSET-1, live since T0B-PARTYSET-1):
//   partners.yaml getPartyCommercialSetting, listPartyOnboarding, listNonCompliancePenalties, listNonComplianceEvents;
//   the ICD master read (catalog.yaml listIcdMasterCodes) is in features/catalog/server/icd.server.ts.
// Only a known party kind and a uuid reach a path; only known filter shapes reach a query string. Lists are paged at 50 rows.
import { serverFetch } from '@/core/api/server-fetch';
import { isKind, isUuid, type PartyKind } from './sales.server';
import type { Page } from './types';

export type { PartyKind };
export type BillingCycle = 'daily' | 'weekly' | 'fortnightly' | 'monthly' | 'quarterly';
export type Priority = 'P1' | 'P2' | 'P3' | 'P4' | 'P5';
export type HeaderFooter = 'with' | 'without' | 'both';
export interface PartyCommercialSetting {
  id?: string; party_kind: PartyKind; party_id: string; is_default: boolean;
  auto_release_reports: boolean; whatsapp_enabled: boolean; insurance_enabled: boolean; print_exception: boolean; lab_number_scheme_code?: string;
  billing_cycle: BillingCycle; invoice_payment_days: number; invoice_blocking_days: number; invoice_warning_days: number;
  interest_bp_per_day: number; priority: Priority; header_footer_mode: HeaderFooter; commission_bp: number; tds_bp: number; auto_block_overdue: boolean;
  version: number; updated_at?: string;
}
export type OnboardingStatus = 'pending' | 'approved' | 'held' | 'rejected';
export interface PartyOnboarding {
  id: string; party_kind: PartyKind; party_id: string; party_name?: string; status: OnboardingStatus; reason?: string; decided_by?: string; decided_at?: string; version: number; created_at: string;
}
export interface NonCompliancePenalty { id: string; code: string; name: string; amount_paisa: number; is_active: boolean; version: number; created_at: string; updated_at: string }
export type EventStatus = 'raised' | 'waived' | 'charged';
export interface NonComplianceEvent {
  id: string; party_kind: PartyKind; party_id: string; penalty_id: string; event_date: string; amount_paisa: number; reason?: string; status: EventStatus;
  ledger_entry_id?: string; decided_by?: string; version: number; created_at: string;
}
export interface IcdMasterCode { id: string; code: string; title: string; chapter?: string; is_active: boolean; version: number; created_at: string; updated_at: string }

const CURSOR = /^[A-Za-z0-9_\-=.~+/]{1,512}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ONB: readonly string[] = ['pending', 'approved', 'held', 'rejected'];
const EVS: readonly string[] = ['raised', 'waived', 'charged'];
export const LIST_LIMIT = 50;

/** Builds `?…&limit=50` from the allowed filters only; text is cut to the contract's 64 characters. */
function qs(f: Record<string, string | undefined>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
  p.set('limit', String(LIST_LIMIT));
  return `?${p}`;
}
const text = (v: string | undefined) => (v && v.trim() ? v.trim().slice(0, 64) : undefined);
const cursor = (v: string | undefined) => (v && CURSOR.test(v) ? v : undefined);
const day = (v: string | undefined) => (v && DAY.test(v) ? v : undefined);

export function getPartyCommercialSetting(kind: PartyKind, id: string) {
  if (!isKind(kind) || !isUuid(id)) throw new Error('bad party');
  return serverFetch<PartyCommercialSetting>(`/v1/partners/admin/party-settings/${kind}/${id}`);
}

/** `status` undefined = the default queue (pending); '' = all. */
export function listPartyOnboarding(q: { status?: string | undefined; cursor?: string | undefined }) {
  const status = q.status === undefined ? 'pending' : ONB.includes(q.status) ? q.status : undefined;
  return serverFetch<Page<PartyOnboarding>>(`/v1/partners/admin/onboarding${qs({ status, cursor: cursor(q.cursor) })}`);
}

export const listNonCompliancePenalties = (q: { q?: string | undefined; cursor?: string | undefined }) =>
  serverFetch<Page<NonCompliancePenalty>>(`/v1/partners/admin/penalties${qs({ q: text(q.q), cursor: cursor(q.cursor) })}`);
/** Penalty names for the events list and the Raise picker: one page of 200 (the API maximum). */
export const listAllPenalties = () => serverFetch<Page<NonCompliancePenalty>>(`/v1/partners/admin/penalties?limit=200`);

export function listNonComplianceEvents(q: { status?: string | undefined; from_date?: string | undefined; to_date?: string | undefined; cursor?: string | undefined }) {
  const status = q.status && EVS.includes(q.status) ? q.status : undefined;
  return serverFetch<Page<NonComplianceEvent>>(`/v1/partners/admin/penalty-events${qs({ status, from_date: day(q.from_date), to_date: day(q.to_date), cursor: cursor(q.cursor) })}`);
}
