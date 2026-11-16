CHANGES

Brief done_when (3): "if the spec forbids accepting a pending invitation, keep sent only and raise a CR instead". The spec does forbid it:
spec/chunks/C2-identity-admin/03-APP-FLOW.md:120 (§2.6) lists the only accept edge as `sent → accepted` (pending may go only to sent/failed/revoked), and
:60 (M2) has the precondition "invitation `sent`, not expired". The code's own state table services/api/src/modules/identity/domain/invitation.state.ts:6
(`pending: ['sent', 'failed', 'revoked']`) agrees. The tester note's "spec does not forbid" grep missed §2.6/M2. LD-299 records facts; it does not rule pending acceptable.

1. services/api/src/modules/identity/repository/mfa.repo.ts:79-81 — revert INVITE_ACCEPT_SQL to `status = 'sent'`; replace the comment with
   `// LD-299 T0B-ACTIVATE-1: sent only (03-APP-FLOW §2.6 / M2); pending acceptance raised as CR .orchestra/cr/T0B-ACTIVATE-1.md`.
2. services/api/src/modules/identity/repository/__tests__/mfa.repo.accept-invitation.test.ts:1-3, 53, 59, 77, 101-104, 109 — make `pending` the refused case:
   an unexpired `pending` invitation -> false, invitation and membership untouched; the statement lists only `sent` (line 104 expects `['sent']`); keep the expiry and scoping guards.
3. services/api/src/modules/identity/handlers/__tests__/activate.chain.test.ts:36, 67 — fake acceptInvitation mirrors `sent` only; insert an explicit worker-seam step
   that moves the invitation `pending -> sent` (as identity.send_invitation does) before set password, then assert accepted/active/activate/login as now.
   Add one assertion that without that step set password leaves the membership `invited` and activateTenant is still refused (pins the remaining staging gap).
4. .orchestra/cr/T0B-ACTIVATE-1.nonblocking.md — add a BLOCKING CR (lead decision needed) for `pending → accepted`: change 03-APP-FLOW §2.6 (line 120) and
   M2 (line 60) precondition, plus domain/invitation.state.ts EDGES; until ruled, staging needs the worker (or the founder SQL workaround) to mark the invitation `sent`.
   Also fix the existing CR bullet "03-APP-FLOW §3.7 ... pending or sent": the governing text is §2.6/M2, not §3.7.

Otherwise OK: confirmEmailToken.ts:79-82 (invite ok when provisioning|active, recovery active only, count/locked/status guards kept, same no-oracle error) matches done_when (2);
login gate and resolver untouched (4); no rate-limit/MFA/platform-path change (6); mail-template CR present (7); no PHI/secrets; owned paths only; names verbatim.
Ran verify.cmd: 4 files, 46/46 pass. Not verified: real Postgres run of the accept SQL.
