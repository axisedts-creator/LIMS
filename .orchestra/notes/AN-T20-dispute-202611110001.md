# AN-T20 dispute (writer)
Test `an-t20.schedules.test.tsx:182` ("new: defaults … creator as recipient") cannot pass: the harness mock `getShellSession` at `an-t20.harness.tsx:38` returns an actor with no `membershipId`, so the creator default never applies. LD-89 adds `ShellSession.actor.membershipId` and `schedules-page.tsx` reads it.
Fix (tester, harness only): add `membershipId: OWNER_M` to the actor at an-t20.harness.tsx:38 (OWNER_M is already the id of 'Synthetic Owner' in the recipients list, l.73). Line 182 stays as is.
Status: 136/137 pass; this is the only failure.
