# HC-T02 tests (domain, pure)
Files (services/api/src/modules/homecollection/__tests__/unit/): domain.visit.state / .collection.state / .handover.state / .mutation / .clock / .cursor `.test.ts`.
Run: `.orchestra\notes\HC-T02-verify.cmd` (= `pnpm --dir services/api exec vitest run src/modules/homecollection/__tests__/unit/domain`).
Writer creates `domain/{visit.state,collection.state,handover.state,mutation,clock,cursor}.ts`; the exact exported names/signatures are the SEAMS comment at the top of each test file (spec fixes behaviour, not names).
Fail now: the domain modules do not exist (import resolution error). Not covered: device state machine §1.4 (not in the plan row / TRD file list), conflict.ts guards (other task).
Spec gaps (no error code named; tests only require a LimsError): forbidden pairs other than closed-visit, in_progress->unassigned, applied|discarded collection, terminal handover.
Assumptions to confirm: handover `itemCount` / `confirmationRequired` opts; clock input/output shape; `skewSeconds`; "most recent anchor" = greatest serverTime.
