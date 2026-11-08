// 04-UI-UX §8.10 Finance worklist. The refund list needs billing.refund.approve; the API answers 403 otherwise and the layout shows PermissionDenied.
import { getShellSession } from '@/core/session/server';
import { FinanceWorklist } from '@/features/billing/components/FinanceWorklist';
import { listCreditNoteTasks, listFinanceReviewItems, listRefundRequests } from '@/features/billing/server/read.server';

export default async function WorklistPage() {
  const [session, tasks, review, refunds] = await Promise.all([getShellSession(), listCreditNoteTasks(), listFinanceReviewItems(), listRefundRequests()]);
  // currentMembershipId: the session does not carry the membership id yet (CR .orchestra/cr/BL-T20.md); '' disables only the UI hint, the API still forbids self-approval.
  return <FinanceWorklist creditNoteTasks={tasks.data} reviewItems={review.data} refundRequests={refunds.data} currentMembershipId="" permissions={session?.actor.permissions ?? []} />;
}
