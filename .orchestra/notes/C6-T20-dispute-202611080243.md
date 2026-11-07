# C6-T20 test dispute (writer)
Result: api 84/86 pass, worker 13/13 pass. The 2 failures are test defects; I did not touch tests and stopped.

1. `portal.resolver.test.ts` "every invalid credential rejects reporting.link_invalid..." — case `'too long': 'link.' + 'A'.repeat(5000)` (5005 chars).
   `core/auth/resolvers.ts:36` rejects any credential > `MAX_CREDENTIAL` (4096) with `auth.unauthenticated` BEFORE the module resolver runs, so no resolver can return `link_invalid` for it. All 18 other cases pass.
   Fix: shorten the case to < 4096 chars (e.g. 4000), or accept `auth.unauthenticated` for it; or CR C0 if the 4096 cap must map to `link_invalid`.
2. `portal.service.test.ts` P5 "response is byte-identical for expired / valid / over-limit..." — last line expects `jobsOf('reporting.reissue_portal_link')` length 1, but the loop calls the expired link 4 times (`e, v, e, e, e`) with default `link_reissue_max_per_day` 3, so 3 jobs is correct. The sibling test ("the 4th still answers 202 {} but enqueues nothing", 3 jobs after 4 calls) fixes that contract.
   Fix: expect 3 (the response-identity assertions before it pass).
