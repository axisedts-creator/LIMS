import 'server-only';
// BFF reads for the lab receive page: C5 coded set rejection_reasons (#53, active only) and LabSettingsDto.recollection_default (#47).
import { serverFetch } from '@/core/api/server-fetch';
import type { RejectionReason } from './types';

export async function listRejectionReasons(): Promise<RejectionReason[]> {
  const r = await serverFetch<{ data: { code: string; display: string; sort_order?: number; is_active?: boolean }[] }>('/v1/lab/coded-sets/rejection_reasons');
  return r.data
    .filter((c) => c.is_active !== false)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map(({ code, display }) => ({ code, display }));
}

export async function getRecollectionDefault(): Promise<boolean> {
  return (await serverFetch<{ recollection_default?: boolean }>('/v1/lab/settings')).recollection_default === true;
}
