// T0D-ACCT-1 (LD-313; route staff.billing.account_summary): Account Summary of every client and franchise (getAccountSummary per party).
import { getShellSession } from '@/core/session/server';
import { AccountSummaryScreen } from '@/features/billing/components/accounts/AccountSummaryScreen';
import { listAccountParties, listAccountSummaries } from '@/features/billing/server/accounts.server';

export default async function AccountSummaryPage() {
  const [session, { parties }] = await Promise.all([getShellSession(), listAccountParties()]);
  const summaries = await listAccountSummaries(parties);
  return <AccountSummaryScreen summaries={summaries} parties={parties} permissions={session?.actor.permissions ?? []} />;
}
