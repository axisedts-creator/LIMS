# T3 impl (writer)
Files: services/api/src/modules/identity/domain/{session,membership,tenant,support-session,ird-annex,invitation,export}.state.ts — pure tables (STATES + EDGES record + canTransition); membership adds canLockTransition; ird-annex adds checkAnnexTransition.
[CONV] `null` from = creation, keyed `(none)`; lookups guarded by Object.hasOwn (no prototype keys like `constructor`).
[CONV] Annex: edge check first (409 beats 400); dates must be real YYYY-MM-DD; completed also needs submittedOn to compare (missing → 400, fail closed); referenceNo/note must be non-blank after trim.
[CONV] Invitation: §2.6 lists `expired` as terminal but also "resend from expired/failed creates sent" — implemented as expired|failed → sent (matches tests).
Verify: T3 7 files + domain tests 521/521 pass. Full api suite: 2 fails in lab/__tests__/boot.test.ts ("module reporting: index.ts exports no manifest") — not C2. typecheck: 1 pre-existing error in packages/shared-ts/src/bsdate/index.ts (TS5097), none in T3 files.
Open: dead letter §2.8 out of T3 scope.
