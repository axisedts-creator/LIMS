import 'server-only';
// PATCH /v1/catalog/test-categories/{id} (TestCategoryUpdate, If-Match). No delete exists: is_active false deactivates. T0D-TESTMGMT-1 (LD-318).
import { CATEGORY_FIELDS } from './createTestCategory.server';
import type { TestCategory } from './listTestCategories.server';
import { list, oneOf, updateOf } from './shared';

export const updateTestCategory = updateOf<TestCategory>('test-categories', { ...CATEGORY_FIELDS, unset: list(1, oneOf('footer_text')) });
