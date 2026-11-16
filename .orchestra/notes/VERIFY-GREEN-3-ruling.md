TESTS_WRONG — line 26 of `services/api/src/modules/frontdesk/__tests__/ci/vg3.typecheck.test.ts` fails on an error outside the task's five files, which the task does not require fixing.
Change: on line 26, drop `5097|2835` from the regex so it reads `/TS(18003|6053|5083)/`. Those three codes are the only ones that mean the fixture tsconfig itself is broken. A TS5097/TS2835 inside the five files is already caught by the `mine` assertion on line 25. Leave line 25 and test 2 unchanged.
Reasons:
- Task brief `done_when` (.orchestra/inbox/VERIFY-GREEN-3-arbiter.md:22) says "the listed errors are 0". The list is TS2345/TS2352/TS2322 in the five files (:13-20). `packages/shared-ts` is not on that list.
- The test's own header (vg3.typecheck.test.ts:5) says "Errors elsewhere ... do not fail this task". Line 26 contradicts that.
- `packages/shared-ts/src/bsdate/index.ts(2,48) TS5097` (and formula/index.ts(3,20)) already happens with the package's own `tsc -p services/api`. The fixture did not cause it. It is recorded as pre-existing in .orchestra/notes/AN-T02-impl.md:2, API-T01-impl.md:6, C3.T-21-debug.md:2.
- spec/program/01-CHUNK-MAP.md:115 says `shared-ts/` belongs to C0-0A, not C1. CLAUDE.md allows editing only owned paths, so the writer cannot fix it within this task.
- No CR is needed for this task. The TS5097 fix belongs to C0, which can take it up through the VERIFY-GREEN backlog (LD-256).
