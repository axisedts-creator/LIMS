import 'server-only';
// #24 createTest (POST /v1/catalog/tests, TestCreate, Idempotency-Key). T0D-CATTESTS-1 (LD-310); T0D-TESTMGMT-1 (LD-318) forwards every
// TestCreate field of contracts/openapi/catalog.yaml. Only TestCreate fields are forwarded, each validated before any request.
import { bool, createOf, int, list, oneOf, pick, str, upperCode, uuid, bad, type V } from './shared';
import type { TestDto } from './types';

export const WORKFLOW_TYPES = ['standard', 'narrative', 'microbiology', 'anatomic', 'molecular', 'attachment', 'outsourced'] as const;
export const REPORT_TYPES = ['four_column', 'three_column', 'two_column', 'graph', 'template_based_html', 'micro_automated', 'cbc_four_column', 'micro_manual', 'histo', 'four_column_10_font'] as const;
export const PROCESSING_TYPES = ['local', 'branch_transfer', 'outsource_branch'] as const; // LD-318 follow-up (3)
const specimenRequirement = (v: unknown) => pick(v, { specimen_type_id: uuid, is_preferred: bool }, ['specimen_type_id']);
/** uniqueItems string arrays (tags, NABL centres). */
const uniqueStrs = (max: number, itemMax: number): V => (v) => {
  const r = list(max, str(1, itemMax))(v) as string[];
  if (new Set(r).size !== r.length) throw bad();
  return r;
};

/** Optional TestCreate / TestUpdate fields (LD-318 parity, additive). */
export const TEST_FIELDS: Record<string, V> = {
  report_order: int(0, 9999), is_orderable: bool, uses_existing_material: bool,
  short_name: str(1, 60), display_name: str(3, 300), tags: uniqueStrs(20, 60), barcode_text: str(1, 64), loyalty_points: int(0, 1_000_000),
  display_order: int(0, 9999), description: str(1, 2000), report_type: oneOf(...REPORT_TYPES), processing_type: oneOf(...PROCESSING_TYPES),
  template_ref: str(1, 120), outsource_name: str(1, 200), is_outsourced: bool, is_popular: bool, smart_report: bool, print_category_wise: bool,
  nabl: bool, accab_logo: bool, auto_approval_enabled: bool, use_normal_range_for_auto_approval: bool, template_test: bool,
  nabl_processing_centres: uniqueStrs(20, 200), font: str(1, 60), alert_before_expiry_minutes: int(0, 525_600), category_id: uuid,
};

export const createTest = createOf<TestDto>(
  'tests',
  { code: upperCode(), name: str(1, 200), department_id: uuid, workflow_type: oneOf(...WORKFLOW_TYPES), specimen_requirements: list(10, specimenRequirement), ...TEST_FIELDS },
  ['code', 'name', 'department_id', 'workflow_type', 'specimen_requirements'],
);
