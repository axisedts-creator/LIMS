// Invitation state table (03-APP-FLOW §2.6; identity.invitations.status). Pure. No creation row in §2.6.
export const STATES = ['pending', 'sent', 'accepted', 'expired', 'revoked', 'failed'] as const;
export type InvitationStatus = (typeof STATES)[number];

const EDGES: Readonly<Record<InvitationStatus, readonly InvitationStatus[]>> = {
  pending: ['sent', 'failed', 'revoked'], // job ok, job exhausted, deactivate
  sent: ['sent', 'failed', 'accepted', 'expired', 'revoked'], // resend (attempt_no+1), exhausted, accept, cron, deactivate
  expired: ['sent'], // resend = new attempt
  failed: ['sent'], // resend = new attempt
  accepted: [],
  revoked: [],
};

export function canTransition(from: InvitationStatus, to: InvitationStatus): boolean {
  return Object.hasOwn(EDGES, from) && EDGES[from].includes(to);
}
