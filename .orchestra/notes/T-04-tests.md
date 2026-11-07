# C5 T-04 tests (tester)
- File: `services/api/src/modules/lab/events/__tests__/publish.test.ts` (vitest, real core `createEvents({producer:'lab'})` + C0 in-memory tx fake, so real envelope+event schemas validate).
- Run: `.orchestra\notes\T-04-verify.cmd` (= `pnpm --dir services/api exec vitest run src/modules/lab/events/__tests__`). Now: suite fails, "Cannot find module '../publish.js'" (right reason).
- Covers: 7 keys + aggregates (02-TRD s7.1), approvedSetHash / valueSha256Prefix16, dedupe/re-emit, AC-01.1, AC-05.1 (4 events, rollback), AC-05.5, AC-16.5, verified if/then/else (specimen-less, auto), 14 negative schema cases, S-12 no-extra-key leak, all 7 IC examples round-trip, event types == manifest.produces.
- SEAM (writer must follow, spelled out in test header): `createLabEvents(events)` -> `{specimenStatusChanged, specimenRejected, resultVerified, resultApproved, resultAmended, orderReadyForReport, criticalValueDetected}(ctx, icPayload, meta)`; meta = `{specimenVersion}` / `{resultRowVersion}` / `{approvedSet, readinessSeq}` / `{value, resultRowVersion}`; plus exports `approvedSetHash`, `valueSha256Prefix16`.
- ASSUMPTION: hash join = "\n" over string-sorted `result_id:version_no` (02-TRD s4.7); aggregate seq for approved/amended/critical = result row version, ready = readinessSeq (spec silent).
- Name clash: `.orchestra/notes/T-04-*` previously held C1 infra T-04 notes; overwritten per inbox instruction (git history keeps them).
- NOT proven: real PG insert / fan-out (needs DB integration, other tasks).
