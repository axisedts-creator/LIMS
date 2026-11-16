# T0D-MSERIES-5 dispute (writer, 2026-11-16 19:24 NPT)
Run (verify.cmd, HEAD e195a5442): m5 config 381 passed / 1 failed; packages/ui lint 41 passed / 1 skipped.
The 1 red is unchanged: rs-c2.screens.test.tsx:370 ("no `snapshot: sign-in ` entry"); `rs-c2.screens.test.tsx.snap:339` still holds `exports[\`visual snapshots of the key screens are recorded > snapshot: sign-in 1\`]` (Vitest: 1 obsolete).
Ruling (T0D-MSERIES-5-ruling.md, TESTS_WRONG, third time) routes item 1 to the TESTER; last commit touching `__snapshots__/` is still 9f502f09b, so the tester has not applied it.
The .snap is a test artefact; the writer may not edit it (done_when 5). No implementation change can make this test pass. Writer stops; orchestrator must dispatch the TESTER (not the writer) to delete that one export.
