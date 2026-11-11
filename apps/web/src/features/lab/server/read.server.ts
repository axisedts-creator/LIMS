import 'server-only';
// BFF reads for the lab receive page: C5 coded set rejection_reasons (#53, active only) and LabSettingsDto.recollection_default (#47).
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { EXCEPTION_REASONS, EXCEPTION_STATUSES, UUID_RE, type ExceptionPage, type IngestException, type IngestExceptionDetailDto, type OrderResult, type OrderResultsItem, type QueueItem, type RejectionReason } from './types';

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const CURSOR_RE = /^[A-Za-z0-9_-]{1,512}$/;

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

/** #38. Only status / reason / instrument_id / cursor are forwarded, and only when valid (a stray barcode / q / patient param never reaches the API, REQ-SEC-028). A failed read throws. */
export async function listIngestExceptions(sp: Record<string, string | string[] | undefined> = {}): Promise<ExceptionPage> {
  const one = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : undefined);
  const q = new URLSearchParams();
  const status = one('status'), reason = one('reason'), instrument = one('instrument_id'), cursor = one('cursor');
  if (status && (EXCEPTION_STATUSES as readonly string[]).includes(status)) q.set('status', status);
  if (reason && reason.split(',').every((r) => (EXCEPTION_REASONS as readonly string[]).includes(r))) q.set('reason', reason);
  if (instrument && UUID_RE.test(instrument)) q.set('instrument_id', instrument);
  if (cursor && CURSOR_RE.test(cursor)) q.set('cursor', cursor);
  const r = await serverFetch<{ data: IngestException[]; page?: { next_cursor?: string } }>(`/v1/lab/ingest-exceptions${q.size ? `?${q}` : ''}`);
  return { items: r.data, ...(r.page?.next_cursor ? { nextCursor: r.page.next_cursor } : {}) };
}

/** #39 (raw value included, access-logged by the API). The id is validated here: a malformed id never reaches the request path. */
export async function getIngestException(id: string): Promise<IngestExceptionDetailDto> {
  if (!UUID_RE.test(id)) throw new ApiError(404, problem('common.not_found', 'Not found', 404));
  return serverFetch<IngestExceptionDetailDto>(`/v1/lab/ingest-exceptions/${id}`);
}

export async function listDiscardReasons(): Promise<RejectionReason[]> {
  const r = await serverFetch<{ data: { code: string; display: string; sort_order?: number; is_active?: boolean }[] }>('/v1/lab/coded-sets/exception_discard_reasons');
  return r.data.filter((c) => c.is_active !== false).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)).map(({ code, display }) => ({ code, display }));
}

/** Results of an order for the assign dialog (cancelled rows are not offered). */
export async function listOrderResults(orderId: string): Promise<OrderResult[]> {
  if (!UUID_RE.test(orderId)) throw new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
  const r = await serverFetch<{ items: OrderResultsItem[] }>(`/v1/lab/orders/${orderId}/results`);
  return r.items.flatMap((i) => i.results).filter((x) => x.status !== 'cancelled');
}

export async function getRecollectionDefault(): Promise<boolean> {
  return (await serverFetch<{ recollection_default?: boolean }>('/v1/lab/settings')).recollection_default === true;
}
