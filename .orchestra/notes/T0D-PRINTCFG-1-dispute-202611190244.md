# T0D-PRINTCFG-1 dispute (writer, 2026-11-19 02:31 NPT): two rs-c6 test-file gaps; implementation done per review items 1 and 2

1. rs-c6.static.test.ts:120-124 `PRINTCFG.web_api_paths` lacks the path that review item 1 requires. The signature upload now posts to uploadUserSignature
   (`/v1/identity/users/${uuid(userId)}/signature`, identity.yaml), so the extractor reports the new entry `/v1/identity/users/${uuid` and "same web API paths" fails:
   `+   "/v1/identity/users/${uuid",`. Fix (tester): add `'/v1/identity/users/${uuid'` to `PRINTCFG.web_api_paths`; `'/v1/identity/settings/branding-assets'` can be dropped
   (no reporting file calls it any more; printcfg1.source.test.ts now asserts that). The tester commit a567404de updated the printcfg1 tests for item 1 but not this allow-list.
2. rs-c6.screens.test.tsx worklist snapshot is STILL missing `button Ready to release` between `button Search` and the first `button Select an item`
   (LD-399/LD-400 insert). LD-400 says it is on disk; it is not: `git status` is clean for the .snap and the live run shows
   `+ button Ready to release` as the only diff. Not PRINTCFG-1 code (T0D-UILIST-1 drift, LD-395). Fix: insert that one line, or `vitest -u` on that test only.
Everything else in the verify command is green (see impl notes).
