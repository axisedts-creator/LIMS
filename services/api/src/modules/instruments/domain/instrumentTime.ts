// Local instrument time + IANA zone -> UTC IsoUtc; agent and instrument clock offsets (02-TRD §5.9, §6.4 step 10). Pure.

const LOCAL = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,3}))?$/;
const ZONE = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/;
const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = fmtCache.get(timeZone);
  if (!f) {
    if (!ZONE.test(timeZone)) throw new RangeError('unknown time zone');
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }); // throws RangeError on an unknown zone
    fmtCache.set(timeZone, f);
  }
  return f;
}

/** Wall-clock fields of `ms` in `timeZone`. Shared with the health evaluator (active hours). */
export function zonedParts(ms: number, timeZone: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const p: Record<string, number> = {};
  for (const x of formatter(timeZone).formatToParts(ms)) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return { y: p.year!, mo: p.month!, d: p.day!, h: p.hour!, mi: p.minute!, s: p.second! };
}

function offsetMs(ms: number, timeZone: string): number {
  const z = zonedParts(ms, timeZone);
  return Date.UTC(z.y, z.mo - 1, z.d, z.h, z.mi, z.s) - (ms - (((ms % 1000) + 1000) % 1000));
}

/** 'YYYY-MM-DDTHH:mm:ss[.sss]' (no offset) in `timeZone` -> IsoUtc. Throws on malformed input or an unknown zone. */
export function localToUtc(local: string, timeZone: string): string {
  const m = LOCAL.exec(local);
  if (!m) throw new RangeError('malformed local time');
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const msPart = Number((m[7] ?? '').padEnd(3, '0'));
  const wall = Date.UTC(y, mo - 1, d, h, mi, s, msPart);
  const check = new Date(wall);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || check.getUTCHours() !== h
    || check.getUTCMinutes() !== mi || check.getUTCSeconds() !== s) throw new RangeError('malformed local time');
  // ponytail: two-pass offset lookup; DST gap/overlap resolves to whichever side the second pass lands on (spec silent).
  let utc = wall - offsetMs(wall, timeZone);
  utc = wall - offsetMs(utc, timeZone);
  return new Date(utc).toISOString();
}

/** captured_at = captured_at_agent + clock_offset_ms (§5.9). */
export function capturedAt(capturedAtAgent: string, clockOffsetMs: number): string {
  if (!Number.isSafeInteger(clockOffsetMs)) throw new RangeError('clock_offset_ms must be an integer');
  const t = Date.parse(capturedAtAgent);
  if (Number.isNaN(t)) throw new RangeError('captured_at_agent invalid');
  return new Date(t + clockOffsetMs).toISOString();
}

/** instrument_clock_offset_seconds = round((instrument_time_utc − captured_at) / 1 s) (§5.9). */
export function instrumentClockOffsetSeconds(instrumentTimeUtc: string, capturedAtIso: string): number {
  const a = Date.parse(instrumentTimeUtc);
  const b = Date.parse(capturedAtIso);
  if (Number.isNaN(a) || Number.isNaN(b)) throw new RangeError('invalid timestamp');
  return Math.round((a - b) / 1000);
}
