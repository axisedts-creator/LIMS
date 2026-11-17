import 'server-only';
// SCR-01 tile counts. The list operations have no totals (CV §4.3), so each count is the length of one page of ≤ 200 rows.
// ponytail: capped at 200 (shown "200+"); switch to a count field if the API ever adds one.
// Only areas the actor may read are fetched; the others stay 0 and their tiles are hidden.
import { serverFetch } from '@/core/api/server-fetch';
import type { CatalogCounts, CatalogHealthReport, Page } from './types';

/** Price-list-only actors cannot read the health report; SCR-01 then shows no "Needs attention" section. */
export const EMPTY_REPORT: CatalogHealthReport = { active_orderables_without_default_price: [], analytes_without_reference_range: [], tests_without_specimen_type: [], tests_missing_required_analyte: [], tax_default_configured: false, unmapped_formula_inputs: [], truncated: false };

const count = async (path: string) => (await serverFetch<Page<unknown>>(`/v1/catalog/${path}`)).data.length;

export async function getCatalogCounts(permissions: readonly string[]): Promise<CatalogCounts> {
  const can = (p: string) => permissions.includes(p);
  const tests = can('catalog.test.read');
  const doctors = can('catalog.referrer.read');
  const [departments, testsN, panels, doctorsN, unverified, priceLists] = await Promise.all([
    tests ? count('departments?is_active=all&limit=200') : 0,
    tests ? count('tests?is_active=true&limit=200') : 0,
    tests ? count('panels?is_active=true&limit=200') : 0,
    doctors ? count('doctors?is_active=true&limit=200') : 0,
    doctors ? count('doctors?is_active=true&is_verified=false&limit=200') : 0,
    can('catalog.price_list.read') ? count('price-lists?limit=200') : 0,
  ]);
  return { departments, tests: testsN, panels, doctors: doctorsN, doctors_unverified: unverified, price_lists: priceLists };
}
