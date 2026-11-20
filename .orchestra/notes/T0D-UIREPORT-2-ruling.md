TESTS_WRONG — rs-c8.baseline.json pins two files at bytes from before the writer's required second collections read; tester re-pins them, no implementation change.

1. Red: rs-c8.static.test.ts:45-51 "same bytes as before" compares sha256 of CRLF-stripped content (rs-c8.signature.ts:27, rs-c8.static.test.ts:19,47) against rs-c8.baseline.json.
2. Checked at HEAD 213540802 with the test's own normalisation:
   - src/features/analytics/server/report-page.tsx = 13804c1083b046c02a46e5370a5e87961e336053e6b9f29b6f7744ff6fd859fc (baseline :13 has b7dc47dc…, stale)
   - src/features/analytics/server/report-views.ts = 2d6ad60ac4e6aa026d97dbc6cc156abd7f50cba3b00dddc2a1cf56ae00fe9ab1 (baseline :16 has 82aae7f3…, stale)
   - src/features/analytics/components/report-types.ts = cfdc2187… matches baseline :4, leave it.
3. Previous ruling (fa3c2f303) item 1 required the writer to add one more getCollectionsReport read (group_by=day, contracts/openapi/analytics.yaml:503, :568-582). Item 2 told the tester to re-pin these files to the writer's final bytes. The tester re-pinned in 7fbac2be7, before the writer's 81e0c69fb, so the pins are one commit out of date. The bytes the implementation has now are the ones the ruling asked for.
4. Change in the test: in rs-c8.baseline.json, set :13 and :16 to the two hashes above (or recompute them at the writer's last commit if the writer changes these files again). Change no other key and no assertion. The signature checks (rs-c8.static.test.ts:53-73) keep guarding permissions, /v1 routes and server imports.
5. Owner: this file is not an rs-cN screen snapshot, so per LD-362 (.orchestra/inbox/T0D-UIREPORT-2-arbiter.md:31) the tester edits it, not the writer or the debugger.
