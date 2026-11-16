TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)

Change: tester only, no assertion change. Re-record apps/web/src/features/admin/__tests__/rs-c2.baseline.json once with RS_C2_RECORD=1 (rs-c2.static.test.ts:113-117) on the current lane tree. The allowed diff is: the auth/actions.ts hash, the auth/messages.ts hash, the new route app/(auth)/auth/waking/page.tsx, and field_names minus exactly `x-forwarded-for` and `x-real-ip`. Everything else stays equal. Commit as "[tester] T0D-WAKE-1 tests revised per ruling".
Reasons:
1. Dispute item 3 (field_names) is resolved by LD-303 (task brief, lead decisions; binding over spec text for this task): the removal of those two entries is legitimate drift from T0A-CLIENTIP-1 (c069f7ecd) and is allowed in the re-record.
2. Pre-check done (grep apps/web/src, 2026-11-17): no non-test file under features/admin, features/platform, app/(auth) or app/(platform) reads either header; apps/web/src/core/api/client-context.ts:27-28 still reads both. client-context.ts is outside ROOTS (rs-c2.static.test.ts:17), so the baseline entries at rs-c2.baseline.json:172-173 are stale, not a regression.
3. Dispute items 1-2 (hashes, waking route) were already ruled TESTS_WRONG and confirmed by LD-298; the implementation is approved and is unchanged.
4. rs-c2.static guards against unintended edits to data/route/field files (rs-c2.static.test.ts:8, "record again only on purpose"); this is such an on-purpose record, so asserting the old baseline is not required by the spec or the brief.
5. Writer changes nothing. If the recorded diff holds any other entry, the tester stops and writes a blocking CR with the diff (LD-303).
