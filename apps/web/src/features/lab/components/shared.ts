// Small helpers shared by the collect / dispatch / receive screens (client side; no network code here).
import { useRef } from 'react';
import type { ActionResult } from '../server/types';

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
