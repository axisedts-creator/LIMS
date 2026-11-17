'use server';
// Server actions for the T0D-TESTMGMT-1 (LD-318) test management screens. Same rule as actions.ts: an ApiError becomes
// { ok:false, status, code, errors? } (its message does not survive the action boundary); anything else rethrows.
// Every input is validated again in the *.server.ts functions.
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import { createTestCategory } from './createTestCategory.server';
import { getTest } from './getTest.server';
import { listTestsPage, type TestSummary } from './listTests.server';
import { setTestTatTargets, type StageTarget, type TatTarget } from './setTestTatTargets.server';
import type { ActionResult, FieldError } from './types';
import { updateTest } from './updateTest.server';
import { updateTestCategory } from './updateTestCategory.server';

type Saved = { id: string; version: number };
async function run<T>(f: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await f() };
  } catch (e) {
    if (e instanceof ApiError) {
      const errors = e.problem['errors'];
      return { ok: false, status: e.status, code: e.problem.code, ...(Array.isArray(errors) ? { errors: errors as FieldError[] } : {}) };
    }
    throw e;
  }
}
const saved = (r: Saved): Saved => ({ id: r.id, version: r.version });

export type TestRowLite = TestSummary & { tags?: string[] };
/** One page of tests. `withTags` reads each row's detail for its tags (OrderableSummary has none: API GAP, see notes). */
export async function listTestsPageAction(q: { cursor?: string; categoryId?: string; withTags?: boolean }): Promise<ActionResult<{ rows: TestRowLite[]; next?: string }>> {
  return run(async () => {
    const r = await listTestsPage({ cursor: q.cursor, categoryId: q.categoryId });
    // ponytail: one detail read per row (≤ 50 per page) for tags; a tags field on OrderableSummary (CR) removes them
    const rows = q.withTags ? await Promise.all(r.data.map(async (t) => ({ ...t, tags: ((await getTest(t.id).catch(() => undefined))?.['tags'] as string[] | undefined) ?? [] }))) : r.data;
    return { rows, ...(r.page.next_cursor ? { next: r.page.next_cursor } : {}) };
  });
}

/** Parameters of another test (Add existing parameter to this test). */
export async function getTestParametersAction(testId: string): Promise<ActionResult<Record<string, unknown>[]>> {
  return run(async () => ((await getTest(testId))['analytes'] as Record<string, unknown>[] | undefined) ?? []);
}

export async function setTestTatTargetsAction(testId: string, version: number, input: { targets: TatTarget[]; stage_targets: StageTarget[] }): Promise<ActionResult<unknown>> {
  return run(() => setTestTatTargets(testId, version, input));
}

/** Popular test on / off: the list row has no version, so the current one is read first (same as verifyDoctorAction). */
export async function setPopularAction(testId: string, isPopular: boolean): Promise<ActionResult<Saved>> {
  return run(async () => saved(await updateTest(testId, (await getTest(testId)).version, { is_popular: isPopular })));
}

export const createTestCategoryAction = async (input: unknown, key: string) => run(async () => saved(await createTestCategory(input, key)));
export const updateTestCategoryAction = async (id: string, version: number, input: unknown) => run(async () => saved(await updateTestCategory(id, version, input)));
