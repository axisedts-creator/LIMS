import 'server-only';
// listLabCodedSet: BFF over C5 GET /v1/lab/coded-sets/{set_name} (lab.yaml listLabCodedSet) under the user's session. The set name is checked against the four lab sets BEFORE any
// request (REQ-SEC-026/027). 08 A17 D-62 / 07-SECURITY S-30: for `amendment_reasons` the three system codes below are removed, so a user can never pick them on "Reopen for amendment"
// (C10 sends them itself: module_phase_progression / module_preliminary_update on its automatic amendments). Inactive codes are dropped. Any failure -> [] (the dialog stays usable); nothing is logged.
import { serverFetch } from '@/core/api/server-fetch';
import type { LabCodeLite } from './types';

export const LAB_CODED_SETS = ['rejection_reasons', 'return_reasons', 'amendment_reasons', 'exception_discard_reasons'] as const;
export type LabCodedSetName = (typeof LAB_CODED_SETS)[number];
/** 08 A17 D-62 */
const SYSTEM_AMENDMENT_CODES: ReadonlySet<string> = new Set(['module_phase_progression', 'module_preliminary_update', 'supplementary_report']);

interface Row { code?: unknown; display?: unknown; is_active?: unknown }

export async function listLabCodedSet(setName: LabCodedSetName): Promise<LabCodeLite[]> {
  if (typeof setName !== 'string' || !(LAB_CODED_SETS as readonly string[]).includes(setName)) return [];
  try {
    const r = await serverFetch<{ data?: unknown }>(`/v1/lab/coded-sets/${setName}`);
    if (!Array.isArray(r?.data)) return [];
    const out: LabCodeLite[] = [];
    for (const row of r.data as Row[]) {
      if (typeof row?.code !== 'string' || typeof row.display !== 'string' || row.is_active === false) continue;
      if (setName === 'amendment_reasons' && SYSTEM_AMENDMENT_CODES.has(row.code)) continue;
      out.push({ code: row.code, display: row.display });
    }
    return out;
  } catch {
    return [];
  }
}
