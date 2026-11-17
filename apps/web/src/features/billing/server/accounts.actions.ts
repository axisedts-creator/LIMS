'use server';
// T0D-ACCT-1 (LD-313) server actions for the accounting screens; errors become { ok:false, code } (same shape as ./actions.ts).
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import { createAccountGroup, createAccountLedgerEntry, createAccountParticular, reverseAccountLedgerEntry, updateAccountMaster, type CreateEntryInput, type GroupNature } from './accounts.server';
import type { ActionResult } from './types';

type Job<T> = () => (Promise<T>);
async function run<T>(f: Job<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await f() };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, status: e.status, code: e.problem.code };
    throw e;
  }
}

export async function createAccountEntryAction(e: CreateEntryInput, key: string): Promise<ActionResult<{ receipt_no: string }>> {
  return run(async () => ({ receipt_no: (await createAccountLedgerEntry(e, key)).receipt_no }));
}
export async function reverseAccountEntryAction(entryId: string, reasonText: string, key: string): Promise<ActionResult<true>> {
  return run(async () => (await reverseAccountLedgerEntry(entryId, reasonText, key), true as const));
}
export async function createAccountGroupAction(g: { code: string; name: string; nature: GroupNature }, key: string): Promise<ActionResult<true>> {
  return run(async () => (await createAccountGroup(g, key), true as const));
}
export async function createAccountParticularAction(p: { account_group_id: string; code: string; name: string }, key: string): Promise<ActionResult<true>> {
  return run(async () => (await createAccountParticular(p, key), true as const));
}
export async function updateAccountMasterAction(kind: 'group' | 'particular', id: string, version: number, patch: { name?: string; is_active?: boolean }, key: string): Promise<ActionResult<true>> {
  return run(async () => (await updateAccountMaster(kind, id, version, patch, key), true as const));
}
