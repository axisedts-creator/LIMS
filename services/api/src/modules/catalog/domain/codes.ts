// C3 T-02 — code normalisation (02-TRD §5.0: trimmed + upper-cased before validation; §5.1 regex per resource). AC-01.2.
import { LimsError } from '../../../core/errors.js';

export type CodeKind =
  | 'master' | 'orderable' | 'analyte' | 'valueSet' | 'valueSetValue' | 'commentCode' | 'doctor' | 'party' | 'priceList' | 'taxType';

/** 02-TRD §5.1 DTO regexes, applied to the normalised value. */
const CODE_RE: Readonly<Record<CodeKind, RegExp>> = {
  master: /^[A-Z0-9][A-Z0-9_]{0,31}$/,
  orderable: /^[A-Z0-9][A-Z0-9_\-+.]{0,31}$/,
  analyte: /^[A-Z][A-Z0-9_]{0,31}$/,
  valueSet: /^[A-Z0-9_]{1,32}$/,
  valueSetValue: /^[A-Z0-9_+\-]{1,16}$/,
  commentCode: /^[A-Z0-9_]{1,16}$/,
  doctor: /^[A-Z0-9_\-]{1,20}$/,
  party: /^[A-Z0-9_\-]{1,20}$/,
  priceList: /^[A-Z0-9][A-Z0-9_\-]{0,31}$/,
  taxType: /^[A-Z0-9_]{1,16}$/,
};

/** [CONV] hardening: raw input must be printable ASCII so Unicode case-folding ('ı'->'I', 'ß'->'SS') cannot forge a code. */
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const MAX_RAW = 64; // longest code is 32; anything far longer is rejected before regex/upper-casing work

export function normaliseCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export function isValidCode(kind: CodeKind, raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.length > MAX_RAW || !PRINTABLE_ASCII.test(raw)) return false;
  const re = Object.hasOwn(CODE_RE, kind) ? CODE_RE[kind] : undefined;
  return re !== undefined && re.test(normaliseCode(raw));
}

/** Returns the normalised code or throws 400 common.validation_failed with a field error at `path`. */
export function assertCode(kind: CodeKind, raw: unknown, path = '/code'): string {
  if (!isValidCode(kind, raw)) {
    throw new LimsError('common.validation_failed', undefined, [{ path, code: 'common.field_invalid', message: 'Field invalid' }]);
  }
  return normaliseCode(raw as string);
}
