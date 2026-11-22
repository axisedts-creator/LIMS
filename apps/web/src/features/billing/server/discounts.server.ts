import 'server-only';
// T0D-FINCTRL-1 (LD-321, founder blanket authority LD-310): BFF reads and writes for the discount masters (contracts/openapi/billing.yaml, T0C-FINCTRL-1
// operations): discount reasons, party discount slabs, per user discount limits and discount authorities. Masters are deactivated, never deleted:
// this file has no DELETE. Creates send Idempotency-Key; updates and deactivations send If-Match = the row version. Ids, dates, percents (basis
// points) and paisa are checked by shape before they leave the BFF. Lists are paged (limit 200, the contract maximum).
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { ISO_DATE_RE, UUID_RE } from './types';

import { SLAB_PARTY_KINDS, type SlabPartyKind } from './discountKinds';
export { SLAB_PARTY_KINDS };
export type { SlabPartyKind };

type Stamp = { version: number; created_at: string; updated_at: string };
export interface DiscountReason extends Stamp { id: string; code: string; name: string; is_active: boolean; display_order: number }
export interface PartyDiscountSlab extends Stamp {
  id: string; party_kind: SlabPartyKind; party_id: string; amount_from_paisa: number; amount_to_paisa: number; discount_bp: number; effective_from: string; effective_to?: string | undefined; is_active: boolean;
}
export interface UserDiscountLimit extends Stamp { id: string; user_id: string; max_discount_bp: number; max_discount_paisa: number; is_active: boolean }
export type DiscountAuthority = UserDiscountLimit;
/** A party a slab can point at (credit party, partner, doctor, franchise), joined from the neighbour lists for names. */
export interface SlabParty { kind: SlabPartyKind; id: string; name: string }

export interface SlabInput { amount_from_paisa: number; amount_to_paisa: number; discount_bp: number; effective_from: string; effective_to?: string }
export interface CreateSlabInput extends SlabInput { party_kind: SlabPartyKind; party_id: string }
export interface Ceiling { max_discount_bp: number; max_discount_paisa: number }

const bad = () => new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CODE_RE = /^[A-Z0-9_]{1,32}$/;
const LIMIT = 200;
const id = (v: string) => {
  if (!UUID_RE.test(v)) throw bad();
  return v;
};
const isDate = (v: unknown) => typeof v === 'string' && ISO_DATE_RE.test(v);
const isBp = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 10000;
const isPaisa = (v: unknown, min = 0) => Number.isSafeInteger(v) && (v as number) >= min;
const isName = (v: unknown) => typeof v === 'string' && v.trim() !== '' && v.length <= 200;
const isVersion = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;

type Page<T> = { data: T[]; page?: { next_cursor?: string | null } };
const data = <T,>(p: Promise<Page<T>>) => p.then((r) => r.data ?? []);
/** Name lookups from neighbour modules: a missing permission shows a dash, never a broken page. */
const soft = <T,>(p: Promise<T[]>) => p.catch(() => [] as T[]);

export const listDiscountReasons = () => data(serverFetch<Page<DiscountReason>>(`/v1/billing/discount-reasons?limit=${LIMIT}`));
export function listPartyDiscountSlabs(f: { party_kind?: string | undefined; party_id?: string | undefined } = {}) {
  const p = new URLSearchParams({ limit: String(LIMIT) });
  if (f.party_kind) { if (!SLAB_PARTY_KINDS.includes(f.party_kind as SlabPartyKind)) throw bad(); p.set('party_kind', f.party_kind); }
  if (f.party_id) p.set('party_id', id(f.party_id));
  return data(serverFetch<Page<PartyDiscountSlab>>(`/v1/billing/discount-slabs?${p}`));
}
export const listUserDiscountLimits = () => data(serverFetch<Page<UserDiscountLimit>>(`/v1/billing/discount-limits?limit=${LIMIT}`));
export const listDiscountAuthorities = () => data(serverFetch<Page<DiscountAuthority>>(`/v1/billing/discount-authorities?limit=${LIMIT}`));

type Row = { id?: string; name?: string; display_name?: string; centre_id?: string; kind?: string; centre_kind?: string };
/** Slab parties: credit parties (billing), partners (partners admin list), referring doctors (catalog), franchise centres (identity). */
export async function listSlabParties(): Promise<SlabParty[]> {
  const [credit, partners, doctors, centres] = await Promise.all([
    soft(data(serverFetch<Page<Row>>(`/v1/billing/credit-parties?limit=${LIMIT}`))),
    soft(data(serverFetch<Page<Row>>(`/v1/partners/admin/partners?limit=${LIMIT}`))),
    soft(data(serverFetch<Page<Row>>(`/v1/catalog/doctors?is_active=true&limit=${LIMIT}`))),
    soft(data(serverFetch<Page<Row>>('/v1/identity/centres' /* LD-446: listCentres has no limit */))),
  ]);
  const map = (kind: SlabPartyKind, rows: Row[]) => rows.filter((r) => r.id ?? r.centre_id).map((r) => ({ kind, id: (r.id ?? r.centre_id) as string, name: r.name ?? r.display_name ?? '—' }));
  return [...map('credit_party', credit), ...map('partner', partners), ...map('doctor', doctors), ...map('franchise', centres.filter((c) => (c.kind ?? c.centre_kind) === 'franchise'))];
}

function send<T>(method: 'POST' | 'PATCH' | 'PUT', path: string, body: unknown, o: { key?: string; version?: number | undefined }): Promise<T> {
  if (o.key !== undefined && !KEY_RE.test(o.key)) throw bad();
  if (o.version !== undefined && !isVersion(o.version)) throw bad();
  return serverFetch<T>(path, {
    method,
    headers: { 'content-type': 'application/json', ...(o.key !== undefined ? { 'idempotency-key': o.key } : {}), ...(o.version !== undefined ? { 'if-match': `"${o.version}"` } : {}) },
    body: JSON.stringify(body),
  });
}

export function createDiscountReason(r: { code: string; name: string }, key: string) {
  if (!CODE_RE.test(r.code) || !isName(r.name)) throw bad();
  return send<DiscountReason>('POST', '/v1/billing/discount-reasons', { code: r.code, name: r.name }, { key });
}
/** Code is immutable (contract): only name or is_active are sent. */
export function updateDiscountReason(reasonId: string, version: number, patch: { name?: string; is_active?: boolean }) {
  const body = { ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.is_active !== undefined ? { is_active: patch.is_active } : {}) };
  if (!Object.keys(body).length || (body.name !== undefined && !isName(body.name))) throw bad();
  return send<DiscountReason>('PATCH', `/v1/billing/discount-reasons/${id(reasonId)}`, body, { version });
}

const slabOk = (s: SlabInput) => isPaisa(s.amount_from_paisa) && isPaisa(s.amount_to_paisa, 1) && s.amount_to_paisa > s.amount_from_paisa && isBp(s.discount_bp) && isDate(s.effective_from)
  && (s.effective_to === undefined || (isDate(s.effective_to) && s.effective_to >= s.effective_from));
const slabBody = (s: SlabInput) => ({ amount_from_paisa: s.amount_from_paisa, amount_to_paisa: s.amount_to_paisa, discount_bp: s.discount_bp, effective_from: s.effective_from, ...(s.effective_to ? { effective_to: s.effective_to } : {}) });
export function createPartyDiscountSlab(s: CreateSlabInput, key: string) {
  if (!SLAB_PARTY_KINDS.includes(s.party_kind) || !UUID_RE.test(s.party_id) || !slabOk(s)) throw bad();
  return send<PartyDiscountSlab>('POST', '/v1/billing/discount-slabs', { party_kind: s.party_kind, party_id: s.party_id, ...slabBody(s) }, { key });
}
/** Party is fixed after create: only the amounts, percent and dates are sent. */
export function updatePartyDiscountSlab(slabId: string, version: number, s: SlabInput) {
  if (!slabOk(s)) throw bad();
  return send<PartyDiscountSlab>('PATCH', `/v1/billing/discount-slabs/${id(slabId)}`, slabBody(s), { version });
}
export function deactivatePartyDiscountSlab(slabId: string, version: number) {
  return send<PartyDiscountSlab>('POST', `/v1/billing/discount-slabs/${id(slabId)}/deactivate`, {}, { version });
}

const ceilingOk = (c: Ceiling) => isBp(c.max_discount_bp) && isPaisa(c.max_discount_paisa);
/** setUserDiscountLimit is a PUT per user (one active row per user); If-Match only when a row exists (version given). */
export function setUserDiscountLimit(userId: string, c: Ceiling & { is_active?: boolean }, version?: number) {
  if (!ceilingOk(c) || (c.is_active !== undefined && typeof c.is_active !== 'boolean')) throw bad();
  const body = { max_discount_bp: c.max_discount_bp, max_discount_paisa: c.max_discount_paisa, ...(c.is_active !== undefined ? { is_active: c.is_active } : {}) };
  return send<UserDiscountLimit>('PUT', `/v1/billing/discount-limits/${id(userId)}`, body, { version });
}
/** Authorities have no update operation in the contract: create and deactivate only. */
export function createDiscountAuthority(a: Ceiling & { user_id: string }, key: string) {
  if (!UUID_RE.test(a.user_id) || !ceilingOk(a)) throw bad();
  return send<DiscountAuthority>('POST', '/v1/billing/discount-authorities', { user_id: a.user_id, max_discount_bp: a.max_discount_bp, max_discount_paisa: a.max_discount_paisa }, { key });
}
export function deactivateDiscountAuthority(authorityId: string, version: number) {
  return send<DiscountAuthority>('POST', `/v1/billing/discount-authorities/${id(authorityId)}/deactivate`, {}, { version });
}
