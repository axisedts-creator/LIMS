# TURBO-OUTPUTS-1 tests (tester)
- File: tools/lint/tests/monorepo-skeleton.test.mjs — one assertion added to test 'turbo.json defines build ...' (LD-210).
- Asserts tasks.build.outputs deepEquals ["dist/**", ".next/**", "!.next/cache/**"] (all three entries, exact, nothing else).
- Fails now: turbo.json outputs is only ["dist/**"].
- Run: node --test tools/lint/tests/monorepo-skeleton.test.mjs  (same line in TURBO-OUTPUTS-1-verify.cmd)
- Not covered here (writer): turbo --dry=json @lims/web#build hash before/after, recorded in the impl note.
