// Review-queue URL -> P1 query. Only whitelisted, well-formed values reach the API; anything else is dropped (07-SECURITY).
type SP = Record<string, string | string[] | undefined>;

export const REVIEW_STATUSES = ['held_for_review', 'pending', 'initiated', 'failed', 'expired', 'settled'] as const;
export const REVIEW_GATEWAYS = ['esewa', 'khalti', 'fonepay'] as const;

const DAY_MS = 86_400_000;
const NEPAL_OFFSET_MS = 20_700_000; // UTC+05:45
const MAX_WINDOW_DAYS = 31; // 04-UI-UX §2.1 [CONV]
const DEFAULT_WINDOW_DAYS = 7;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const csv = (v: string | string[] | undefined, ok: (s: string) => boolean): string[] =>
  [...new Set((first(v) ?? '').split(',').filter((s) => s.length <= 64 && ok(s)))];

/** A day (Asia/Kathmandu) or an instant -> epoch ms; undefined when malformed. */
function instant(v: string | string[] | undefined): { ms: number; isDay: boolean } | undefined {
  const s = first(v);
  if (!s) return undefined;
  const isDay = DAY.test(s);
  if (!isDay && !INSTANT.test(s)) return undefined;
  const ms = Date.parse(isDay ? `${s}T00:00:00+05:45` : s);
  return Number.isNaN(ms) ? undefined : { ms, isDay };
}
const dayOf = (ms: number) => new Date(ms + NEPAL_OFFSET_MS).toISOString().slice(0, 10);

/** What the filter bar shows. `created` is [from, to] inclusive A.D. days. */
export interface ReviewFilter {
  status: string; gateway?: string; hold_reason?: string; centre_id?: string; created: readonly [string, string];
}

export function reviewQuery(sp: SP, now: number): { query: URLSearchParams; filter: ReviewFilter } {
  const q = new URLSearchParams();
  const status = csv(sp['status'], (s) => (REVIEW_STATUSES as readonly string[]).includes(s));
  const statuses = status.length ? status : ['held_for_review'];
  q.set('status', statuses.join(','));
  const gateway = csv(sp['gateway'], (s) => (REVIEW_GATEWAYS as readonly string[]).includes(s));
  if (gateway.length) q.set('gateway', gateway.join(','));
  const hold = csv(sp['hold_reason'], (s) => CODE.test(s));
  if (hold.length) q.set('hold_reason', hold.join(','));
  const centre = first(sp['centre_id']);
  if (centre && UUID.test(centre)) q.set('centre_id', centre);

  const f = instant(sp['created_at_from']);
  const t = instant(sp['created_at_to']);
  let to = t ? t.ms + (t.isDay ? DAY_MS : 0) : undefined; // a chosen last day is inclusive: send the next midnight as the end
  let from = f?.ms;
  if (from === undefined && to === undefined) { to = now; from = now - DEFAULT_WINDOW_DAYS * DAY_MS; }
  else if (from === undefined) from = to! - DEFAULT_WINDOW_DAYS * DAY_MS;
  else if (to === undefined) to = Math.max(now, from + DAY_MS);
  if (to! <= from) to = from + DAY_MS;
  if (to! - from > MAX_WINDOW_DAYS * DAY_MS) from = to! - MAX_WINDOW_DAYS * DAY_MS;
  q.set('created_at_from', new Date(from).toISOString());
  q.set('created_at_to', new Date(to!).toISOString());

  q.set('sort', '-created_at');
  q.set('limit', '50');
  const cursor = first(sp['cursor']);
  if (cursor && CURSOR.test(cursor)) q.set('cursor', cursor);

  return {
    query: q,
    filter: {
      status: statuses[0]!, ...(gateway[0] ? { gateway: gateway[0] } : {}), ...(hold[0] ? { hold_reason: hold[0] } : {}),
      ...(q.has('centre_id') ? { centre_id: q.get('centre_id')! } : {}), created: [dayOf(from), dayOf(to! - 1)],
    },
  };
}
