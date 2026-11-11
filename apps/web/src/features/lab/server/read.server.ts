import 'server-only';
// BFF reads for the lab receive page: C5 coded set rejection_reasons (#53, active only) and LabSettingsDto.recollection_default (#47).
import { serverFetch } from '@/core/api/server-fetch';
import { UUID_RE, type QueueItem, type RejectionReason } from './types';

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;

export async function listRejectionReasons(): Promise<RejectionReason[]> {
  const r = await serverFetch<{ data: { code: string; display: string; sort_order?: number; is_active?: boolean }[] }>('/v1/lab/coded-sets/rejection_reasons');
  return r.data
    .filter((c) => c.is_active !== false)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map(({ code, display }) => ({ code, display }));
}

/** #listVerificationQueue. Only the documented filters are forwarded (a stray param never reaches the API, REQ-SEC-028); invalid values are dropped. A failed read throws (no false "Nothing waiting"). */
export async function listVerificationQueue(stage: 'verify' | 'approve', sp: Record<string, string | string[] | undefined> = {}): Promise<QueueItem[]> {
  const one = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : undefined);
  const q = new URLSearchParams({ stage });
  const dept = one('department_id');
  const prio = one('priority');
  if (dept && UUID_RE.test(dept)) q.set('department_id', dept);
  if (prio && CODE_RE.test(prio)) q.set('priority', prio);
  if (one('flagged_only') === 'true') q.set('flagged_only', 'true');
  return (await serverFetch<{ data: QueueItem[] }>(`/v1/lab/verification-queue?${q}`)).data;
}

export async function getRecollectionDefault(): Promise<boolean> {
  return (await serverFetch<{ recollection_default?: boolean }>('/v1/lab/settings')).recollection_default === true;
}
