// T0D-ACCT-2 (LD-313; route staff.billing.cash_transfers): Cash Transfer tabs (?tab=all|sent|received|pending) + New transfer, accept, reject, cancel.
// [CONV] currentCentreIds = the lab centres the session can list (identity centres are scoped to the user); the API decides who may accept.
import { getShellSession } from '@/core/session/server';
import { CashTransfersScreen } from '@/features/billing/components/transfers/CashTransfersScreen';
import { listAccountParties, listMembers } from '@/features/billing/server/accounts.server';
import { listCashTransfers, TRANSFER_TABS, type TransferTab } from '@/features/billing/server/expenses.server';
import { UUID_RE } from '@/features/billing/server/types';

export default async function CashTransfersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const tab = (TRANSFER_TABS as readonly string[]).includes(sp['tab'] as string) ? (sp['tab'] as TransferTab) : 'all';
  const id = (k: string) => (typeof sp[k] === 'string' && UUID_RE.test(sp[k] as string) ? { [k]: sp[k] as string } : {});
  const filters = { ...id('from_id'), ...id('to_id') };
  const me = session?.actor.membershipId ?? '';
  const [transfers, members, { centres }] = await Promise.all([listCashTransfers(tab, me, filters), listMembers(), listAccountParties()]);
  return (
    <CashTransfersScreen
      transfers={transfers}
      centres={centres}
      members={members}
      currentMembershipId={me}
      currentCentreIds={centres.map((c) => c.id)}
      tab={tab}
      permissions={session?.actor.permissions ?? []}
      filters={filters}
    />
  );
}
