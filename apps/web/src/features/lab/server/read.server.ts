import 'server-only';
// BFF reads for the lab receive page: C5 coded set rejection_reasons (#53, active only) and LabSettingsDto.recollection_default (#47);
// T-27: the status board (#17). The board query carries only the range, centre_id, board_status and the opaque paging cursor/limit (REQ-SEC-098: no patient / order identifier in a URL).
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { BOARD_STATUSES, ISO_MS_RE, UUID_RE, type BoardQuery, type QueueItem, type RejectionReason, type StatusBoardPage } from './types';

const DAY_MS = 86_400_000;
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
