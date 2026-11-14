'use client';
// Shared client helpers for the inventory master screens. LD-140 (2026-11-13): kit components and token names only; one primary
// button per page; every status shows tone + icon + word. The Idempotency-Key lives in a ref: reused on resubmit, new per form.
import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Icon } from '@lims/ui/components/Icon';
import { Inline } from '@lims/ui/components/Inline';
import { StatusChip } from '@lims/ui/components/StatusChip';
import type { FilterValue } from '@lims/ui/components/FilterBar';
import type { ActionResult } from '../server/types';

export type Failure = Extract<ActionResult<unknown>, { ok: false }>;

/** UUID v4 text (36 url-safe chars) is a valid Idempotency-Key (16-64 chars). */
export function newKey(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  // ponytail: Math.random fallback for old browsers; keys are not secrets, only unique per attempt
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}
export function useIdemKey() {
  const k = useRef<string | undefined>(undefined);
  return {
    get: () => (k.current ??= newKey()),
    reset: () => {
      k.current = undefined;
    },
  };
}

export function ProblemBanner({ problem }: { problem: Failure | undefined }) {
  if (!problem) return null;
  return (
    <div role="alert">
      <Banner tone="danger" title={problem.title || problem.code}>
        {problem.requestId ? `Reference: ${problem.requestId}` : null}
      </Banner>
    </div>
  );
}

export function ActiveChip({ active }: { active: boolean }) {
  return (
    <Inline gap={1}>
      <Icon name={active ? 'check' : 'info'} />
      <StatusChip kind="generic" status={active ? 'active' : 'inactive'} tone={active ? 'success' : 'neutral'} label={active ? 'Active' : 'Inactive'} size="sm" />
    </Inline>
  );
}

export const yesNo = (b: boolean) => (b ? 'Yes' : 'No');
export const isoDate = (s: string | undefined) => (s ? s.slice(0, 10) : '—');

/** Filters live in the URL (shareable, the server component re-fetches). Text is debounced. */
export function useUrlFilters(keys: readonly string[]) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [value, setValue] = useState<FilterValue>(() => Object.fromEntries(keys.map((k) => [k, sp.get(k) ?? undefined])));
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => {
      const p = new URLSearchParams(sp.toString());
      for (const k of keys) {
        const x = value[k];
        if (typeof x === 'string' && x) p.set(k, x);
        else p.delete(k);
      }
      p.delete('cursor');
      const qs = p.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return { value, onChange: setValue, onReset: () => setValue({}) };
}
