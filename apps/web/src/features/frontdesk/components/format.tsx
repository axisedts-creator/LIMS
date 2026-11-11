// Shared presentation helpers for the front-desk screens. Money/date/permission helpers are the billing ones (same chunk, same rules).
import { StatusChip } from '@lims/ui/components/StatusChip';
export { Ad, BsAd, formatNpr, hasPerm, humanize, npr } from '@/features/billing/components/format';
import { humanize } from '@/features/billing/components/format';

/** Status is always words, never colour alone (04-UI-UX §9). */
export const Status = ({ status }: { status: string }) => <StatusChip kind="generic" status={status} label={humanize(status)} />;

const ERROR_TEXT: Record<string, string> = {
  'common.version_conflict': 'Updated by someone else — reload',
  'common.precondition_required': 'Reload the page and try again',
  'frontdesk.order_not_editable': "This test can't be removed — it is already in progress. Other tests can still be changed.",
  'frontdesk.order_cancel_not_allowed': 'This order has approved results and can no longer be cancelled.',
  'frontdesk.order_already_cancelled': 'This order is already cancelled.',
  'frontdesk.discount_self_approval_forbidden': 'Needs another approver — you cannot approve your own request.',
  'frontdesk.discount_approval_expired': 'This approval request has expired.',
  'auth.forbidden': 'You do not have permission for this action',
};
/** Failure text for banners; unknown codes show only a generic sentence (no raw server codes or messages). */
export const errorText = (code: string, status?: number) => ERROR_TEXT[code] ?? (status === 403 ? ERROR_TEXT['auth.forbidden']! : 'Something went wrong. Try again; if it keeps failing, contact support.');
export const MFA_BANNER = 'Approving discounts requires MFA — complete MFA in your profile';
export const NEEDS_APPROVER_ROLE = 'Approvals require approver role and MFA';
