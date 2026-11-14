// C12 FEFO suggestion — 02-TRD §4.4 (AC-18.1). Pure ordering + cover over candidates the SQL already filtered (qty > 0, available, not expired).
import { LimsError } from '../../../core/errors.js';
import { formatScaled, parseBaseQty, scaled } from './quantity.js';

export interface FefoCandidate {
  lotId: string; lotNo: string; expiryOn: string | null; createdAt: string; availableQtyBase: string;
  openContainers: readonly { openExpiryAt: string | null }[];
}
export interface FefoLine {
  lotId: string; lotNo: string; expiryOn: string | null; effectiveExpiryAt: string | null; hasOpenContainer: boolean;
  takeQtyBase: string; availableQtyBase: string;
}
export interface FefoResult { lines: FefoLine[]; shortfallQtyBase: string }

const fail = (msg: string): never => {
  throw new LimsError('common.validation_failed', msg);
};
const ms = (s: string): number => (Number.isNaN(Date.parse(s)) ? fail('invalid timestamp') : Date.parse(s));

/** Offset (local − UTC, ms) of `tz` at UTC instant t. */
export function offsetMs(t: number, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)]),
  ) as Record<string, number>;
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(t / 1000) * 1000;
}

/** Last millisecond of calendar day `ymd` in `tz`, as a UTC epoch (start of the next local day − 1 ms). */
export function endOfDay(ymd: string, tz: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return fail('invalid expiry date');
  const wall = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]! + 1);
  let t = wall - offsetMs(wall, tz);
  t = wall - offsetMs(t, tz); // second pass settles DST edges
  return t - 1;
}

const nullsLast = (a: number | string | null, b: number | string | null): number =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1;

export function suggestFefo(i: { candidates: readonly FefoCandidate[]; qtyBase: string; now: string; timezone: string }): FefoResult {
  const want = scaled(parseBaseQty(i.qtyBase), 6);
  const now = ms(i.now);
  const rows = i.candidates.map((c) => {
    const open = c.openContainers.filter((o) => o.openExpiryAt === null || ms(o.openExpiryAt) > now);
    const candidatesAt = open.flatMap((o) => (o.openExpiryAt === null ? [] : [ms(o.openExpiryAt)]));
    if (c.expiryOn !== null) candidatesAt.push(endOfDay(c.expiryOn, i.timezone));
    return { c, hasOpen: open.length > 0, eff: candidatesAt.length > 0 ? Math.min(...candidatesAt) : null, created: ms(c.createdAt) };
  });
  rows.sort(
    (a, b) =>
      Number(b.hasOpen) - Number(a.hasOpen) || nullsLast(a.eff, b.eff) || nullsLast(a.c.expiryOn, b.c.expiryOn) ||
      a.created - b.created || (a.c.lotId < b.c.lotId ? -1 : a.c.lotId > b.c.lotId ? 1 : 0),
  );
  const lines: FefoLine[] = [];
  let left = want;
  for (const r of rows) {
    if (left <= 0n) break;
    const avail = scaled(r.c.availableQtyBase, 6);
    if (avail <= 0n) continue;
    const take = avail < left ? avail : left;
    left -= take;
    lines.push({
      lotId: r.c.lotId, lotNo: r.c.lotNo, expiryOn: r.c.expiryOn,
      effectiveExpiryAt: r.eff === null ? null : new Date(r.eff).toISOString(),
      hasOpenContainer: r.hasOpen, takeQtyBase: formatScaled(take, 6), availableQtyBase: formatScaled(avail, 6),
    });
  }
  return { lines, shortfallQtyBase: formatScaled(left, 6) };
}
