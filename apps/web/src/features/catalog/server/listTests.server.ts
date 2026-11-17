import 'server-only';
// #23 listTests (cursor paging) + #25 for the specimen filter. T0D-CATTESTS-1 (LD-310): the API takes only department_id,
// workflow_type, is_active, sort, cursor, limit (unknown key = 422) and OrderableSummary has no specimen, so the Tests page loads the
// filtered list here and searches / filters by specimen in the BFF. Only validated values are ever sent.
import { serverFetch } from '@/core/api/server-fetch';
import { getTest } from './getTest.server';
import { UUID_RE } from './types';

export interface TestSummary {
  id: string; code: string; name: string; department_id?: string; department_code?: string; workflow_type?: string; is_orderable?: boolean; is_active: boolean;
  // T0D-TESTMGMT-1 (LD-318) parity fields when the API sends them (OrderableSummary); is_popular is an API GAP (see notes).
  short_name?: string; display_name?: string; category_id?: string; category_name?: string; is_popular?: boolean; default_price_paisa?: number;
}

/** One API page (Test Details left pane, Complete test list): limit ≤ 50, optional category filter. */
export async function listTestsPage(q: { cursor?: string | undefined; categoryId?: string | undefined; limit?: number } = {}): Promise<{ data: TestSummary[]; page: { next_cursor?: string } }> {
  const p = new URLSearchParams({ limit: String(Math.min(Math.max(Math.trunc(q.limit ?? 50), 1), 50)), sort: 'code', is_active: 'all' });
  if (q.categoryId && UUID_RE.test(q.categoryId)) p.set('category_id', q.categoryId.toLowerCase());
  if (q.cursor && CURSOR_RE.test(q.cursor)) p.set('cursor', q.cursor);
  return serverFetch(`/v1/catalog/tests?${p}`);
}
export interface TestsQuery { departmentId?: string | undefined; isActive?: 'true' | 'false' | 'all'; cursor?: string | undefined }
const CURSOR_RE = /^[A-Za-z0-9_\-=.]{1,512}$/;
const MAX_PAGES = 10; // ponytail: 2000 tests max on the list page; server-side q/specimen paging (CR) when a catalog outgrows it

export async function listTests(q: TestsQuery = {}): Promise<{ data: TestSummary[]; page: { next_cursor?: string } }> {
  const p = new URLSearchParams({ limit: '200', sort: 'code', is_active: q.isActive ?? 'all' });
  if (q.departmentId && UUID_RE.test(q.departmentId)) p.set('department_id', q.departmentId.toLowerCase());
  if (q.cursor && CURSOR_RE.test(q.cursor)) p.set('cursor', q.cursor);
  return serverFetch(`/v1/catalog/tests?${p}`);
}

/** Every page of the filtered list (bounded by MAX_PAGES). */
export async function listAllTests(q: Omit<TestsQuery, 'cursor'> = {}): Promise<TestSummary[]> {
  const out: TestSummary[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const r = await listTests({ ...q, cursor });
    out.push(...r.data);
    cursor = r.page.next_cursor;
    if (!cursor) break;
  }
  return out;
}

/** Tests among `tests` that collect the specimen type (one detail read per test, 20 at a time). */
export async function testsWithSpecimen<T extends { id: string }>(tests: readonly T[], specimenTypeId: string): Promise<T[]> {
  // ponytail: N+1 detail reads; a specimen_type_id list filter in the API (CR) removes them
  const keep: T[] = [];
  for (let i = 0; i < tests.length; i += 20) {
    const batch = tests.slice(i, i + 20);
    const details = await Promise.all(batch.map((t) => getTest(t.id)));
    batch.forEach((t, j) => {
      const reqs = (details[j]!['specimen_requirements'] ?? []) as { specimen_type_id?: string }[];
      if (reqs.some((r) => r.specimen_type_id === specimenTypeId)) keep.push(t);
    });
  }
  return keep;
}
