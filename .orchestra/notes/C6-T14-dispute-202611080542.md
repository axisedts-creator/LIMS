# C6-T14 dispute (writer, 2026-11-08 03:27)
TESTS_WRONG (harness, not impl). `.orchestra/notes/C6-T14-verify.cmd` runs bulk-release.load in the SAME vitest process as manifest.test.ts, in parallel. The load test's busy-spin `sleep` starves CPU, so manifest.test.ts:15 `beforeAll` fails "Hook timed out in 10000ms" (48 skipped). Result: 64 pass, 1 suite failed.
Each file alone passes: manifest 48/48 (7.5 s), bulk-release.load 4/4 (56 s), bulk-release.test 60/60 (16.7 s) = 112/112.
The previous ruling (C6-T14-ruling.md, last line) assumes a "separate-process verify.cmd", but verify.cmd is still one combined command.
Required (tester): run the load file in its own vitest invocation, e.g.
`pnpm --dir services/api exec vitest run src/modules/reporting/__tests__/bulk-release.test src/modules/reporting/__tests__/manifest && pnpm --dir services/api exec vitest run src/modules/reporting/__tests__/bulk-release.load`
(or `--no-file-parallelism`). No implementation change needed.
