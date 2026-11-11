APPROVE

Scope: diff f73a553..HEAD adds only `.orchestra/notes/T0A-07-verify.cmd`.
- LD-07: verify.cmd runs only this task's own tests (`packages/shared-ts/test/money.test.mjs`, `packages/shared-dart/test/money_golden_test.dart`), not the whole shared-ts suite. OK.
- Ran both: TS 19/19 pass (golden, fuzz vs BigInt oracle, static no-float check); Dart 10/10 pass ("All tests passed!").
- golden.json holds 213 cases (>= 200 done_when). ACs AC-0A-4.1/4.2/4.3 covered.
- No secrets, PHI, DB/RLS, routes or invented names in diff; path is a role-permitted notes file.
