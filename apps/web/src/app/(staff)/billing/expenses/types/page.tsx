// T0D-ACCT-2 (LD-313; route staff.billing.expense_types): Expense Type master (create, update, deactivate).
import { getShellSession } from '@/core/session/server';
import { ExpenseTypesScreen } from '@/features/billing/components/expenses/ExpenseTypesScreen';
import { listAccountParticulars } from '@/features/billing/server/accounts.server';
import { listExpenseTypes } from '@/features/billing/server/expenses.server';

export default async function ExpenseTypesPage() {
  const [session, types, particulars] = await Promise.all([getShellSession(), listExpenseTypes(), listAccountParticulars()]);
  return <ExpenseTypesScreen types={types} particulars={particulars} permissions={session?.actor.permissions ?? []} />;
}
