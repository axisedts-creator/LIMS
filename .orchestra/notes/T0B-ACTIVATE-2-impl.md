# T0B-ACTIVATE-2 impl (LD-302, CR-C0-ACTIVATE-1c)
Files: identity/domain/invitation.state.ts (EDGES pending += accepted); identity/repository/mfa.repo.ts (INVITE_ACCEPT_SQL `status IN ('pending', 'sent')`, LD-302 comment); .orchestra/cr/T0B-ACTIVATE-1.nonblocking.md (1c marked RULED, names 03-APP-FLOW §2.6 edge + M2 precondition for C2 owner).
setPasswordFromSetup.ts: no status check there, unchanged. No change to tokens, MFA, rate limits, sessions, platform rights.
[CONV] Spec files not edited; CR carries the text change.
Tests: 3 task files 66/66 pass; tsc --noEmit clean. Full identity run: 57 fails, all outside this task (audit.chain.test.ts = ADMINFIX-1 IdentityPort CR; role-packs/apply-role-pack.script + ci-scripts = script-output tests, empty stdout).
Open: real-DB SQL not run (fake tx only); C2 owner to apply spec text.
