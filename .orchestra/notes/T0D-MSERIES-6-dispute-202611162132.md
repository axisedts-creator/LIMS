# T0D-MSERIES-6 dispute (debugger)
Verify log: only 2 red, both in rs-c2.static.test.ts ("data, action ... untouched", "same route files") vs stale rs-c2.baseline.json (last recorded ec073f164, before T0D-WAKE-1).
Diffs seen: features/admin/auth/actions.ts + messages.ts hashes and new route app/(auth)/auth/waking/page.tsx. All three come from T0D-WAKE-1 (commit b0187fc96); MSERIES-6 touched none of them (only EntryHero, brand.ts, (auth)/layout.tsx, shell.css, asset).
Arbiter already ruled TESTS_WRONG for exactly this in T0D-WAKE-1-ruling.md item 1: tester re-records with RS_C2_RECORD=1, checks the diff is only those 3 entries. Not yet applied.
Baseline is a test artifact; debugger may not edit it. Needed: tester re-record, then re-run T0D-MSERIES-6-verify.cmd.
