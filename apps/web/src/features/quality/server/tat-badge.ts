import 'server-only';
// C9 04-UI-UX §1.1: nav badge of "TAT alerts" = open breached + escalated alerts (unacknowledged); "50+" when the first page is full.
// Never breaks the nav: no permission, no alerts or any failure -> no badge. Without quality.tat_alert.read no request is made.
import { serverFetch } from '@/core/api/server-fetch';
import { TAT_READ } from '../tat/tat.server';
import { permissions } from './quality.server';

const PAGE = 50;

export async function getTatAlertBadge(): Promise<string | undefined> {
  try {
    if (!(await permissions()).includes(TAT_READ)) return undefined;
    const q = new URLSearchParams({ level: 'breached,escalated', acknowledged: 'false', limit: String(PAGE) });
    const r = await serverFetch<{ data?: unknown[] }>(`/v1/quality/tat-alerts?${q.toString()}`);
    const n = Array.isArray(r?.data) ? r.data.length : 0;
    return n >= PAGE ? `${PAGE}+` : n > 0 ? String(n) : undefined;
  } catch (e) {
    // LD-455 rule 3: a swallowed failure is still logged (no token, no body: only the error text).
    console.warn('[quality] TAT nav badge unavailable:', e instanceof Error ? e.message : String(e));
    return undefined;
  }
}
