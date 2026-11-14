// Barcode pattern parser/renderer (02-TRD §4.2; 06 row T-05; 08 A13 D-8 / P-15; CR-C5-005). Pure: no I/O.
// Tokens: {prefix} (numbering.barcodePrefix, absent = ''), {yy} (A.D. year, tenant timezone), {seq:N} (1..12, zero padded, never truncated).
// Literals [A-Z0-9]. {branch}/{centre}/{fy}/{fyl} and anything else are rejected (location-neutral series).
// REQ-SEC-095: the error carries no pattern, prefix or counter value.
import { LimsError } from '../../../core/errors.js';

export const DEFAULT_BARCODE_PATTERN = '{prefix}{yy}{seq:8}';

const BARCODE = /^[A-Z0-9]{1,20}$/;
const PREFIX = /^[A-Z0-9]{0,4}$/;
const SEQ_TOKEN = /^seq:([1-9]|1[0-2])$/;
const LITERAL = /^[A-Z0-9]$/;

export interface BarcodeInput { readonly seq: number | bigint | string; readonly prefix?: string; readonly now: Date; readonly timeZone?: string }

const invalid = (): LimsError => new LimsError('lab.barcode_pattern_invalid');

/** The allocated counter value as a decimal string; must be a positive integer (pg bigint arrives as a string). */
function seqDigits(seq: unknown): string {
  if (typeof seq === 'number') { if (!Number.isSafeInteger(seq) || seq < 1) throw invalid(); return String(seq); }
  if (typeof seq === 'bigint') { if (seq < 1n) throw invalid(); return seq.toString(); }
  if (typeof seq === 'string' && /^[1-9][0-9]*$/.test(seq)) return seq;
  throw invalid();
}

function yy(now: Date, timeZone: string): string {
  try {
    const y = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', { timeZone, year: 'numeric' }).formatToParts(now).find((p) => p.type === 'year')?.value;
    if (!y || !/^[0-9]+$/.test(y)) throw invalid();
    return y.slice(-2).padStart(2, '0');
  } catch { throw invalid(); }   // bad timeZone / invalid Date
}

export function renderBarcode(pattern: string, input: BarcodeInput): string {
  if (typeof pattern !== 'string') throw invalid();
  const prefix = input.prefix ?? '';
  if (typeof prefix !== 'string' || !PREFIX.test(prefix)) throw invalid();
  const digits = seqDigits(input.seq);
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '{') {
      const end = pattern.indexOf('}', i);
      if (end < 0) throw invalid();
      const body = pattern.slice(i + 1, end);
      const seq = SEQ_TOKEN.exec(body);
      if (body === 'prefix') out += prefix;
      else if (body === 'yy') out += yy(input.now, input.timeZone ?? 'Asia/Kathmandu');
      else if (seq) {
        const width = Number(seq[1]);
        if (digits.length > width) throw invalid();   // overflow: never truncate
        out += digits.padStart(width, '0');
      } else throw invalid();
      i = end;
    } else if (LITERAL.test(ch)) out += ch;
    else throw invalid();
  }
  if (!BARCODE.test(out)) throw invalid();
  return out;
}
