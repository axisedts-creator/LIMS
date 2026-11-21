'use server';
// T0D-TESTMGMT-1 (LD-318) server actions. ApiError becomes { ok:false, status, code, errors? } (errors[] = per-field problem details the
// screens place on their fields); anything else rethrows. Input is validated again in testMgmt.server.ts.
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import {
  allTestDetails, createAnalyteFull, createCommentCodeFull, createTestCategory, createTestFull, getTestDetails, replaceSpecimens, setTatTargets,
  updateAnalyteFull, updateTestCategory, updateTestFull, updateVersionDraftFull, type TestDetail,
} from './testMgmt.server';
import type { ActionResult, FieldError } from './types';

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
type Saved = { id: string; version: number };
const saved = (r: { id?: string; version?: number }, id = ''): Saved => ({ id: r.id ?? id, version: Number(r.version ?? 0) });

export const createTestFullAction = async (input: unknown, key: string) => run(async () => saved(await createTestFull(input, key)));
export const updateTestFullAction = async (id: string, version: number, input: unknown) => run(async () => saved(await updateTestFull(id, version, input), id));
export const setTatTargetsAction = async (id: string, version: number, input: unknown) => run(async () => { await setTatTargets(id, version, input); return true; });
export const replaceSpecimensAction = async (id: string, version: number, input: unknown) => run(async () => saved(await replaceSpecimens(id, version, input), id));
export const createAnalyteFullAction = async (testId: string, input: unknown, key: string) => run(async () => { const r = await createAnalyteFull(testId, input, key); return { id: r.id, code: r.code }; });
export const updateAnalyteFullAction = async (id: string, version: number, input: unknown) => run(async () => saved(await updateAnalyteFull(id, version, input), id));
export const updateVersionDraftFullAction = async (id: string, version: number, input: unknown) => run(async () => saved(await updateVersionDraftFull(id, version, input), id));
export const createTestCategoryAction = async (input: unknown, key: string) => run(async () => saved(await createTestCategory(input, key)));
export const updateTestCategoryAction = async (id: string, version: number, input: unknown) => run(async () => saved(await updateTestCategory(id, version, input), id));
export const createCommentCodeFullAction = async (input: unknown, key: string) => run(async () => saved(await createCommentCodeFull(input, key)));

/** Search tags of the given tests (OrderableSummary has no tags). */
export const testTagsAction = async (ids: string[]) =>
  run(async () => Object.fromEntries((await getTestDetails(ids)).map((t) => [t.id, Array.isArray(t['tags']) ? (t['tags'] as unknown[]).map(String) : []])));

export interface OtherAnalyte { id: string; test_id: string; test_name: string; code: string; name: string; print_name?: string; report_subheading?: string; version: Record<string, unknown> }
/** Parameters of every other test, for "Add existing parameter to this test". */
export const otherAnalytesAction = async (testId: string) =>
  run(async () => {
    const out: OtherAnalyte[] = [];
    for (const t of (await allTestDetails()) as TestDetail[]) {
      if (t.id === testId) continue;
      for (const a of (t['analytes'] ?? []) as Record<string, any>[]) {
        if (a['is_active'] === false) continue;
        out.push({ id: a['id'], test_id: t.id, test_name: t.name, code: a['code'], name: a['name'], print_name: a['print_name'], report_subheading: a['report_subheading'], version: a['current_version'] ?? {} });
      }
    }
    return out;
  });
