import 'server-only';
// C16.T-Q4 BFF calls for W6/W7 (contracts/openapi/engagement.yaml Q1a–Q8). The bearer token is added by serverFetch on the server;
// ids are shape-checked before they reach a URL. Console (operate) and setup (manage) read different endpoints: one permission floor per operation (08 A19 P-43).
import { notFound } from 'next/navigation';
import { serverFetch } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import type { Queue, QueueCounter, QueueDisplayRow, QueueToken } from '../components/queue-model';

export const OPERATE = 'engagement.queue.operate';
export const MANAGE = 'engagement.queue.manage';
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const E = '/v1/engagement';

const json = (method: string, body?: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});
const ifMatch = (v: number) => ({ 'if-match': `"${v}"` });
const idem = (k: string) => ({ 'idempotency-key': k });
const rows = <T,>(r: { data?: T[] } | undefined): T[] => (Array.isArray(r?.data) ? r.data : []);
const id = (v: string) => { if (!UUID_RE.test(v)) throw new Error('invalid id'); return encodeURIComponent(v); };

/** True when the session holds the permission (UI/BFF guard; the API re-checks it on every call). */
export async function has(perm: string) {
  return ((await getShellSession())?.actor.permissions ?? []).includes(perm);
}
/** notFound() unless the session holds the permission. Runs before any API call. */
export async function requirePerm(perm: string) {
  if (!(await has(perm))) notFound();
}

/** Centre the console works on: ?centre_id=<uuid> when valid, else the first centre the actor can see. */
export async function resolveCentre(requested: string | undefined): Promise<string | undefined> {
  if (requested && UUID_RE.test(requested)) return requested;
  const c = await serverFetch<{ data?: { centre_id?: string; id?: string }[] }>('/v1/identity/centres').catch(() => undefined);
  const first = rows(c)[0];
  return first?.centre_id ?? first?.id;
}

// ---- W6 console (operate) ----
export const listQueues = async (centreId: string) => rows(await serverFetch<{ data?: Queue[] }>(`${E}/queues?centre_id=${id(centreId)}&is_active=true`));
export const listCounters = async (centreId: string) => rows(await serverFetch<{ data?: QueueCounter[] }>(`${E}/queue-counters?centre_id=${id(centreId)}&is_active=true`));
export const listTokens = async (centreId: string) => rows(await serverFetch<{ data?: QueueToken[] }>(`${E}/queue-tokens?centre_id=${id(centreId)}`));
export const issueToken = (body: { queue_id: string; priority: 'normal' | 'priority' }, key: string) => serverFetch<QueueToken>(`${E}/queue-tokens`, json('POST', body, idem(key)));
/** 204 (nobody waiting) → null. */
export async function callNext(queueId: string, counterId: string): Promise<QueueToken | null> {
  const r = await serverFetch<QueueToken | undefined>(`${E}/queues/${id(queueId)}/call-next`, json('POST', { counter_id: counterId }));
  return r && typeof r === 'object' && 'id' in r ? r : null;
}
const step = (token: string, op: 'recall' | 'serve' | 'complete' | 'skip', version: number, body?: unknown) =>
  serverFetch<QueueToken>(`${E}/queue-tokens/${id(token)}/${op}`, json('POST', body, ifMatch(version)));
export const recallToken = (token: string, version: number) => step(token, 'recall', version);
export const serveToken = (token: string, version: number, counterId: string) => step(token, 'serve', version, { counter_id: counterId });
export const completeToken = (token: string, version: number) => step(token, 'complete', version);
export const skipToken = (token: string, version: number) => step(token, 'skip', version);
export const transferToken = (token: string, version: number, toQueueId: string, key: string) =>
  serverFetch<{ from: QueueToken; to: QueueToken }>(`${E}/queue-tokens/${id(token)}/transfer`, json('POST', { to_queue_id: toQueueId }, { ...ifMatch(version), ...idem(key) }));

// ---- W7 setup (manage) ----
export const listQueueDefinitions = async (centreId: string) => rows(await serverFetch<{ data?: Queue[] }>(`${E}/queue-setup/queues?centre_id=${id(centreId)}`));
export const listCounterDefinitions = async (centreId: string) => rows(await serverFetch<{ data?: QueueCounter[] }>(`${E}/queue-setup/counters?centre_id=${id(centreId)}`));
export const listDisplays = async (centreId: string) => rows(await serverFetch<{ data?: QueueDisplayRow[] }>(`${E}/queue-displays?centre_id=${id(centreId)}`));
export const createQueue = (body: Record<string, unknown>, key: string) => serverFetch<Queue>(`${E}/queues`, json('POST', body, idem(key)));
export const updateQueue = (queue: string, version: number, body: Record<string, unknown>) => serverFetch<Queue>(`${E}/queues/${id(queue)}`, json('PUT', body, ifMatch(version)));
export const createCounter = (body: Record<string, unknown>, key: string) => serverFetch<QueueCounter>(`${E}/queue-counters`, json('POST', body, idem(key)));
export const updateCounter = (counter: string, version: number, body: Record<string, unknown>) => serverFetch<QueueCounter>(`${E}/queue-counters/${id(counter)}`, json('PUT', body, ifMatch(version)));
/** Q8 pair: the 201 body holds the one-time secret; callers hand it straight to the cookie setter and never return it. */
export const pairDisplayRaw = (body: { centre_id: string; display_name: string; queue_ids: string[] }) =>
  serverFetch<{ display: QueueDisplayRow; display_token: string }>(`${E}/queue-displays`, json('POST', body));
export const revokeDisplay = (display: string, version: number) => serverFetch<unknown>(`${E}/queue-displays/${id(display)}/revoke`, json('POST', undefined, ifMatch(version)));
