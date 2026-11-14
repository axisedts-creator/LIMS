// C11 accession-number pattern — 02-TRD §4.2. Pure. Every failure -> LimsError('anatomic.accession_pattern_invalid').
// Grammar: literals [A-Z0-9-] and tokens {prefix} {branch} {yy} {seq:N} (N 3–8, exactly one {seq:N}).
import { LimsError } from '../../../core/errors.js';
import type { CaseKind } from './case.js';

export const DEFAULT_ACCESSION_PATTERN = '{prefix}{yy}-{seq:4}';
export const DEFAULT_ACCESSION_PREFIXES: Readonly<Record<CaseKind, string>> = { histology: 'S', cytology: 'C', ihc: 'I', molecular: 'M' };
export const BATCH_ACCESSION_PATTERN = 'MB{yy}{seq:4}';

const MAX_PATTERN = 64;
const bad = (): never => { throw new LimsError('anatomic.accession_pattern_invalid'); };
const TOKEN = /^\{(prefix|branch|yy|seq:[3-8])\}/;
const PREFIX = /^[A-Z0-9]{0,4}$/;
const BRANCH = /^[A-Za-z0-9-]{1,16}$/;
const RENDERED = /^[A-Z0-9-]{1,20}$/;

export interface ParsedAccessionPattern { seqWidth: number; hasYear: boolean; hasBranch: boolean; hasPrefix: boolean }

export function parseAccessionPattern(pattern: string): ParsedAccessionPattern {
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > MAX_PATTERN) return bad();
  const p: ParsedAccessionPattern = { seqWidth: 0, hasYear: false, hasBranch: false, hasPrefix: false };
  for (let i = 0; i < pattern.length; ) {
    const c = pattern[i]!;
    if (c === '{') {
      const m = TOKEN.exec(pattern.slice(i));
      if (!m) return bad();
      const t = m[1]!;
      if (t === 'prefix') p.hasPrefix = true;
      else if (t === 'branch') p.hasBranch = true;
      else if (t === 'yy') p.hasYear = true;
      else if (p.seqWidth) return bad();
      else p.seqWidth = Number(t.slice(4));
      i += m[0].length;
    } else if (/[A-Z0-9-]/.test(c)) i++;
    else return bad();
  }
  return p.seqWidth ? p : bad();
}

export interface RenderAccessionInput { pattern: string; seq: number; year?: number; prefix?: string; branchCode?: string }

/** `seq` = counter value after increment (>= 1). */
export function renderAccessionNumber(i: RenderAccessionInput): string {
  const p = parseAccessionPattern(i.pattern);
  if (!Number.isSafeInteger(i.seq) || i.seq < 1) return bad();
  const digits = String(i.seq);
  if (digits.length > p.seqWidth) return bad(); // overflow (AC-02.3): never wraps
  if (p.hasYear && (typeof i.year !== 'number' || !Number.isInteger(i.year) || i.year < 0)) return bad();
  if (p.hasPrefix && (typeof i.prefix !== 'string' || !PREFIX.test(i.prefix))) return bad();
  if (p.hasBranch && (typeof i.branchCode !== 'string' || !BRANCH.test(i.branchCode))) return bad();
  const out = i.pattern.replace(/\{(prefix|branch|yy|seq:\d)\}/g, (_m, t: string) =>
    t === 'prefix' ? i.prefix! : t === 'branch' ? i.branchCode!.toUpperCase() : t === 'yy' ? String(i.year! % 100).padStart(2, '0') : digits.padStart(p.seqWidth, '0'));
  return RENDERED.test(out) ? out : bad();
}

/** A.D. year of `now` in an IANA zone. Throws (RangeError) on an unknown zone or invalid date — never falls back to UTC. */
export function accessionYearAd(now: Date, timeZone: string): number {
  const f = new Intl.DateTimeFormat('en-u-ca-gregory-nu-latn', { timeZone, year: 'numeric' });
  return Number(f.formatToParts(now).find((x) => x.type === 'year')!.value);
}

/** Counter scope key: year_ad when the pattern has {yy}, else 0. */
export function counterYear(pattern: string, now: Date, timeZone: string): number {
  return parseAccessionPattern(pattern).hasYear ? accessionYearAd(now, timeZone) : 0;
}
