// C12 tenant-time helpers (02-TRD §4.7: "today", expiry day and open stability are all computed in the tenant timezone). Pure; the clock is passed in.
import { LimsError } from '../../../core/errors.js';
import { endOfDay, offsetMs } from './fefo.js';

export { endOfDay };

/** Throws common.internal for a zone Intl does not know (fail closed: a wrong business date corrupts expiry decisions). */
export function assertZone(tz: unknown): string {
  try {
    if (typeof tz === 'string' && tz !== '') { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; }
  } catch { /* falls through */ }
  throw new LimsError('common.internal', 'tenant timezone is not available');
}

/** `ctx.now()` is an ISO string (Date tolerated, CR T0D-18) -> epoch ms. */
export function nowMs(v: unknown): number {
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  if (Number.isNaN(t)) throw new LimsError('common.internal', 'invalid clock');
  return t;
}

/** Local calendar parts of instant `t` in `tz`. */
function parts(t: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)])) as Record<string, number>;
  return { y: p['year']!, mo: p['month']!, d: p['day']!, h: p['hour']!, mi: p['minute']!, s: p['second']! };
}

/** 'YYYY-MM-DD' of instant `t` in `tz`. */
export function ymdIn(t: number, tz: string): string {
  const p = parts(t, tz);
  return `${String(p.y).padStart(4, '0')}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** 'YYYY-MM-DD' + n calendar days. */
export const addDaysYmd = (ymd: string, n: number): string => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Instant `t` + `n` WALL-CLOCK days in `tz` (same local time of day; a DST change moves the UTC offset, not the clock face). */
export function addWallDays(t: number, n: number, tz: string): number {
  const p = parts(t, tz);
  const wall = Date.UTC(p.y, p.mo - 1, p.d + n, p.h, p.mi, p.s);
  let u = wall - offsetMs(wall, tz);
  u = wall - offsetMs(u, tz); // second pass settles a DST edge
  return u + (((t % 1000) + 1000) % 1000);
}
