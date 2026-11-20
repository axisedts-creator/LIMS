TESTS_WRONG — rs-c2.baseline.json (apps/web/src/features/admin/__tests__) is stale; TESTER stage re-records it with RS_C2_RECORD=1 (rs-c2.static.test.ts:113-117). No assertion change, no code change.
Reasons:
1. Arbiter run on lane tree 2026-11-17: rs-c2.static 3 failed / 11 passed; reds at test lines 122 (data_files), 125 (routes), 134 (field_names). api_paths (128) and permission_codes (131) pass, i.e. byte-identical as LD-306 requires.
2. data_files diff = actions.ts + messages.ts hashes (allowed LD-298) + features/platform/actions.ts and shared.ts hashes (cause main commit 9677e24a3 PLATFORM-PROVISION-1; allowed by LD-306 general rule, brief "LD-306 ... APPROVED").
3. routes diff = only + app/(auth)/auth/waking/page.tsx (allowed LD-298).
4. field_names diff = only - x-forwarded-for, - x-real-ip (allowed LD-303). Grep: outside tests/baselines those headers are read only in apps/web/src/core/api/client-context.ts and core/api/server-fetch.ts; none in features/admin or app/(auth) non-test code.
5. Writer's dispute (2 platform hashes not allowed) is resolved by LD-306, which postdates it; so the diff is now fully inside the allowed set: no CR needed.
6. Tester: commit as "tests revised per ruling"; notes must name 9677e24a3 as cause of the platform hashes (LD-306). If the baseline is already re-recorded by T0D-WAKE-1 with the same content, change nothing and say so.
7. Writer changes nothing (LD-298/LD-306: writer does not touch the baseline). Not verified by arbiter: git ancestry of 9677e24a3 on main (git blocked in arbiter sandbox; relied on LD-293/LD-306 FACT).
