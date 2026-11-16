# T0B-ACTIVATE-1 impl (writer, review fixes)
Files: identity/handlers/confirmEmailToken.ts (invite ok when provisioning|active, recovery active only; unchanged this round); identity/repository/mfa.repo.ts (INVITE_ACCEPT_SQL reverted to status = 'sent' per review: 03-APP-FLOW §2.6/M2, comment cites LD-299 + CR).
[CONV] membership activation runs only after the invitation update returns a row (unchanged). Platform DEFINER path, rate limits, MFA, login gate, resolver untouched. tenant.service.ts: read only.
CR .orchestra/cr/T0B-ACTIVATE-1.nonblocking.md: §3.7 pending bullet removed; new BLOCKING ACTIVATE-1c (pending -> accepted: §2.6 line 120, M2 line 60, invitation.state.ts EDGES); 1b mail/template kept. Review named cr/T0B-ACTIVATE-1.md in the comment; pointed it at the existing file instead.
Tests: verify.cmd 46/46 pass. identity suite: 10 fail, same pre-existing role-packs/ci-scripts failures, unrelated.
Open: lead ruling on ACTIVATE-1c; until then staging needs the worker or founder SQL to mark invitations sent. Real Postgres run of the SQL not done.
