# T0D-MSERIES-5 dispute (writer, 2026-11-16 19:19 NPT)
Run (verify.cmd, HEAD 30a284e11): m5 config 381 passed / 1 failed; packages/ui lint 41 passed / 1 skipped.
The 1 red: rs-c2.screens.test.tsx:370 ("no `snapshot: sign-in ` entry") — `rs-c2.screens.test.tsx.snap:339` still holds `exports[\`visual snapshots of the key screens are recorded > snapshot: sign-in 1\`]` (Vitest: 1 obsolete).
The ruling (T0D-MSERIES-5-ruling.md item 1, TESTS_WRONG) orders the TESTER to delete that entry; no tester commit since the ruling, so it is still there.
The .snap is a test artefact; the writer may not edit it (done_when 5). No implementation change can make this test pass. Writer stops; tester to apply ruling item 1.
