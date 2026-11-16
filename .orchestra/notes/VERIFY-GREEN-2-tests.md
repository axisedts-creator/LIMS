# VERIFY-GREEN-2 tests (tester)
- RED: `services/api/src/modules/catalog/__tests__/ci/vg2.typecheck.test.ts` (+ fixture `tsconfig.vg2.json`): tsc on the two files with the api tsconfig; fails now with exactly 28 errors (catalog 26: TS2352 x18, TS2322 x7, TS2375 x1; partners 2). Also guards: no @ts-ignore/@ts-expect-error/`as any`/new skipLibCheck, strict + exactOptionalPropertyTypes intact (these 2 pass now).
- GREEN pin: `services/api/src/modules/partners/__tests__/unit/vg2.buildBookingOrderInput.test.ts` (6 tests): strict-equal output of buildBookingOrderInput (lines 36/44), absent-not-undefined keys. Must stay green after the fix.
- Catalog mapper lines (165/192/321/323/384/392/396/492) are already pinned by contract tests (real, t29.fields/parties, instrumentMaps, cache); writer adds one identical-output test per mapper edit it makes.
- Run: `.orchestra\notes\VERIFY-GREEN-2-verify.cmd` (vitest over src/modules/catalog + src/modules/partners, via the package). Last run: 1 failed (the RED gate) | 120 files passed, 7323 tests passed.
- Before: api 66 errors (log `.orchestra/notes/vg2-tsc-before.log`); writer records after counts via `turbo run typecheck --continue`.
- Not covered: "no emitted value changed" beyond these pins; runtime-shape questions go to notes/VERIFY-GREEN-2.md + CR (writer).
