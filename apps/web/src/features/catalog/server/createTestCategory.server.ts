import 'server-only';
// POST /v1/catalog/test-categories (TestCategoryCreate, Idempotency-Key). T0D-TESTMGMT-1 (LD-318).
import type { TestCategory } from './listTestCategories.server';
import { bool, createOf, int, str, uuid } from './shared';

export const CATEGORY_FIELDS = { name: str(1, 200), display_order: int(0, 9999), print_footer: bool, footer_text: str(1, 2000), is_active: bool };
export const createTestCategory = createOf<TestCategory>('test-categories', { department_id: uuid, ...CATEGORY_FIELDS }, ['department_id', 'name']);
