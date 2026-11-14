// 04-UI-UX §7 (route /frontdesk/discount-approvals). Non-approvers never reach the list endpoint; the API's 403 auth.mfa_required is a page state (MFA banner).
import { ApiError } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import { DiscountApprovalsInbox } from '@/features/frontdesk/components/DiscountApprovalsInbox';
import { listCentres, listDiscountApprovals } from '@/features/frontdesk/server/read.server';
import type { DiscountApproval } from '@/features/frontdesk/server/types';

export const metadata = { title: 'Discount approvals' };

export default async function DiscountApprovalsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session] = await Promise.all([getShellSession(), searchParams]);
  const perms = session?.actor.permissions ?? [];
  let approvals: DiscountApproval[] = [];
  let mfaRequired = false;
  let centres: { id: string; name: string }[] = [];
  if (perms.includes('frontdesk.discount.approve')) {
    try {
      approvals = (await listDiscountApprovals()).data;
      // Centre names are display only: without them the column shows "—".
      centres = await listCentres().catch(() => []);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403 && e.problem.code === 'auth.mfa_required') mfaRequired = true;
      else throw e;
    }
  }
  return <DiscountApprovalsInbox approvals={approvals} permissions={perms} currentMembershipId={session?.actor.membershipId ?? ''} centres={centres} mfaRequired={mfaRequired} />;
}
