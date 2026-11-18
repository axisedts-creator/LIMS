// T0D-ACCT-2 (LD-313; route staff.billing.expenses): Expense list + New expense form. Filters come from the URL (centre_id, expense_type_id, from, to).
import { getShellSession } from '@/core/session/server';
import { ExpensesScreen } from '@/features/billing/components/expenses/ExpensesScreen';
import { listAccountParties } from '@/features/billing/server/accounts.server';
import { expenseFilters, listExpenses, listExpenseTypes } from '@/features/billing/server/expenses.server';

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const f = expenseFilters(sp);
  const [expenses, types, { centres }] = await Promise.all([listExpenses(f), listExpenseTypes(), listAccountParties()]);
  return <ExpensesScreen expenses={expenses} types={types} centres={centres} permissions={session?.actor.permissions ?? []} filters={f} />;
}
