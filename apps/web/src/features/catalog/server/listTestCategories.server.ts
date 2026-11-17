import 'server-only';
// GET /v1/catalog/test-categories (TestCategoryPage). T0D-TESTMGMT-1 (LD-318).
import { listOf } from './shared';

export interface TestCategory { id: string; department_id: string; name: string; display_order: number; print_footer: boolean; footer_text?: string; is_active: boolean; version: number }
export const listTestCategories = listOf<TestCategory>('test-categories');
