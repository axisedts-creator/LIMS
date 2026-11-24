// Shared catalog containing all tests from Metro Labs master spreadsheet
import testsData from './mhn_tests_catalog.json' with { type: 'json' };

export interface SharedTestItem {
  id: string;
  orderable_id: string;
  bookable_id: string;
  code: string;
  name: string;
  kind: 'test' | 'panel';
  mrp: number;
  price: number;
  department_code?: string;
  department: string;
  method: string;
  sample_type: string;
  container: string;
  parameters: string;
  tat: string;
  reporting_time: string;
  category: string;
  app_category: string;
  fasting: string;
  age: string;
  desc: string;
  centre_visit: boolean;
  sort_order: number;
}

export const SHARED_TESTS: readonly SharedTestItem[] = testsData as SharedTestItem[];

export const SHARED_TESTS_BY_CODE = new Map<string, SharedTestItem>(
  SHARED_TESTS.map((t) => [t.code.toUpperCase(), t])
);

export const SHARED_TESTS_BY_ORDERABLE_ID = new Map<string, SharedTestItem>(
  SHARED_TESTS.map((t) => [t.orderable_id, t])
);

export function getSharedTestByCodeOrName(codeOrName?: string, fallbackName?: string): SharedTestItem | undefined {
  if (codeOrName) {
    const upper = codeOrName.trim().toUpperCase();
    const byCode = SHARED_TESTS_BY_CODE.get(upper);
    if (byCode) return byCode;
    const byName = SHARED_TESTS.find((t) => t.name.toUpperCase() === upper);
    if (byName) return byName;
  }
  if (fallbackName) {
    const upperFallback = fallbackName.trim().toUpperCase();
    const byFallbackCode = SHARED_TESTS_BY_CODE.get(upperFallback);
    if (byFallbackCode) return byFallbackCode;
    return SHARED_TESTS.find((t) => t.name.toUpperCase() === upperFallback);
  }
  return undefined;
}
