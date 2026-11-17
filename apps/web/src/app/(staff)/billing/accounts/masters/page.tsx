// T0D-ACCT-1 (LD-313; route staff.billing.account_masters): account groups and particulars masters.
import { getShellSession } from '@/core/session/server';
import { AccountMastersScreen } from '@/features/billing/components/accounts/AccountMastersScreen';
import { listAccountGroups, listAccountParticulars } from '@/features/billing/server/accounts.server';

export default async function AccountMastersPage() {
  const [session, groups, particulars] = await Promise.all([getShellSession(), listAccountGroups(), listAccountParticulars()]);
  return <AccountMastersScreen groups={groups} particulars={particulars} permissions={session?.actor.permissions ?? []} />;
}
