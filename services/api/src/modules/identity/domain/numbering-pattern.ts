// Numbering-pattern validator (01-PRD AC-C3.1, AC-C3.2; 03-APP-FLOW §6.1 step 2; 03-IC §9.3; 05-SCHEMA §4.6;
// 08 A13 D-23(1); barcode grammar C5 02-TRD §4.2). Pure.

export const NUMBERING_KINDS = [
  'patient_code', 'registration_no', 'barcode', 'invoice_no', 'credit_note_no', 'receipt_no', 'accession_no',
] as const;
export type NumberingKind = (typeof NUMBERING_KINDS)[number];

export type PatternResult = { ok: true } | { ok: false; code: 'common.validation_failed'; reason: string };

// [CONV] Rendered length is checked statically with each token's MINIMUM width: {yy} 2, {fy} `082/83` 6, {fyl} `2082/83` 7
// (03-IC §9.3), {prefix} 0 (numbering_prefix 0–8), {branch}/{centre} 1 (codes 1–16). The renderer re-checks the real value.
const TOKEN_MIN_WIDTH: Readonly<Record<string, number>> = { prefix: 0, branch: 1, centre: 1, yy: 2, fy: 6, fyl: 7 };
// Barcodes stay location-neutral and [A-Z0-9]: {branch}/{centre}/{fy}/{fyl} are not allowed (C5 02-TRD §4.2).
const BARCODE_TOKENS = new Set(['prefix', 'yy']);
const FISCAL = new Set<string>(['invoice_no', 'credit_note_no', 'receipt_no']);

const PIECE = /\{([a-z]+)(?::([^{}]*))?\}|([^{}]+)/gy;

export function validateNumberingPattern(kind: NumberingKind, pattern: string): PatternResult {
  const fail = (reason: string): PatternResult => ({ ok: false, code: 'common.validation_failed', reason });
  if (!(NUMBERING_KINDS as readonly string[]).includes(kind)) return fail('unknown_kind');
  if (typeof pattern !== 'string' || pattern === '') return fail('empty');
  const barcode = kind === 'barcode';
  const literal = barcode ? /^[A-Z0-9]+$/ : /^[A-Z0-9/-]+$/;
  const tokens = new Set<string>();
  let seqCount = 0;
  let length = 0;
  let pos = 0;
  PIECE.lastIndex = 0;
  for (let m = PIECE.exec(pattern); m; m = PIECE.exec(pattern)) {
    pos = PIECE.lastIndex;
    const [, name, arg, lit] = m;
    if (lit !== undefined) {
      if (!literal.test(lit)) return fail('literal_invalid');
      length += lit.length;
    } else if (name === 'seq') {
      if (arg === undefined || !/^[1-9][0-9]?$/.test(arg) || Number(arg) > 12) return fail('seq_width_invalid');
      seqCount += 1;
      length += Number(arg);
    } else {
      const width = TOKEN_MIN_WIDTH[name!];
      if (width === undefined || arg !== undefined) return fail('token_unknown');
      if (barcode && !BARCODE_TOKENS.has(name!)) return fail('token_not_allowed');
      tokens.add(name!);
      length += width;
    }
  }
  if (pos !== pattern.length) return fail('syntax');
  if (seqCount !== 1) return fail('seq_count');
  if (length > (barcode ? 20 : 30)) return fail('too_long');
  if (FISCAL.has(kind) && !tokens.has('fy') && !tokens.has('fyl')) return fail('fy_required');
  if (kind === 'registration_no' && !tokens.has('branch')) return fail('branch_required');
  return { ok: true };
}
