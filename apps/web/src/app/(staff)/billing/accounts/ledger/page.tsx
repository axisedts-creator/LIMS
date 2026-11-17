// T0D-ACCT-1 (LD-313; route staff.billing.account_ledger): party ledger statement for a date range (getAccountStatement).
import { getShellSession } from '@/core/session/server';
import { AccountLedgerScreen } from '@/features/billing/components/accounts/AccountLedgerScreen';
import { dateRange, getAccountStatement, listAccountParticulars, listAccountParties, PARTY_KINDS, type PartyKind } from '@/features/billing/server/accounts.server';
import { UUID_RE } from '@/features/billing/server/types';

export default async function AccountLedgerPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const { from, to } = dateRange(sp);
  const kind = PARTY_KINDS.find((k) => k === sp['party_kind'] && k !== 'user_pocket') as PartyKind | undefined;
  const partyId = typeof sp['party_id'] === 'string' && UUID_RE.test(sp['party_id']) ? sp['party_id'] : undefined;
  const [{ parties }, particulars, statement] = await Promise.all([
    listAccountParties(),
    listAccountParticulars(),
    kind && partyId ? getAccountStatement({ party_kind: kind, party_id: partyId, from, to }) : Promise.resolve(null),
  ]);
  const party = parties.find((p) => p.id === partyId && p.kind === kind) ?? (kind && partyId ? { id: partyId, kind, name: '—' } : null);
  return <AccountLedgerScreen statement={statement} party={party} parties={parties} from={from} to={to} particulars={particulars} permissions={session?.actor.permissions ?? []} />;
}
