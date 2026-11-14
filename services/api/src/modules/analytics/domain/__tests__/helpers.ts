// AN-T02 test helpers (not a test file). Golden B.S. table = packages/test-fixtures/bsdate/golden-2000-2099.json (US-02.7):
// every B.S. boundary asserted in these tests is read from it, never hard-coded.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isLimsError } from '../../../../core/errors.js';

export interface GoldenMonth { readonly bs_year: number; readonly bs_month: number; readonly days: number; readonly ad_first_day: string }

const GOLDEN_URL = new URL('../../../../../../../packages/test-fixtures/bsdate/golden-2000-2099.json', import.meta.url);
export const GOLDEN: readonly GoldenMonth[] = JSON.parse(readFileSync(fileURLToPath(GOLDEN_URL), 'utf8')).months;

export const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
export const bsKey = (y: number, m: number): string => `${y}-${pad(m)}`;
const byKey = new Map(GOLDEN.map((g) => [bsKey(g.bs_year, g.bs_month), g] as const));
export const golden = (y: number, m: number): GoldenMonth => {
  const g = byKey.get(bsKey(y, m));
  if (!g) throw new Error(`golden table has no ${bsKey(y, m)}`);
  return g;
};

export const addDays = (iso: string, n: number): string => {
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
export const diffDays = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** Returns whatever fn throws; fails the test if it does not throw. */
export function thrown(fn: () => unknown): unknown {
  try { fn(); } catch (e) { return e; }
  throw new Error('expected the call to throw, it returned');
}

/** Asserts a LimsError with the registered code and the HTTP status taken from contracts/errors.yaml. */
export function expectLims(fn: () => unknown, code: string, status: number): { errors?: readonly { path: string }[] } {
  const e = thrown(fn);
  if (!isLimsError(e, code)) throw new Error(`expected LimsError ${code}, got ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  if (e.statusCode !== status) throw new Error(`expected HTTP ${status} for ${code}, got ${e.statusCode}`);
  return e;
}
