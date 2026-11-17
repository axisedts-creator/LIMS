# T0B-ACCT-1 debug (verify round: 29 fail / 2007 pass)
- counter.unit static rule (1 fail): a COMMENT in invoice.service.ts (REGAPI-2 previewNo) named fiscal_counters. Fix: comment reworded, no code change; counter.unit 41/41 green.
- crossTenant.handlers (28 fail): the 12 ACCT-2 ops are still 503 stubs and the probe forbids service_unavailable. Not ACCT-1 code (its 12 ops pass). Test untouched: see T0B-ACCT-1-dispute-crosstenant.md.
- Not re-run: full billing suite, boot.test (60 s timeouts on loaded host).

# round 2 (verify: 28 fail / 2008 pass, 1 failed file)
- All 28 fails = probes/crossTenant.handlers.test.ts on the 12 ACCT-2 ops (503 stubs, outside ACCT-1 scope). counter.unit fix from round 1 holds.
- No implementation change possible within scope; dispute stands in T0B-ACCT-1-dispute-crosstenant.md (lead: exempt ACCT-2 ops until T0B-ACCT-2, or exclude file from ACCT-1 verify).

# round 3 (verify: 28 fail / 2008 pass, same 1 file)
- Same 28 fails, all probes/crossTenant.handlers.test.ts: 12 ACCT-2 ops (503 stubs, 23 fails) + 5 frontdesk REGAPI-2 ops (registry count 29 vs 47, createCustomFieldDefinition TypeError, update* expect validation_failed got not_found). None in ACCT-1 code; accounts tests all green.
- No implementation change in scope; dispute T0B-ACCT-1-dispute-crosstenant.md stands (add: frontdesk 5 belong to T0B-REGAPI-2/probe update).

# round 4 (verify: 4 fail / 2013 pass, probes/crossTenant.handlers.test.ts, 4 frontdesk REGAPI-2 ops)
- Cause: parity.service.ts (a) insertUnique: DTO of an undefined insert row -> TypeError (createCustomFieldDefinition); (b) update{IcdCode,Coupon,CustomFieldDefinition} threw validation_failed for an empty body BEFORE the tenant lookup, so a B id answered 400 not 404 (spec minProperties:1, sample body {}).
- Fix: insertUnique throws common.not_found when no row returns; the empty-body check moved from the 3 update fns into patchMaster after lockMaster. Probe file now 204/204 pass.
- Not run: regapi2/masters.test.ts (needs LIMS_TEST_APP_URL / docker PG); full verify.
