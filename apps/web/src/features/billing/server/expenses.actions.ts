'use server';
// T0D-ACCT-2 (LD-313) server actions for Expense, Expense Type, Cash Transfer and the pocket balance shown before a transfer is confirmed.
// Errors become { ok:false, code } (same shape as ./accounts.actions.ts).
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import {
  cancelExpense, createCashTransfer, createExpense, createExpenseType, decideCashTransfer, getPocketBalance, updateExpenseType,
  type CreateExpenseInput, type CreateTransferInput, type PocketBalance,
} from './expenses.server';
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
const done = async (p: Promise<unknown>) => (await p, true as const);

export async function createExpenseAction(e: CreateExpenseInput, key: string): Promise<ActionResult<true>> {
  return run(() => done(createExpense(e, key)));
}
export async function cancelExpenseAction(expenseId: string, reasonText: string, key: string): Promise<ActionResult<true>> {
  return run(() => done(cancelExpense(expenseId, reasonText, key)));
}
export async function saveExpenseTypeAction(
  row: { id: string; version: number } | null, x: { name?: string; account_particular_id?: string; is_active?: boolean }, key: string,
): Promise<ActionResult<true>> {
  return run(() => done(row ? updateExpenseType(row.id, row.version, x, key) : createExpenseType({ name: x.name ?? '', account_particular_id: x.account_particular_id ?? '' }, key)));
}
export async function createCashTransferAction(x: CreateTransferInput, key: string): Promise<ActionResult<true>> {
  return run(() => done(createCashTransfer(x, key)));
}
export async function decideCashTransferAction(transferId: string, action: 'accept' | 'reject' | 'cancel', key: string): Promise<ActionResult<true>> {
  return run(() => done(decideCashTransfer(transferId, action, key)));
}
export async function getPocketBalanceAction(partyId: string): Promise<ActionResult<PocketBalance>> {
  return run(() => getPocketBalance(partyId));
}
