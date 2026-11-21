import 'server-only';
// T0D-SALES-1 (LD-321): BFF reads of the sales screens (partners.yaml listSalesDesignations, listSalesRepresentatives, getSalesTree,
// listRepresentativeClients, listServiceAreas; live since T0B-SALES-1). Only known filter shapes reach a query string and only a uuid reaches a path.
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { t } from '@/core/i18n/messages';
import { problem } from '@/core/session/types';
import { UUID_RE, type Page } from './types';

export type PartyKind = 'credit_party' | 'partner' | 'doctor' | 'referrer';
export const PARTY_KINDS: readonly PartyKind[] = ['credit_party', 'partner', 'doctor', 'referrer'];

export interface SalesDesignation { id: string; name: string; level: number; is_active: boolean; version: number }
export interface SalesRepresentative {
  id: string; name: string; phone?: string; email?: string; designation_id: string; designation_level: number; manager_id?: string; joining_date?: string; is_active: boolean; version: number;
}
export interface SalesTreeNode { id: string; name: string; designation_id: string; designation_level: number; manager_id?: string; depth: number; is_active: boolean }
export interface RepresentativeClient {
  assignment_id: string; party_kind: PartyKind; party_id: string; party_name: string; outstanding_paisa: number; last_bill_date?: string; effective_from: string; effective_to?: string;
}
export interface ServiceArea { id: string; name: string; district: string; area_text?: string; centre_id?: string; is_active: boolean; version: number }
export interface NamedOption { id: string; name: string }

const CURSOR = /^[A-Za-z0-9_\-=.~+/]{1,512}$/;
const bad = () => new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
export const isUuid = (v: string | undefined): v is string => !!v && UUID_RE.test(v);
export const isKind = (v: string | undefined): v is PartyKind => PARTY_KINDS.includes(v as PartyKind);

export const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
/** Text of a failed list read, shown in the table body (403 says permission, anything else "could not be loaded"). */
export const loadFailedText = (status: number) => t(status === 403 ? 'partners.sales.load_forbidden' : 'partners.sales.load_failed');
/** A read that may fail: the data, or the HTTP status of the ApiError (anything else is a real error for error.tsx). */
export const settle = <T>(p: Promise<T>): Promise<T | number> => p.catch((e: unknown) => { if (e instanceof ApiError) return e.status; throw e; });

/** The common list filters of the three master screens: ?is_active=true|false and ?cursor. Anything else is dropped. */
export interface ListQuery { is_active?: string | undefined; cursor?: string | undefined }
const qs = (q: ListQuery, limit: number, extra: Record<string, string> = {}) => {
  const p = new URLSearchParams(extra);
  if (q.is_active === 'true' || q.is_active === 'false') p.set('is_active', q.is_active);
  if (q.cursor && CURSOR.test(q.cursor)) p.set('cursor', q.cursor);
  p.set('limit', String(limit));
  return `?${p}`;
};

// Lists are paged at 100 rows (Next follows page.next_cursor); the picker reads ask one page of 200 (the API maximum).
export const listSalesDesignations = (q: ListQuery = {}, limit = 100) => serverFetch<Page<SalesDesignation>>(`/v1/partners/admin/sales/designations${qs(q, limit)}`);
export const listSalesRepresentatives = (q: ListQuery = {}, limit = 100) => serverFetch<Page<SalesRepresentative>>(`/v1/partners/admin/sales/representatives${qs(q, limit)}`);
/** Depth-first, every manager before its reports; inactive nodes included so the tree and the manager picker see the whole team.
 * ponytail: one page of 200 nodes; a tenant with more representatives needs paging here (next_cursor). */
export const getSalesTree = () => serverFetch<Page<SalesTreeNode>>(`/v1/partners/admin/sales/tree?include_inactive=true&limit=200`);
export const listServiceAreas = (q: ListQuery = {}) => serverFetch<Page<ServiceArea>>(`/v1/partners/admin/sales/service-areas${qs(q, 100)}`);
export function listRepresentativeClients(representativeId: string, partyKind?: PartyKind) {
  if (!isUuid(representativeId)) throw bad();
  return serverFetch<Page<RepresentativeClient>>(`/v1/partners/admin/sales/representatives/${representativeId}/clients${qs({}, 200, partyKind && isKind(partyKind) ? { party_kind: partyKind } : {})}`);
}

type Named = { id: string; centre_id?: string; name?: string; display_name?: string; is_active?: boolean; status?: string };
const names = async (path: string): Promise<NamedOption[]> => {
  const r = await serverFetch<Page<Named>>(path).catch((e: unknown) => { if (e instanceof ApiError) return { data: [] as Named[] }; throw e; });
  return r.data.filter((x) => x.is_active !== false && (x.status ?? 'active') === 'active').map((x) => ({ id: x.centre_id ?? x.id, name: x.display_name ?? x.name ?? x.id }));
};
/** The parties the Assign dialog offers, per kind (one page of 200 each; a failed read offers none of that kind). */
export async function listPartyOptions(): Promise<Record<PartyKind, NamedOption[]>> {
  const [credit_party, partner, doctor, referrer] = await Promise.all([
    names('/v1/billing/credit-parties?limit=200'),
    names('/v1/partners/admin/partners?limit=200'),
    names('/v1/catalog/doctors?limit=200'),
    names('/v1/partners/admin/referrers?limit=200'),
  ]);
  return { credit_party, partner, doctor, referrer };
}
/** Centre names for the service areas (the Centre column and picker). */
export const listCentreOptions = () => names('/v1/identity/centres'); // same read as listCentresAction
