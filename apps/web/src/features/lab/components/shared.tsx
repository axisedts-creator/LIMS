// C5 T-26 shared bits of the worklist / pending / worksheet screens (04-UI-UX §3.4, §3.5, §3.15). Text only: no colour- or icon-only meaning.
import { ErrorState } from '@lims/ui/components/ErrorState';
import type { ActionResult } from '../server/types';

export const STATUS_LABEL: Record<string, string> = {
  awaiting_collection: 'Awaiting collection', awaiting_receipt: 'Awaiting receipt', in_process: 'In process', resulted: 'Resulted', verified: 'Verified',
  approved: 'Approved', cancelled: 'Cancelled', excluded: 'Excluded', outsourced: 'Outsourced',
};
export const statusLabel = (s: string): string => STATUS_LABEL[s] ?? s;

/** hh:mm (04-UI-UX duration rule); "—" when there is nothing to show. */
export function hhmm(seconds: number | undefined): string {
  if (seconds === undefined) return '—';
  const m = Math.floor(Math.max(0, seconds) / 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
export const utc = (iso: string | undefined): string => (iso ? `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '—');

export const NO_ACCESS = "You don't have access to this screen.";
export const NOT_VISIBLE = "This item doesn't exist or isn't visible to you.";

/** The failure states every T-26 screen shares: 403 (no Retry, no data), 404, anything else = ErrorState with the request id and Retry (AC-07.5). */
export function Failure({ r, onRetry }: { r: Extract<ActionResult<unknown>, { ok: false }>; onRetry: () => void }) {
  if (r.status === 403) return <div className="lims-state"><p className="lims-state-title">{NO_ACCESS}</p></div>;
  if (r.status === 404) return <div className="lims-state"><p className="lims-state-title">{NOT_VISIBLE}</p></div>;
  return <ErrorState title="Something went wrong" {...(r.requestId ? { requestId: r.requestId } : {})} onRetry={onRetry} />;
}
