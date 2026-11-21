// 04-UI-UX §8.10 Finance worklist. The refund list needs billing.refund.approve; the API answers 403 otherwise and the layout shows PermissionDenied.
// T0D-UILIST-2 (LD-353 rule 6): 501 = NotAvailable with the header row, 500 = ErrorState under the kept title and filters.
import { pendingOr } from '@/core/shell/NotAvailable';
import { getShellSession } from '@/core/session/server';
import { FinanceWorklist, WORKLIST_COLUMNS } from '@/features/billing/components/FinanceWorklist';
import { readList } from '@/features/billing/components/listRead';
import { listCreditNoteTasks, listFinanceReviewItems, listRefundRequests } from '@/features/billing/server/read.server';

export default async function WorklistPage() {
  const session = await getShellSession();
  return pendingOr('Finance worklist', WORKLIST_COLUMNS, async () => {
    const { value, failure } = await readList(() => Promise.all([listCreditNoteTasks(), listFinanceReviewItems(), listRefundRequests()]));
    const [tasks, review, refunds] = value ?? [];
    // currentMembershipId: the session does not carry the membership id yet (CR .orchestra/cr/BL-T20.md); '' disables only the UI hint, the API still forbids self-approval.
    return <FinanceWorklist creditNoteTasks={tasks?.data ?? []} reviewItems={review?.data ?? []} refundRequests={refunds?.data ?? []} currentMembershipId="" permissions={session?.actor.permissions ?? []} {...(failure ? { failure } : {})} />;
  });
}
