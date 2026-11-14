CR_NEEDED — dispute #1 (resolver 'too long') needs a C0 change, CR-C6-021 in .orchestra/cr/C6-T20.md; dispute #2 (P5 job count) is TESTS_WRONG.
1. 'too long' case: test is correct per spec. 01-PRD.md:218 (AC-11.5) demands identical `404 reporting.link_invalid` for malformed tokens; 07-SECURITY.md:38 (REQ-SEC-095) identical bodies. Do NOT shorten the test.
   The 401 comes from C0-owned core/auth/resolvers.ts:36 (MAX_CREDENTIAL 4096 is [CONV], not in the spec; 03-INTERFACE-CATALOG.md:2459 auth.unauthenticated is 401).
   08-CR-REGISTER.md:463/:1398 (CR-C6-001) only says the resolver may return link_invalid → 404; the pre-check is unspecified → CR to C0-0D. Until it's resolved, the case stays red (blocked, not wrong).
2. P5 "byte-identical…" test: TESTS_WRONG. 01-PRD.md:218 limits reissues to `link_reissue_max_per_day` (default 3 per the sibling test, portal.service.test.ts:277-280).
   The loop at portal.service.test.ts:293 calls the expired link 4 times → 3 jobs. Change portal.service.test.ts:297 `toHaveLength(1)` → `toHaveLength(3)`. The response-identity assertions stay as they are.
