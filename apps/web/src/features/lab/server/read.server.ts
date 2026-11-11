import 'server-only';
// BFF reads for the lab receive page: C5 coded set rejection_reasons (#53, active only) and LabSettingsDto.recollection_default (#47);
// T-27: the status board (#17). The board query carries only the range, centre_id and board_status (REQ-SEC-098: no patient / order identifier in a URL).
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { BOARD_STATUSES, ISO_MS_RE, UUID_RE, type BoardQuery, type RejectionReason, type StatusBoardPage } from './types';

const DAY_MS = 86_400_000;

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
  return serverFetch<StatusBoardPage>(`/v1/lab/status-board?${p.toString()}`);
}
