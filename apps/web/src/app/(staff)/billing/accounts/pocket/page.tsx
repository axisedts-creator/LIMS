// T0D-ACCT-1 (LD-313; route staff.billing.pocket_ledger): the signed in user's pocket ledger; another owner only with billing.account.manage
// (the statement of another owner is never fetched without it). The pocket statement may answer 404 until T0B-ACCT-2: shown as not available.
import { getShellSession } from '@/core/session/server';
import { PocketLedgerScreen } from '@/features/billing/components/accounts/PocketLedgerScreen';
import { dateRange, getAccountStatement, listAccountParticulars, listMembers } from '@/features/billing/server/accounts.server';
import { UUID_RE } from '@/features/billing/server/types';

export default async function PocketLedgerPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const permissions = session?.actor.permissions ?? [];
  const me = session?.actor.membershipId ?? '';
  const canSeeOthers = permissions.includes('billing.account.manage');
  const asked = typeof sp['owner_id'] === 'string' && UUID_RE.test(sp['owner_id']) ? sp['owner_id'] : me;
  const { from, to } = dateRange(sp);
  const allowed = UUID_RE.test(asked) && (asked === me || canSeeOthers);
  const [owners, particulars, statement] = await Promise.all([
    canSeeOthers ? listMembers() : Promise.resolve([]),
    listAccountParticulars(),
    allowed ? getAccountStatement({ party_kind: 'user_pocket', party_id: asked, from, to }).catch(() => null) : Promise.resolve(null),
  ]);
  return <PocketLedgerScreen statement={statement} ownerId={asked} currentMembershipId={me} owners={owners} from={from} to={to} particulars={particulars} permissions={permissions} />;
}
