'use client';
// T0D-UIGUARD-1-ADMIN (LD-353 rule 2, LD-436 worklist mock, LD-439): the admin list filters are the kit FilterBar. Filters live in the
// URL exactly as the old GET form sent them (same parameter names, the server page still whitelists and validates every value), so a
// filtered list stays shareable and the page re-reads on change. Selects apply at once; typed values apply on Search (no request
// per key stroke, a half typed date never reaches the API). Reset drops every filter and the cursor.
import { useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { FilterBar, type FilterDef, type FilterValue } from '@lims/ui/components/FilterBar';

export function UrlFilters({ filters, initial, keep = [], resetLabel }: { filters: readonly FilterDef[]; initial: FilterValue; keep?: readonly string[]; resetLabel?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [value, setValue] = useState<FilterValue>(initial);
  const go = (v: FilterValue) => {
    const p = new URLSearchParams();
    for (const k of keep) { const x = sp.get(k); if (x) p.set(k, x); }
    for (const f of filters) { const x = v[f.id]; if (typeof x === 'string' && x) p.set(f.id, x); }
    const q = p.toString();
    router.push(q ? `${pathname}?${q}` : pathname);
  };
  const onChange = (v: FilterValue) => {
    setValue(v);
    const changed = filters.find((f) => v[f.id] !== value[f.id]);
    if (changed && changed.kind !== 'text') go(v);
  };
  const hasText = filters.some((f) => f.kind === 'text');
  return (
    <FilterBar filters={filters} value={value} onChange={onChange} onReset={() => { setValue({}); go({}); }}
      {...(hasText ? { onSearch: () => go(value) } : {})} {...(resetLabel ? { resetLabel } : {})} />
  );
}
