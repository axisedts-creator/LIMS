APPROVE

T0B-ACTIVATE-2 review (diff 884bb0607..HEAD), LD-302 / CR-C0-ACTIVATE-1c.
- Code: invitation.state.ts EDGES pending += accepted; INVITE_ACCEPT_SQL `status IN ('pending', 'sent') AND expires_at > $4`, tenant/membership/user scoping unchanged. Both cite LD-302. DB CHECK invitations__status__ck allows both; no transition trigger; RLS/policies untouched; MEMBERSHIP_ACTIVATE_SQL unchanged (membership still only activated after an invitation row is accepted).
- done_when (1)-(4): repo test pending -> accepted; negatives revoked/failed/expired/accepted/superseded + expired-pending refused; chain test uses real acceptInvitation SQL over fake tx, no worker step, activateTenant succeeds; bad token_hash / unknown setup session refused.
- (5) no change to rate limits, MFA, sessions, token verification, platform branch. (6) CR marked RULED, spec/ not edited.
- Owned paths only; 6 code/doc files + notes. No PHI, no secrets, names verbatim.
- Ran: verify.cmd 3 files 66/66 pass; tsc --noEmit clean.
- Not verified: INVITE_ACCEPT_SQL against real Postgres (fake tx only); C2 owner must apply spec text (§2.6 edge, M2).
