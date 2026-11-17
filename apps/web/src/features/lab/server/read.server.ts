import 'server-only';
// BFF reads for the lab receive page: C5 coded set rejection_reasons (#53, active only) and LabSettingsDto.recollection_default (#47);
// T-23: ingest exception queue (#38/#39) and order results; T-27: the status board (#17). The board query carries only the range, centre_id, board_status and the opaque paging cursor/limit (REQ-SEC-098: no patient / order identifier in a URL).
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import type { AnalyteInfo, AnalyteMap } from '../components/grid/resultModel';
import { BOARD_STATUSES, EXCEPTION_REASONS, EXCEPTION_STATUSES, ISO_MS_RE, UUID_RE, type BoardQuery, type CodedOption, type CommentCodeRow, type ExceptionPage, type HistoryRow, type IngestException, type IngestExceptionDetailDto, type OrderResults, type QueueItem, type RejectionReason, type SpecimenDetail, type StatusBoardPage, type TrendResponse } from './types';

const DAY_MS = 86_400_000;
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const CURSOR_RE = /^[A-Za-z0-9_-]{1,512}$/;

/** C7 E23 instruments as { id, name } for the QC screen (T-25, 08 A13 D-14: names come from C7, never from lab.yaml). A refused read is the caller's "none". */
export async function listInstrumentOptions(): Promise<{ id: string; name: string }[]> {
  const r = await serverFetch<{ data: { id: string; display_name: string }[] }>('/v1/instruments/instruments?limit=200');
  return r.data.map((i) => ({ id: i.id, name: i.display_name }));
}

/** C5 coded set (#53), active only, in sort_order. */
export async function listCodedSet(set: 'rejection_reasons' | 'return_reasons' | 'amendment_reasons'): Promise<CodedOption[]> {
  const r = await serverFetch<{ data: { code: string; display: string; sort_order?: number; is_active?: boolean }[] }>(`/v1/lab/coded-sets/${set}`);
  return r.data
    .filter((c) => c.is_active !== false)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map(({ code, display }) => ({ code, display }));
}
export const listRejectionReasons = (): Promise<RejectionReason[]> => listCodedSet('rejection_reasons');

/** #listOrderResults (04-UI-UX §3.4: Enter opens the grid filtered to the department). Only a valid department_id is forwarded (REQ-SEC-028). 404/5xx throw. */
export async function listOrderResults(orderId: string, sp: Record<string, string | string[] | undefined> = {}): Promise<OrderResults> {
  if (!UUID_RE.test(orderId)) throw new ApiError(404, problem('common.not_found', 'Not found', 404));
  const dept = typeof sp['department_id'] === 'string' ? sp['department_id'] : undefined;
  const q = dept && UUID_RE.test(dept) ? `?${new URLSearchParams({ department_id: dept })}` : '';
  return serverFetch<OrderResults>(`/v1/lab/orders/${orderId}/results${q}`);
}

/** C3 #getAnalyte (`catalog.test.read`) per distinct analyte_id → grid AnalyteMap (review C5.T-20 #1). result_type numeric/ordinal map 1:1; the other
 * types are entered as text. A 403/404 drops that analyte (grid falls back to the code + numeric check); 5xx throws (error.tsx). */
export async function getAnalytes(ids: readonly string[]): Promise<AnalyteMap> {
  type Detail = { name: string; current_version?: { result_type: string; decimals?: number } };
  const pairs = await Promise.all([...new Set(ids)].filter((id) => UUID_RE.test(id)).map(async (id) => {
    try {
      const d = await serverFetch<Detail>(`/v1/catalog/analytes/${id}`);
      const rt = d.current_version?.result_type;
      const info: AnalyteInfo = { name: d.name, value_type: rt === 'numeric' || rt === 'ordinal' ? rt : 'text' };
      if (typeof d.current_version?.decimals === 'number') info.decimals = d.current_version.decimals;
      return [id, info] as const;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) return null;
      throw e;
    }
  }));
  return Object.fromEntries(pairs.filter((p) => p !== null));
}

const bad400 = () => new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
/** #getResultHistory: id only in the path (P-02); the API caps the page, the grid shows the first 5. */
export async function getResultHistory(resultId: string): Promise<HistoryRow[]> {
  if (!UUID_RE.test(resultId)) throw bad400();
  return (await serverFetch<{ data: HistoryRow[] }>(`/v1/lab/results/${resultId}/history?limit=5`)).data;
}
/** #getAnalyteTrend: ids only in the path (P-02). */
export async function getAnalyteTrend(patientId: string, analyteId: string): Promise<TrendResponse> {
  if (!UUID_RE.test(patientId) || !UUID_RE.test(analyteId)) throw bad400();
  return serverFetch<TrendResponse>(`/v1/lab/patients/${patientId}/analytes/${analyteId}/trend?limit=50`);
}
/** C3 #listCommentCodes through the BFF (T-18 CommentCell lookup). The prefix is 1..16 [A-Z0-9_] like the short-code token. */
export async function listCommentCodes(prefix: string): Promise<CommentCodeRow[]> {
  if (typeof prefix !== 'string' || !/^[A-Z0-9_]{0,16}$/.test(prefix)) throw bad400();
  const r = await serverFetch<{ data: (CommentCodeRow & { is_active?: boolean })[] }>(`/v1/catalog/comment-codes?${new URLSearchParams({ code_prefix: prefix })}`);
  return r.data.filter((c) => c.is_active !== false).map(({ code, text, version }) => ({ code, text, version }));
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

/** #3 getSpecimen (T-30). The id is validated here: a malformed id never reaches the request path (REQ-SEC-028). 404/403/5xx throw to the page. */
export async function getSpecimen(id: string): Promise<SpecimenDetail> {
  if (!UUID_RE.test(id)) throw new ApiError(404, problem('common.not_found', 'Not found', 404));
  return serverFetch<SpecimenDetail>(`/v1/lab/specimens/${id}`);
}

export async function getRecollectionDefault(): Promise<boolean> {
  return (await serverFetch<{ recollection_default?: boolean }>('/v1/lab/settings')).recollection_default === true;
}

/** GET /v1/lab/status-board — the arguments are re-validated here (a server action is a public endpoint); the API validates again (S-11). */
export async function getStatusBoard(q: BoardQuery): Promise<StatusBoardPage> {
  const bad = () => new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
  const from = q?.registered_at_from, to = q?.registered_at_to;
  if (typeof from !== 'string' || typeof to !== 'string' || !ISO_MS_RE.test(from) || !ISO_MS_RE.test(to)) throw bad();
  const span = Date.parse(to) - Date.parse(from);
  if (!(span >= 0 && span <= 7 * DAY_MS)) throw bad();
  const p = new URLSearchParams({ registered_at_from: from, registered_at_to: to });
  if (q.centre_id !== undefined && q.centre_id !== '') { if (typeof q.centre_id !== 'string' || !UUID_RE.test(q.centre_id)) throw bad(); p.set('centre_id', q.centre_id); }
  if (q.board_status !== undefined && q.board_status !== '') {
    const parts = typeof q.board_status === 'string' ? q.board_status.split(',') : [];
    if (!parts.every((s) => (BOARD_STATUSES as readonly string[]).includes(s))) throw bad();
    p.set('board_status', parts.join(','));
  }
  // Review C5.T-27 #1: paging pass-through (API: limit 1..200, opaque cursor).
  if (q.cursor !== undefined) { if (typeof q.cursor !== 'string' || q.cursor === '' || q.cursor.length > 512) throw bad(); p.set('cursor', q.cursor); }
  if (q.limit !== undefined) { if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > 200) throw bad(); p.set('limit', String(q.limit)); }
  return serverFetch<StatusBoardPage>(`/v1/lab/status-board?${p.toString()}`);
}
