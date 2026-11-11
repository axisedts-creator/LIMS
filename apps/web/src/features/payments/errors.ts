// Plain-words text for the problem codes the PG-T19 screens can meet (04-UI-UX §2.3–2.6, §7). A code or a server detail is never shown to a user.
export const OTHER_FAILURE = 'Something went wrong. Try again; if it keeps failing, contact support.';
export const SECOND_PERSON = 'A second person must approve this refund.';
export const RATE_LIMITED = 'Checked a moment ago. Try again in a few seconds.';

export interface Failure { status: number; code: string }

export function failText(r: Failure): string {
  if (r.status === 429) return RATE_LIMITED;
  switch (r.code) {
    case 'auth.forbidden': return 'You do not have permission to do this.';
    case 'auth.mfa_required': return 'Extra verification is needed for this action. Verify with your authenticator app, then try again.';
    case 'common.version_conflict': return 'This record changed. Reload the page to see the latest.';
    case 'common.immutable_record': return 'This finding was already resolved.';
    case 'common.validation_failed': return 'Check the values and try again.';
    case 'payments.refund_self_approval_forbidden': return SECOND_PERSON;
    case 'payments.refund_exceeds_captured': return 'More than can be refunded.';
    case 'payments.refund_not_allowed': return 'This refund cannot be changed that way any more. Reload the page to see the latest.';
    case 'payments.gateway_not_available': return 'The provider is not available right now. Try again in a little while.';
    case 'payments.reconciliation_in_progress': return 'A reconciliation is already running.';
    case 'payments.static_qr_already_reconciled': return 'This date and centre were already reconciled.';
    default: return OTHER_FAILURE;
  }
}
