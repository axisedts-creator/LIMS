'use server';
// Server actions for SCR-18 / SCR-19. A thrown ApiError loses its code across the action boundary in production, so errors become
// { ok:false, status, code } (same as actions.ts). Polling reads go through here too: the bearer JWT never reaches client code (REQ-SEC-068).
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import { commitImport } from './commitImport.server';
import { createExport } from './createExport.server';
import { createImport } from './createImport.server';
import { discardImport } from './discardImport.server';
import { getExport } from './getExport.server';
import { getImport } from './getImport.server';
import { listImportIssues } from './listImportIssues.server';
import type { ActionResult, ExportRow, Import, ImportCommitBody, ImportIssue } from './types';

async function run<T>(f: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await f() };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, status: e.status, code: e.problem.code };
    throw e;
  }
}

export async function createImportAction(form: FormData, idempotencyKey: string): Promise<ActionResult<Import>> {
  return run(() => createImport(form, idempotencyKey));
}
export async function commitImportAction(id: string, version: number, body: ImportCommitBody, idempotencyKey: string): Promise<ActionResult<Import>> {
  return run(() => commitImport(id, version, body, idempotencyKey));
}
export async function discardImportAction(id: string, version: number): Promise<ActionResult<Import>> {
  return run(() => discardImport(id, version));
}
export async function createExportAction(input: { kind: string; price_list_version_id?: string }, idempotencyKey: string): Promise<ActionResult<ExportRow>> {
  return run(() => createExport(input, idempotencyKey));
}
export async function pollImportAction(id: string): Promise<ActionResult<Import>> {
  return run(() => getImport(id));
}
export async function pollExportAction(id: string): Promise<ActionResult<ExportRow>> {
  return run(() => getExport(id));
}
export async function listImportIssuesAction(id: string, severity?: 'error' | 'warning'): Promise<ActionResult<ImportIssue[]>> {
  return run(async () => (await listImportIssues(id, { limit: 200, ...(severity ? { severity } : {}) })).data);
}
