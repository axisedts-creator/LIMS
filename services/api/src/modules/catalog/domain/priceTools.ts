// T0B-PRICETOOLS-1 (LD-321; T0C-PRICETOOLS-1 contract) domain rules of the price list tools. Pure: no database, no I/O, so the dry run writes nothing.
// Money is integer paisa end to end: rupee text is split into digits (never a float), arithmetic is BigInt, rounding is half up (contract: round half up in paisa).
// Every row rule of dryRunPriceListImport is here and ALL errors are collected with their Excel row and column (PINNED keys in __tests__/pricetools/helpers.ts).
import { clean } from '../import/validate.js';
import { isValidCode, normaliseCode } from './codes.js';

export const MAX_PRICE = 999_999_999;                     // price_list_items__price__ck
export const SHEET = { prices: 'Prices', instructions: 'Instructions' } as const;
export const HEADERS = ['Test Code', 'Test Name', 'Price (Rs)', 'Effective From'] as const;
export const COL = { code: 'test_code', price: 'price_rupees', from: 'effective_from' } as const;
const INJECTION = /^[=+\-@]/;
const MAX_CELL = 64;                                     // longer than any code / price / date: refused without reading further

export interface RowError { row_no: number; column: string; code: string; message: string }
export interface RawRow { row: number; cells: string[]; types: string[] }
export interface ValidRow { row: number; orderable_id: string; paisa: number; effective_from?: string }
export type Rounding = 'none' | 'nearest_rupee' | 'nearest_5' | 'nearest_10';

const MSG = {
  required: 'A value is required',
  notFound: 'Test code does not exist or is not active',
  duplicate: 'This test code appears more than once in the file',
  formula: 'Text cells starting with = + - or @ are rejected',
  price: 'Price must be rupees with at most 2 decimals, between 0 and 9999999.99, digits only',
  date: 'Effective from must be a date written YYYY-MM-DD',
} as const;

/** "1.5E-3" (an Excel number cell) as a plain decimal string, by moving the point: no float is involved. */
function expandExponent(s: string): string | undefined {
  const m = /^(-?)(\d+)(?:\.(\d+))?[eE]([-+]?\d{1,3})$/.exec(s);
  if (!m) return s;
  const digits = m[2]! + (m[3] ?? ''); const exp = Number(m[4]) - (m[3]?.length ?? 0);
  const out = exp >= 0 ? digits + '0'.repeat(exp) : digits.length > -exp ? `${digits.slice(0, exp)}.${digits.slice(exp)}` : `0.${'0'.repeat(-exp - digits.length)}${digits}`;
  return `${m[1]}${out}`.replace(/^(-?)0+(?=\d)/, '$1');
}

/** Rupees -> integer paisa, exactly. A text cell must already be plain digits ("12.50"); a number cell may carry Excel's exponent form. */
export function rupeesToPaisa(raw: string, type: string): number | undefined {
  let s = raw;
  if (type === 'n') { const e = expandExponent(s); if (e === undefined) return undefined; s = e.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''); }
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return undefined;
  const paisa = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return paisa <= MAX_PRICE ? paisa : undefined;
}

/** YYYY-MM-DD (a real calendar day), or an Excel date serial in a number cell (Excel turns a typed date into one). */
export function parseDay(raw: string, type: string): string | undefined {
  if (type === 'n' && /^\d{1,7}$/.test(raw)) {
    const n = Number(raw);
    if (n < 1 || n > 2958465) return undefined;
    return new Date(Date.UTC(1899, 11, 30) + n * 86_400_000).toISOString().slice(0, 10);
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return undefined;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === raw ? raw : undefined;
}

/**
 * Every row rule of the contract. `orderables` = normalised code -> id of this tenant's ACTIVE tests and panels (an inactive or another tenant's code is simply absent:
 * the message is the same "does not exist or is not active", it never says who owns a code). Rows whose cells are all blank are skipped (trailing blank rows).
 */
export function validateRows(rows: readonly RawRow[], orderables: ReadonlyMap<string, string>): { errors: RowError[]; valid: ValidRow[]; rowCount: number } {
  const errors: RowError[] = [];
  const add = (row_no: number, column: string, code: string, message: string) => { errors.push({ row_no, column, code, message }); };
  const parsed: Array<{ row: number; code?: string; paisa?: number; from?: string; ok: boolean }> = [];
  const blank = (r: RawRow) => [0, 1, 2, 3].every((i) => clean(r.cells[i] ?? '') === '');
  let end = rows.length; while (end > 0 && blank(rows[end - 1]!)) end--;   // trailing blank rows are ignored; a blank row BETWEEN data rows is a row with missing values
  for (const r of rows.slice(0, end)) {
    const cell = (i: number) => clean(r.cells[i] ?? '');
    const type = (i: number) => r.types[i] ?? 's';
    const p: { row: number; code?: string; paisa?: number; from?: string; ok: boolean } = { row: r.row, ok: true };
    const bad = (column: string, code: string, message: string) => { add(r.row, column, code, message); p.ok = false; };
    const text = (i: number) => type(i) === 's' && INJECTION.test(cell(i));
    // test code (column A); column B, the test name, is read only and ignored
    const code = cell(0);
    if (code === '') bad(COL.code, 'required_missing', MSG.required);
    else if (text(0)) bad(COL.code, 'formula_rejected', MSG.formula);
    else if (code.length <= MAX_CELL && isValidCode('orderable', code)) p.code = normaliseCode(code);
    else bad(COL.code, 'code_not_found', MSG.notFound);
    // price in rupees (column C)
    const price = cell(2);
    if (price === '') bad(COL.price, 'required_missing', MSG.required);
    else if (text(2)) bad(COL.price, 'formula_rejected', MSG.formula);
    else { const v = price.length <= MAX_CELL ? rupeesToPaisa(price, type(2)) : undefined; if (v === undefined) bad(COL.price, 'price_invalid', MSG.price); else p.paisa = v; }
    // effective from (column D), optional
    const from = cell(3);
    if (from !== '') {
      if (text(3)) bad(COL.from, 'formula_rejected', MSG.formula);
      else { const d = from.length <= MAX_CELL ? parseDay(from, type(3)) : undefined; if (d === undefined) bad(COL.from, 'date_invalid', MSG.date); else p.from = d; }
    }
    parsed.push(p);
  }
  // duplicates: every occurrence; unknown codes only once a code is unique
  const seen = new Map<string, number>();
  for (const p of parsed) if (p.code) seen.set(p.code, (seen.get(p.code) ?? 0) + 1);
  const valid: ValidRow[] = [];
  for (const p of parsed) {
    if (!p.code) continue;
    if (seen.get(p.code)! > 1) { add(p.row, COL.code, 'code_duplicate', MSG.duplicate); continue; }
    const id = orderables.get(p.code);
    if (!id) { add(p.row, COL.code, 'code_not_found', MSG.notFound); continue; }
    if (p.ok && p.paisa !== undefined) valid.push({ row: p.row, orderable_id: id, paisa: p.paisa, ...(p.from ? { effective_from: p.from } : {}) });
  }
  errors.sort((a, b) => a.row_no - b.row_no || (a.column < b.column ? -1 : a.column > b.column ? 1 : 0));
  return { errors, valid, rowCount: parsed.length };
}

// ------------------------------------------------------------------------------------------------ integer arithmetic (bulk update, copy, compare)
/** n / d rounded half up (half away from zero, symmetric for negatives), BigInt only. */
export const halfUpDiv = (n: bigint, d: bigint): bigint => (n >= 0n ? (n + d / 2n) / d : -((-n + d / 2n) / d));
const STEP: Record<Rounding, bigint> = { none: 1n, nearest_rupee: 100n, nearest_5: 500n, nearest_10: 1000n };
export const ROUNDINGS = Object.keys(STEP) as Rounding[];

export interface Change { kind: 'percent' | 'fixed_amount' | 'none'; percentBp?: number; amountPaisa?: number; rounding: Rounding }
/** The new price of one item: percent (half up to the paisa) or a signed fixed amount, then rounded to the rupee step half up. May be out of range: the caller refuses. */
export function applyChange(paisa: number, c: Change): bigint {
  const p = BigInt(paisa);
  const raw = c.kind === 'percent' ? halfUpDiv(p * (10000n + BigInt(c.percentBp ?? 0)), 10000n) : c.kind === 'fixed_amount' ? p + BigInt(c.amountPaisa ?? 0) : p;
  const step = STEP[c.rounding];
  return step === 1n ? raw : halfUpDiv(raw, step) * step;
}
export const inRange = (v: bigint): boolean => v >= 0n && v <= BigInt(MAX_PRICE);
/** difference B - A as basis points of A, half up; undefined when A is 0. */
export const percentBpOf = (a: number, b: number): number | undefined => (a === 0 ? undefined : Number(halfUpDiv(BigInt(b - a) * 10000n, BigInt(a))));
/** paisa as rupee text with 2 decimals ("12.50") for the template. */
export const paisaText = (p: number): string => `${Math.trunc(p / 100)}.${String(p % 100).padStart(2, '0')}`;
/** A template cell that starts with = + - @ is neutralised with a leading apostrophe (formula injection out of the file). */
export const safeText = (s: string): string => (/^\s*[=+\-@]/.test(s) ? `'${s}` : s);
