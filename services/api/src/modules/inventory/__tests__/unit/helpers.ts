// C12.T-02 shared test helpers (not a test file). Oracles in the tests come from the spec, never from the implementation.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root: this file is <root>/services/api/src/modules/inventory/__tests__/unit/. */
export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..', '..');

/** Returns the `.code` of the error thrown by fn, `'<no throw>'` when nothing is thrown, `'<no code>: …'` for a code-less error. */
export function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : `<no code>: ${String(e)}`;
  }
  return '<no throw>';
}

/** Decimal string without trailing zeros / trailing dot, so the tests do not pin the implementation's scale ('30' = '30.000000'). */
export function norm(s: string): string {
  if (!s.includes('.')) return s;
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

export interface BsGoldenMonth { bs_year: number; bs_month: number; days: number; ad_first_day: string }
/** Shared bsdate golden table (T0A-06): packages/test-fixtures/bsdate/golden-2000-2099.json, 1200 months. */
export function bsGolden(): BsGoldenMonth[] {
  const raw = readFileSync(join(REPO, 'packages', 'test-fixtures', 'bsdate', 'golden-2000-2099.json'), 'utf8');
  return (JSON.parse(raw) as { months: BsGoldenMonth[] }).months;
}

/** 'YYYY-MM-DD' minus one day (pure UTC calendar arithmetic). */
export function dayBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
