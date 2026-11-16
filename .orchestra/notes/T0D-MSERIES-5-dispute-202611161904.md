# T0D-MSERIES-5 dispute (writer, after tester revision a444dfca1)
Verify run: m5 config 381/382 pass, R07 41/41 pass (real tree skipped as in verify.cmd).
Only red: `rs-c2.screens.test.tsx:370` expects the .snap to have no `snapshot: sign-in ` entry.
Cause: ruling item 3 not applied. `apps/web/src/features/admin/__tests__/__snapshots__/rs-c2.screens.test.tsx.snap:339` still holds `snapshot: sign-in 1` (vitest also reports it as 1 obsolete). Commit a444dfca1 touched only items 1, 2, 4.
Fix (tester-owned file, writer may not edit, brief done_when (5)): delete that one snapshot export from the .snap (or run vitest -u for that file only). No implementation change needed.
