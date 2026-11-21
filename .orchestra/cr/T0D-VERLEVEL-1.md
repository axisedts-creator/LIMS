Title: CR-C0-T0D-VERLEVEL-1: expose the signed-in user's id on the shell session actor so the lab queues can dim rows the user already signed
From chunk: C0 (T0D-VERLEVEL-1, lab web)            To owner: C0-0C (contracts/openapi/identity.yaml SessionState.actor) + C0-0D (apps/web/src/core/session)
Type: api + shared-lib
Blocking? no for T0D-VERLEVEL-1 delivery (the API still refuses with lab.verifier_not_distinct); yes for done_when (2) "rows the signed in person already signed are shown dimmed ... and cannot be acted on" in the running app.
Problem: QueueScreen compares ResultSignoff.signer_user_id (contracts/openapi/lab.yaml) with a `currentUserId` prop. apps/web/src/app/(staff)/lab/verification/page.tsx and approval/page.tsx can only read getShellSession(), whose ShellSession.actor (core/session/types.ts) has no user id. SessionState.actor in contracts/openapi/identity.yaml (line ~5252) carries display_name, tenant_code, roles, permissions, support_session only (additionalProperties: false); c2.ts reads an undocumented membership_id. The dev BffSession (core/session/store.ts:13) already holds userId but never maps it to the actor.
Proposed change (exact):
 (1) identity.yaml SessionState.actor.properties: add `user_id: { $ref: _common.yaml#/components/schemas/Uuid }` (optional, present only when state is active, same rule as permissions).
 (2) core/session/types.ts ShellSession.actor: add `readonly userId?: string;`.
 (3) core/session/c2.ts: map `s.actor.user_id` to `userId` when it is a string (as membership_id is mapped at line 83); dev resolver in store.ts: set `userId` from BffSession.userId.
 (4) then (lab-owned, follow-up): both queue pages pass `currentUserId={session?.actor.userId}` to VerificationQueue / ApprovalQueue.
Backward compatible? yes — optional additive field; consumers that ignore it are unaffected.
Tenant/security impact: no RLS change, no PHI; the user's own id, returned only to that user's BFF. Display only: the server stays the enforcer (lab.verifier_not_distinct), so a missing or wrong id never lets anyone sign twice.
IRD/regulatory impact: none.
Alternatives considered: compare by membershipId (rejected: ResultSignoff carries signer_user_id only); call a "who am I" endpoint per page (rejected: extra round trip for a value the session already knows).
Tests that will prove it: c2.ts unit test maps actor.user_id to userId; verlevel1.queues tests already cover dimming given currentUserId; one page test that the verification page passes session.actor.userId.
