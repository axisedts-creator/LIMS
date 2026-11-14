import 'server-only';
// C13.T19 server-side read helpers for the (app) pages. Everything goes through partnerApi (session, CSRF, path guard); no upstream detail is ever rendered.
// LD-140 (2026-11-13): UI work builds on @lims/ui only; this file has no UI.
import { cache } from 'react';
import { notFound } from 'next/navigation';
import { partnerApi } from '@/core/api';
import type { Me } from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID.test(s);

export type Search = Record<string, string | string[] | undefined>;
/** One whitelisted query parameter: how to validate it before it is forwarded to the API (02-TRD §5.2 names). */
export type Rule = 'date' | 'month' | 'bool' | 'uuid' | 'cursor' | { text: number } | { one: readonly string[] } | { csv: readonly string[] };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const clean = (v: string) => v.replace(/[\u0000-\u001f\u007f/\\]/g, ' ').replace(/\.{2,}/g, '.').trim();

/** Whitelist + validate the page's searchParams; unknown names and invalid values are dropped. Returns '' or '?a=b&...' (never throws). */
export function query(search: Search, rules: Record<string, Rule>, fixed: Record<string, string> = {}): string {
  const p = new URLSearchParams(fixed);
  for (const [name, rule] of Object.entries(rules)) {
    const raw = first(search[name]);
    if (raw === undefined || raw === '') continue;
    let v: string | undefined;
    if (rule === 'date') v = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
    else if (rule === 'month') v = /^\d{4}-(0[1-9]|1[0-2])$/.test(raw) ? raw : undefined;
    else if (rule === 'bool') v = raw === 'true' || raw === 'false' ? raw : undefined;
    else if (rule === 'uuid') v = isUuid(raw) ? raw : undefined;
    else if (rule === 'cursor') v = /^[A-Za-z0-9_\-=.]{1,512}$/.test(raw) && !raw.includes('..') ? raw : undefined;
    else if ('text' in rule) v = clean(raw).slice(0, rule.text) || undefined;
    else if ('one' in rule) v = rule.one.includes(raw) ? raw : undefined;
    else {
      const ok = raw.split(',').filter((x) => rule.csv.includes(x));
      v = ok.length ? [...new Set(ok)].join(',') : undefined;
    }
    if (v !== undefined) p.set(name, v);
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** GET a partner API path. 404 -> notFound(); any other failure throws a message-free error so the segment error boundary (ErrorState + retry) renders. */
export async function get<T>(path: string): Promise<T> {
  const r = await partnerApi<T>(path);
  if (r.ok && r.data !== undefined) return r.data;
  if (!r.ok && r.status === 404) notFound();
  throw new Error('partner_api_failed'); // [CONV] no upstream code/detail/title in the message (07-SECURITY: no internals in the UI)
}

/** Optional read (filter option lists): any failure gives undefined so the screen still renders; session redirects still propagate from partnerApi. */
export async function getOptional<T>(path: string): Promise<T | undefined> {
  const r = await partnerApi<T>(path);
  return r.ok ? r.data : undefined;
}

export const getMe = cache(() => get<Me>('/v1/partners/me'));
export const can = (me: Me, perm: string) => Array.isArray(me.permissions) && me.permissions.includes(perm);

export interface Paged<T> { data: T[]; page?: { next_cursor?: string; limit?: number } }
/** Defensive list read: a body without a data array is a failure, not an empty list. */
export async function getList<T>(path: string): Promise<Paged<T>> {
  const r = await get<Paged<T>>(path);
  if (!Array.isArray(r?.data)) throw new Error('partner_api_failed');
  return r;
}

/** Query-string -> initial filter values for the client FilterBar (same whitelist applied). */
export const initialOf = (search: Search, names: readonly string[]): Record<string, string> =>
  Object.fromEntries(names.flatMap((n) => { const v = first(search[n]); return v ? [[n, v.slice(0, 200)]] : []; }));
