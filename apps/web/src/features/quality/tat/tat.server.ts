import 'server-only';
// C9 T-24 TAT reads (BFF, #48). Permission is checked BEFORE any API call; only whitelisted, well-formed search params reach the API (07-SECURITY);
// centre scoping is the API's job (RLS): this module never adds or removes a centre of its own (AC-14.7). The token stays on the server (REQ-SEC-068).
import { serverFetch } from '@/core/api/server-fetch';
import { bool, cursor, enumList, first, put, uuid } from '../server/quality.server';
import type { ListPage, TatAlert } from '../types';

export const TAT_READ = 'quality.tat_alert.read';
export const TAT_ACK = 'quality.tat_alert.ack';

export const TAT_LEVELS = ['warning', 'breached', 'escalated'] as const;
const SEGMENTS = ['within_lab', 'total'] as const;
const PRIORITIES = ['routine', 'urgent'] as const;

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | undefined, allowed: readonly string[]) => (v && allowed.includes(v) ? v : undefined);

/** Default: open (unacknowledged) alerts, highest level first (the API breaks ties by % of target). */
export function tatQuery(sp: SP): URLSearchParams {
  const q = new URLSearchParams();
  put(q, 'level', enumList(first(sp['level']), TAT_LEVELS));
  q.set('acknowledged', bool(first(sp['acknowledged'])) ?? 'false');
  put(q, 'segment', one(first(sp['segment']), SEGMENTS));
  put(q, 'priority', one(first(sp['priority']), PRIORITIES));
  put(q, 'department_id', uuid(first(sp['department_id'])));
  put(q, 'centre_id', uuid(first(sp['centre_id'])));
  put(q, 'cursor', cursor(first(sp['cursor'])));
  q.set('sort', '-alert_level_rank');
  q.set('limit', '50');
  return q;
}

export interface FilterOption { value: string; label: string }
type Named = { id?: string; centre_id?: string; name?: string; is_active?: boolean };
const options = (path: string) =>
  serverFetch<{ data?: Named[] }>(path)
    .then((r) => (Array.isArray(r?.data) ? r.data : []).filter((x) => x.is_active !== false).flatMap((x) => {
      const id = uuid(x.centre_id ?? x.id);
      return id && typeof x.name === 'string' ? [{ value: id, label: x.name }] : [];
    }))
    .catch((): FilterOption[] => []);
/** Department / centre filter options (C3 listDepartments, C2 listCentres; 04-UI-UX §2.10). A failing picker only empties its filter, never the page. */
export const getTatFilterOptions = async () => {
  const [departments, centres] = await Promise.all([options('/v1/catalog/departments?limit=200'), options('/v1/identity/centres') /* LD-446: no limit */]);
  return { departments, centres };
};

export async function getTatAlerts(q: URLSearchParams): Promise<ListPage<TatAlert>> {
  const p = await serverFetch<{ data?: TatAlert[]; page?: { next_cursor?: string } }>(`/v1/quality/tat-alerts?${q.toString()}`);
  return { rows: Array.isArray(p?.data) ? p.data : [], ...(p?.page?.next_cursor ? { next: p.page.next_cursor } : {}) };
}
