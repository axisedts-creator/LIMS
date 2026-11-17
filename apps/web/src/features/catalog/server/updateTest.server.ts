import 'server-only';
// #26 updateTest (If-Match). T0D-TESTMGMT-1 (LD-318): every TestUpdate field, validated; unknown fields are dropped (no mass assignment).
import { TEST_FIELDS, WORKFLOW_TYPES } from './createTest.server';
import { bool, list, oneOf, str, updateOf, uuid } from './shared';
import type { TestDto } from './types';

const UNSET = ['short_name', 'display_name', 'barcode_text', 'description', 'template_ref', 'outsource_name', 'nabl_processing_centres', 'font', 'alert_before_expiry_minutes', 'category_id', 'report_type', 'processing_type'] as const;

export const updateTest = updateOf<TestDto>('tests', {
  name: str(1, 200), department_id: uuid, workflow_type: oneOf(...WORKFLOW_TYPES), is_active: bool, ...TEST_FIELDS, unset: list(12, oneOf(...UNSET)),
}) as (testId: string, version: number, fields: Record<string, unknown>) => Promise<TestDto>;
