'use client';
// Filters live in the URL (shareable, server component re-fetches) — never in browser storage (04-UI-UX §1). Text input is debounced.
import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { FilterValue } from '@lims/ui/components/FilterBar';

const DEBOUNCE_MS = 400;

export function useUrlFilters(keys: readonly string[]) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const fromUrl = (): Record<string, string | string[] | undefined> =>
    Object.fromEntries(keys.map((k) => { const v = sp.get(k); return [k, v ? (k.endsWith('range') || k === 'registered' ? v.split(',') : v) : undefined]; }));
  const [value, setValue] = useState<FilterValue>(fromUrl);
  const first = useRef(true);
  const push = (v: FilterValue) => {
    const p = new URLSearchParams(sp.toString());
    for (const k of keys) {
      const x = v[k];
      const s = Array.isArray(x) ? x.join(',') : (x as string | undefined);
      if (s) p.set(k, s);
      else p.delete(k);
    }
    p.delete('cursor');
    const qs = p.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  };
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const t = setTimeout(() => push(value), DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return { value, onChange: setValue, onReset: () => setValue({}) };
}
