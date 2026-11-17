# C6-T16 debug (verify: 3 api files "Hook timed out in 10000ms")
Cause: beforeAll's cold `import('../index.js')` (whole reporting module + jsdom/dompurify eager load from C6-T17) takes ~10 s when 3 api test files import in parallel; not a T16 logic fault (tests skipped, 0 assertions ran).
Re-run of same 3 files: 177/177 pass (10.7 s). manifest.test.ts alone 15/15.
Fix: none in impl (shrinking the import would re-lazy jsdom and break T17's N9 timing fix). Durable fix = `hookTimeout` in services/api/vitest.config.ts (C0-owned, LD-53) or `--hookTimeout=120000` in verify.cmd; neither is mine to edit. No test/impl edits.
