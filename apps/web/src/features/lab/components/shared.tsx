// Shared bits of the C5 lab screens. Merge of T-11 helpers (collect / dispatch / receive; was shared.ts) and
// T-26 worklist / pending / worksheet bits (04-UI-UX §3.4, §3.5, §3.15). Text only: no colour- or icon-only meaning.
import { useRef } from 'react';
import { ErrorState } from '@lims/ui/components/ErrorState';
import type { ActionResult } from '../server/types';

// ---- T-11: collect / dispatch / receive helpers (client side; no network code here) ----

/** Runs scan jobs strictly one after another, so rows / receives follow SCAN order even when lookups answer out of order. */
export function useSerial() {
  const tail = useRef<Promise<unknown>>(Promise.resolve());
  return (job: () => Promise<void>) => {
    tail.current = tail.current.then(job).catch(() => undefined);
  };
}

/** Enter in an empty scan box (the kit already handled it when it consumed a value and called preventDefault). */
export const enterOnEmptyBox = (e: { key: string; ctrlKey: boolean; defaultPrevented: boolean; target: EventTarget }) =>
  e.key === 'Enter' && !e.ctrlKey && !e.defaultPrevented && e.target instanceof HTMLInputElement && e.target.type === 'text' && e.target.value === '';

export const NOT_FOUND = 'No specimen with this barcode in your lab.';
export const FAILED = 'Something went wrong. Try again.';

/** Idempotency-Key for one user action (02-CONVENTIONS §4.5). randomUUID needs a secure context; the fallback only matters on plain-http workstations. */
export const newKey = (): string => globalThis.crypto?.randomUUID?.() ?? `k${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;

/** A server action that throws (network drop, deploy skew) becomes a failed result instead of an unhandled rejection. */
export async function call<T>(p: Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await p;
  } catch {
    return { ok: false, status: 0, code: 'common.internal', title: 'Something went wrong' };
  }
}

/** Human text for per-row bulk failures (titles from contracts/errors.yaml). */
const CODE_TEXT: Record<string, string> = {
  'lab.specimen_invalid_transition': 'Specimen cannot move to the requested state',
  'lab.specimen_inactive': 'Specimen inactive (order cancelled)',
  'common.not_found': 'Specimen not found',
  'common.version_conflict': 'Specimen changed since it was scanned — scan it again',
};
export const rowError = (code?: string) => (code && CODE_TEXT[code]) || 'Could not update this specimen';

export const statusText = (s: string) => s.replace(/_/g, ' ');
export const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

// ---- T-26: worklist / pending / worksheet bits ----

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
