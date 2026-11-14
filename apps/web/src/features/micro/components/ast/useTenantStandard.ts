'use client';
// The tenant's default AST standard (settings.manual_ast_standard) through a server action (the JWT never reaches the client). Read once, when the first grid is about to
// be shown. A refused (403) or failed read means "no standard": the grid still works with an empty selector (03-APP-FLOW §4.5).
import { useEffect, useState } from 'react';
import { getTenantStandardAction } from '../../server/astActions';

export interface TenantStandard { loaded: boolean; standard?: 'CLSI' | 'EUCAST' }

export function useTenantStandard(enabled: boolean): TenantStandard {
  const [state, setState] = useState<TenantStandard>({ loaded: false });
  useEffect(() => {
    if (!enabled || state.loaded) return;
    let alive = true;
    getTenantStandardAction().then(
      (r) => { if (alive) setState(r.ok && r.data.standard ? { loaded: true, standard: r.data.standard } : { loaded: true }); },
      () => { if (alive) setState({ loaded: true }); },
    );
    return () => { alive = false; };
  }, [enabled, state.loaded]);
  return state;
}
