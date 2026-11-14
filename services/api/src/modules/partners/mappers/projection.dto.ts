// Shared bits of P1/S1/S2 (partners.yaml PriceListItem / StatementMonth): money, dates, limit and the opaque keyset cursor.
// Cursors are base64url JSON, strictly re-validated on decode (a hostile cursor costs no SQL); the decoded values are only ever bound parameters.
import { LimsError } from '../../../core/errors.js';

export const DEFAULT_LIMIT = 50, MAX_LIMIT = 200;
const MONTH = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

export const money = (v: unknown): { amount_paisa: number; currency: 'NPR' } => {
  const n = typeof v === 'bigint' ? Number(v) : Number(v); // node-pg returns bigint as a string
  if (!Number.isSafeInteger(n)) throw new RangeError('partners: amount is not a safe integer'); // refused, never rounded
  return { amount_paisa: n, currency: 'NPR' };
};
export const isoUtc = (v: unknown): string => new Date(v as string).toISOString();
/** 'YYYY-MM-DD' of a Date or an ISO / date string (UTC day). */
export const isoDate = (v: unknown): string => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : new Date(v as string).toISOString().slice(0, 10));

export function parseLimit(v: unknown): number {
  if (v === undefined || v === null || v === '') return DEFAULT_LIMIT;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^[0-9]{1,3}$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw new LimsError('common.validation_failed');
  return n;
}
/** 'YYYY-MM' (query or path) -> first day of that A.D. month, 'YYYY-MM-01'. */
export function monthStart(v: unknown): string {
  if (typeof v !== 'string' || !MONTH.test(v)) throw new LimsError('common.validation_failed');
  return `${v}-01`;
}

type Plain = Record<string, string>;
export const encodeCursor = (o: Plain): string => Buffer.from(JSON.stringify(o)).toString('base64url');
/** undefined = first page; anything else must decode to exactly the keys `keys` with t === `type`. */
export function decodeCursor(v: unknown, type: string, keys: readonly string[]): Plain | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const bad = () => new LimsError('common.invalid_cursor');
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(v)) throw bad();
  let o: unknown;
  try { o = JSON.parse(Buffer.from(v, 'base64url').toString('utf8')); } catch { throw bad(); }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw bad();
  const r = o as Plain;
  if (Object.keys(r).sort().join() !== ['t', ...keys].sort().join() || r['t'] !== type || Object.values(r).some((x) => typeof x !== 'string' || x.length > 300)) throw bad();
  return r;
}
