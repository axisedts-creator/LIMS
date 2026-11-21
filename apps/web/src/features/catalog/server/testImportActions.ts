'use server';
// T0D-TESTIMPORT-1 (LD-318): server actions of the Excel test-import screen. The bearer JWT stays on the server (REQ-SEC-068). Failures keep the problem
// `detail` so the screen can show the server's own text (done_when 5: error text comes from the server). [CONV] downloads return base64 (no new route, rs-c2).
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import { commitTestImport, downloadTestImportErrors, downloadTestImportTemplate, validateTestImport, type TestImportCommitResult, type TestImportValidation } from './testImport.server';

export type TestImportResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string; detail?: string };

async function run<T>(f: () => Promise<T>): Promise<TestImportResult<T>> {
  try {
    return { ok: true, data: await f() };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, status: e.status, code: e.problem.code, ...(typeof e.problem.detail === 'string' ? { detail: e.problem.detail } : {}) };
    throw e;
  }
}
async function bytes(f: () => Promise<{ ok: true; base64: string } | { ok: false; status: number }>): Promise<TestImportResult<string>> {
  const r = await f();
  return r.ok ? { ok: true, data: r.base64 } : { ok: false, status: r.status, code: 'common.internal' };
}

export async function validateTestImportAction(form: FormData, idempotencyKey: string): Promise<TestImportResult<TestImportValidation>> {
  return run(() => validateTestImport(form, idempotencyKey));
}
export async function commitTestImportAction(id: string, version: number, idempotencyKey: string): Promise<TestImportResult<TestImportCommitResult>> {
  return run(() => commitTestImport(id, version, idempotencyKey));
}
export async function testImportTemplateAction(): Promise<TestImportResult<string>> {
  return bytes(downloadTestImportTemplate);
}
export async function testImportErrorsAction(id: string): Promise<TestImportResult<string>> {
  try {
    return await bytes(() => downloadTestImportErrors(id));
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, status: e.status, code: e.problem.code }; // malformed id
    throw e;
  }
}
