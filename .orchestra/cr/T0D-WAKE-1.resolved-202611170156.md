Title: CR-C0-0D-WAKE-1-001: rs-c2 baseline re-record holds 2 entries beyond the LD-303 allowance
From chunk: C0-0D            To owner: lead
Type: bug
Blocking? yes (T0D-WAKE-1 tester stage; rs-c2.static stays red, MSERIES-6 shares the baseline)
Problem: Re-recorded rs-c2.baseline.json once with RS_C2_RECORD=1 on the lane tree, as the ruling says. The diff holds the allowed entries (auth/actions.ts hash, auth/messages.ts hash, route app/(auth)/auth/waking/page.tsx, field_names minus x-forwarded-for and x-real-ip; api_paths and permission_codes unchanged) AND two NOT allowed entries, so per LD-303 I stopped, reverted the baseline (working tree clean) and committed nothing:
  - data_files "features/platform/actions.ts": 7f6c66d9...664b5e -> 6a19465c...cf60b9d
  - data_files "features/platform/shared.ts":  7ecda1df...e530fe5 -> 6a2d3c5d...c9d52fb91
Cause (git log): commit 9677e24a3 "[writer] PLATFORM-PROVISION-1 impl" (merged from main into the lane) edited both files; the baseline predates it. Same kind of legitimate drift as LD-303, but a different task.
Proposed change (exact): lead rules that the re-record may ALSO update those two data_files hashes (features/platform/actions.ts, features/platform/shared.ts, caused by 9677e24a3), nothing else; tester then re-records and commits "[tester] T0D-WAKE-1 tests revised per ruling". No assertion change.
Backward compatible? yes. Tenant/security impact: none (test baseline only).
Alternatives considered: record anyway (breaks LD-303 stop rule); hand-edit JSON (same as recording).
Tests that will prove it: rs-c2.static.test.ts 9 of 9 green after the re-record.
Full recorded diff: .orchestra/notes/T0D-WAKE-1-baseline-diff.patch
