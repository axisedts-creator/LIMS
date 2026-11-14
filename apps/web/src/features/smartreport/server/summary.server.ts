import 'server-only';
// SR-02 BFF calls (TRD §5 #26, #28, #31, #32). The bearer token is added by serverFetch on the server; ids are checked by the callers before they reach a URL.
import { serverFetch } from '@/core/api/server-fetch';

const json =(body: unknown, version: number): RequestInit => ({
  method: 'POST', headers: { 'content-type': 'application/json', 'if-match': `"${version}"` }, body: JSON.stringify(body),
});
const at = (id: string, tail = '') => `/v1/smartreport/summaries/${encodeURIComponent(id)}${tail}`;

export interface RawSummary extends Record<string, unknown> { id: string; status: string; version: number }
export interface Reason { code: string; display: string }

export const getSummary = (id: string) => serverFetch<RawSummary>(at(id));
export const approveSummary = (id: string, version: number, body: { attestation: true }) => serverFetch<unknown>(at(id, '/approve'), json(body, version));
export const rejectSummary = (id: string, version: number, body: { reason_code: string; comment?: string }) => serverFetch<unknown>(at(id, '/reject'), json(body, version));

/** #26 coded set `summary_reject_reasons`; a failure leaves the Select empty and the history in plain words instead of breaking the page. */
export const rejectReasons = (): Promise<Reason[]> =>
  serverFetch<{ items?: { code: string; display: string; sort_order?: number; is_active?: boolean }[] }>('/v1/smartreport/coded-sets/summary_reject_reasons')
    .then((r) => (r?.items ?? []).filter((i) => i.is_active !== false).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)).map((i) => ({ code: String(i.code), display: String(i.display) })))
    .catch(() => []);
