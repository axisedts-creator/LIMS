// CR-C16 draft: the patient's MEMBERSHIP id for a request. The core puts it on ctx.actor.membershipId (claims.membership_id, TRD §4.2); ctx.actor.id is the
// patient's USER id (claims.sub, LD-81). Older code read ctx.claims.membership_id (the handler context has no `claims`) or treated actor.id as the
// membership id, so authenticated patient calls found no account (404 / 403). Callers that must keep the old seam fall back to actor.id themselves.
export const patientMembershipId = (ctx: unknown): string | undefined => {
  const c = ctx as { actor?: { membershipId?: unknown }; claims?: { membership_id?: unknown } } | undefined;
  const m = c?.actor?.membershipId ?? c?.claims?.membership_id;
  return typeof m === 'string' ? m : undefined;
};
