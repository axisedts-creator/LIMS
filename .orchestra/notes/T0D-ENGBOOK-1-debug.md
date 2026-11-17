# T0D-ENGBOOK-1 debug (debugger)
- Cause: the one red test (adminpage-eng-1.static.test.ts:94) byte-compares permissions.yaml with git 052539369; T0C-ACCT-1 (db5fcccda) legitimately added billing permissions. Not caused by this task.
- Fix: none in implementation code (nothing to fix; reverting T0C-ACCT-1 is out of scope). No test edited.
- Dispute written: .orchestra/notes/T0D-ENGBOOK-1-dispute.md (needs arbiter to re-pin BASE or narrow the compare).
