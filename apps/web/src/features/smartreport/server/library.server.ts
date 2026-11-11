import 'server-only';
// SR-03/SR-04 BFF calls (TRD §5 #1–#19, #35). The bearer token is added by serverFetch on the server; ids are checked before they reach a URL.
import { notFound } from 'next/navigation';
import { serverFetch } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import type { Block, Group, Issue, Mapping, Option, Rule, Summary, Term, Version } from '../library';

export const PERM = 'smartreport.template.manage';
const SR = '/v1/smartreport/library-versions';
const json = (method: string, body?: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});
const ifMatch = (v: number) => ({ 'if-match': `"${v}"` });
const idem = (k: string) => ({ 'idempotency-key': k });

/** notFound() unless the session holds smartreport.template.manage. Runs before any API call. */
export async function requireManage() {
  const perms = (await getShellSession())?.actor.permissions ?? [];
  if (!perms.includes(PERM)) notFound();
}

export const APPROVE_PERM = 'smartreport.template.approve';
/** SR-05: notFound() unless the session holds manage OR approve (the page is read-only without approve). Returns what the session may do. */
export async function requireReview() {
  const perms = (await getShellSession())?.actor.permissions ?? [];
  if (!perms.includes(PERM) && !perms.includes(APPROVE_PERM)) notFound();
  return { canApprove: perms.includes(APPROVE_PERM) };
}
/** True when the session may preview with a real order (UI hint only; the API re-checks lab.result.read for the order's centre). */
export async function canReadResults() {
  return ((await getShellSession())?.actor.permissions ?? []).includes('lab.result.read');
}

const v = (id: string, tail = '') => `${SR}/${encodeURIComponent(id)}${tail}`;
const data = <T,>(r: { data?: T[] } | undefined) => (Array.isArray(r?.data) ? r.data : []);

export const listVersions = async () => data(await serverFetch<{ data?: Summary[] }>(SR));
/** The single approved (active) version, read with the #1 status filter so paging never hides it. */
export const activeVersion = async () => data(await serverFetch<{ data?: Summary[] }>(`${SR}?status=approved&limit=1`)).find((s) => s.status === 'approved');
export const getVersion =(id: string) => serverFetch<Version>(v(id));
export const listBlocks = async (id: string) => data(await serverFetch<{ data?: Block[] }>(v(id, '/blocks')));
export const listRules = async (id: string) => data(await serverFetch<{ data?: Rule[] }>(v(id, '/rules')));
export const listMappings = async (id: string) => data(await serverFetch<{ data?: Mapping[] }>(v(id, '/analyte-groups')));
export const listGroups = async (id: string) => data(await serverFetch<{ data?: Group[] }>(v(id, '/groups')));
/** #35 organ groups; a failure leaves the Select empty instead of breaking the page. */
export const organGroups = async (): Promise<Option[]> =>
  serverFetch<{ items?: { code: string; display: string; is_active?: boolean }[] }>('/v1/smartreport/library/coded-sets/organ_groups')
    .then((r) => (r?.items ?? []).filter((i) => i.is_active !== false).map((i) => ({ value: String(i.code), label: String(i.display) })))
    .catch(() => []);

export const createVersion = (body: Record<string, unknown>, key: string) => serverFetch<Version>(SR, json('POST', body, idem(key)));
export const patchVersion = (id: string, version: number, body: Record<string, unknown>) => serverFetch<Version>(v(id), json('PATCH', body, ifMatch(version)));
export const createBlock = (id: string, body: Record<string, unknown>, key: string) => serverFetch<Block>(v(id, '/blocks'), json('POST', body, idem(key)));
export const replaceBlock = (id: string, blockId: string, version: number, body: Record<string, unknown>) => serverFetch<Block>(v(id, `/blocks/${blockId}`), json('PUT', body, ifMatch(version)));
export const deleteBlock = (id: string, blockId: string, version: number) => serverFetch<unknown>(v(id, `/blocks/${blockId}`), json('DELETE', undefined, ifMatch(version)));
export const createRule = (id: string, body: Record<string, unknown>, key: string) => serverFetch<Rule>(v(id, '/rules'), json('POST', body, idem(key)));
export const replaceRule = (id: string, ruleId: string, version: number, body: Record<string, unknown>) => serverFetch<Rule>(v(id, `/rules/${ruleId}`), json('PUT', body, ifMatch(version)));
export const deleteRule = (id: string, ruleId: string, version: number) => serverFetch<unknown>(v(id, `/rules/${ruleId}`), json('DELETE', undefined, ifMatch(version)));
export const putMapping = (id: string, analyteId: string, version: number, body: Record<string, unknown>) => serverFetch<Mapping>(v(id, `/analyte-groups/${analyteId}`), json('PUT', body, ifMatch(version)));
export const deleteMapping = (id: string, analyteId: string, version: number) => serverFetch<unknown>(v(id, `/analyte-groups/${analyteId}`), json('DELETE', undefined, ifMatch(version)));
export const putGroup = (id: string, code: string, version: number, body: Record<string, unknown>) => serverFetch<Group>(v(id, `/groups/${encodeURIComponent(code)}`), json('PUT', body, ifMatch(version)));
export const validateVersion = (id: string) => serverFetch<{ valid?: boolean; issues?: Issue[] }>(v(id, '/validate'), json('POST'));
export const approveVersion = (id: string, version: number, body: { attestation: true; note?: string }) => serverFetch<Version>(v(id, '/approve'), json('POST', body, ifMatch(version)));
export const returnVersion = (id: string, version: number, body: { comment: string }) => serverFetch<Version>(v(id, '/return'), json('POST', body, ifMatch(version)));
/** #22 read-only POST; the body (fixture code or order id) never goes into a URL. */
export const previewVersion = (id: string, body: { fixture_code: string } | { order_id: string }) => serverFetch<Record<string, unknown>>(v(id, '/preview'), json('POST', body));

// SR-06 wording terms (#23–#25)
const TERMS = '/v1/smartreport/wording-deny-terms';
export const listTerms = async () => data(await serverFetch<{ data?: Term[] }>(`${TERMS}?include_global=true`));
export const createTerm = (body: Record<string, unknown>, key: string) => serverFetch<Term>(TERMS, json('POST', body, idem(key)));
export const deactivateTerm = (id: string, version: number) => serverFetch<Term>(`${TERMS}/${encodeURIComponent(id)}/deactivate`, json('POST', undefined, ifMatch(version)));
export const submitVersion =(id: string, version: number) => serverFetch<Version>(v(id, '/submit'), json('POST', undefined, ifMatch(version)));
