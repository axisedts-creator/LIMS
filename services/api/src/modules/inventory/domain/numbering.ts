// C12 document numbering (02-TRD §4.6; IC §9.3 [CONV]: {yy} A.D. 2-digit year, {fy} B.S. FY short, {fyl} long, {seq:N}). Pure.
import { fiscalYearBs, type IsoDate } from '../../../../../../packages/shared-ts/src/bsdate/index.js';
import { LimsError } from '../../../core/errors.js';
import { isValidYmd } from './ymd.js';

export type Token = { t: 'lit'; v: string } | { t: 'yy' } | { t: 'fy' } | { t: 'fyl' } | { t: 'seq'; width: number };
export interface ParsedPattern { readonly tokens: readonly Token[]; readonly hasFy: boolean; readonly hasYy: boolean }

const bad = (why: string): never => {
  throw new LimsError('common.validation_failed', `invalid numbering input: ${why}`);
};
const LITERAL = /^[A-Z0-9\-/]+/;
const TOKEN = /^\{(yy|fyl|fy|seq:([1-9]))\}/;

export function parseNumberingPattern(pattern: unknown): ParsedPattern {
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > 64) return bad('pattern');
  const tokens: Token[] = [];
  let rest = pattern;
  while (rest.length > 0) {
    const lit = LITERAL.exec(rest);
    const tok = TOKEN.exec(rest);
    if (lit) {
      tokens.push({ t: 'lit', v: lit[0] });
      rest = rest.slice(lit[0].length);
    } else if (tok) {
      tokens.push(tok[2] ? { t: 'seq', width: Number(tok[2]) } : ({ t: tok[1] } as Token));
      rest = rest.slice(tok[0].length);
    } else bad('unsupported token or character');
  }
  if (tokens.filter((x) => x.t === 'seq').length !== 1) bad('exactly one {seq:N} required');
  return { tokens, hasFy: tokens.some((x) => x.t === 'fy' || x.t === 'fyl'), hasYy: tokens.some((x) => x.t === 'yy') };
}

function yearTwoDigits(onDate: string): string {
  return isValidYmd(onDate) ? onDate.slice(2, 4) : bad('date');
}

function fiscal(onDate: string): { short: string; long: string } {
  try {
    const f = fiscalYearBs(onDate as IsoDate);
    return { short: f.short, long: f.long };
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    throw new LimsError(code === 'common.date_out_of_range' ? code : 'common.validation_failed', 'cannot derive fiscal year');
  }
}

/** number_counters.period_key: 'fy:<fyl>' | 'yy:<yy>' | 'all'. {fy}/{fyl} win over {yy}. */
export function periodKey(pattern: string, onDate: string): string {
  const p = parseNumberingPattern(pattern);
  const yy = yearTwoDigits(onDate);
  if (p.hasFy) return `fy:${fiscal(onDate).long}`;
  return p.hasYy ? `yy:${yy}` : 'all';
}

export function formatNumber(pattern: string, onDate: string, seq: number): string {
  const p = parseNumberingPattern(pattern);
  const yy = yearTwoDigits(onDate);
  if (!Number.isSafeInteger(seq) || seq < 1) bad('sequence must be an integer ≥ 1');
  const fy = p.hasFy ? fiscal(onDate) : undefined;
  return p.tokens
    .map((t) => {
      switch (t.t) {
        case 'lit': return t.v;
        case 'yy': return yy;
        case 'fy': return fy!.short;
        case 'fyl': return fy!.long;
        case 'seq': return String(seq).padStart(t.width, '0'); // never truncated
      }
    })
    .join('');
}
