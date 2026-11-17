# T3 tests (tester)
Files (services/api/src/modules/identity/domain/__tests__/): session|membership|tenant|support-session|invitation|export|ird-annex `.state.test.ts` + `state-table.helper.ts` (shared helper, not a test).
Run: `.orchestra\notes\T3-verify.cmd` (vitest, only these 7 files). Expected now: all fail on missing `../<name>.state.js` imports (impl absent).
Each test enumerates the FULL 03-APP-FLOW §2 edge list: every allowed edge passes, every other (from,to) pair incl. `null` creation is forbidden; STATES must equal the 05-SCHEMA CHECK set.
Assumed API per module (header comments): `STATES`, `canTransition(from|null, to): boolean`; membership adds `canLockTransition(fromLocked,toLocked)`; ird-annex adds `checkAnnexTransition(from,to,{submittedOn,completedOn,referenceNo,note,today})` -> `{ok}` | `{ok:false,code}`.
Covers AC-E3.1/E3.2/E3.3 (409 identity.annex_invalid_transition beats 400 field errors), US-E4 / AC-E4.4 support-session table. Invitation has no creation edge (not in §2.6); dead letter §2.8 out of T3 scope.
