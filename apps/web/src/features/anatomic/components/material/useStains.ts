'use client';
// Active stains for the Add slides / Order stain pickers (K3 via a server action). Empty until loaded; a failing list leaves the pickers empty (the API re-checks every code).
// LD-140 (2026-11-13): no UI here.
import { useEffect, useState } from 'react';
import { listStainsAction } from '../../server/actions.material';
import type { Stain } from '../../server/types';

export function useStains(): readonly Stain[] {
  const [stains, setStains] = useState<readonly Stain[]>([]);
  useEffect(() => {
    let live = true;
    listStainsAction().then((r) => live && r.ok && setStains(r.data.filter((s) => s.is_active)), () => undefined);
    return () => { live = false; };
  }, []);
  return stains;
}

/** Splits a long id list into API-sized calls (REQ-SEC-100: at most 200 ids per call). */
export const chunk = <T,>(list: readonly T[], size = 200): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};
