# T0A-07 debug (debugger)
- Cause: verify log has only bsdate failures (T0A-06): `packages/test-fixtures/bsdate/golden-2000-2099.json` missing. Its generate.mjs writes it only once review.json has no unresolved entry (human resolution pending, see T0A-06 notes). No money test fails.
- Fix: none. Money code (TS/Dart/golden) unchanged. Out of T0A-07 scope; fixing needs T0A-06 human review, not a T0A-07 impl change.
- Open: Dart golden test never run (needs approval to run `dart test`).

# round 2
- Cause (unchanged): verify fails only in bsdate.test.mjs (T0A-06): `packages/test-fixtures/bsdate/golden-2000-2099.json` missing; generate.mjs writes it only after human resolves review.json. Zero money failures in log.
- Re-ran `node --test packages/shared-ts/test/money.test.mjs`: 19/19 pass. Fix: none; no T0A-07 impl change possible or needed.
- Open: Dart golden test not run (dart needs approval); bsdate fixture needs T0A-06 human review.

# round 3
- Cause (unchanged): only bsdate.test.mjs (T0A-06) fails; golden-2000-2099.json absent until human resolves bsdate/review.json. Zero money failures.
- Re-ran money.test.mjs: 19/19 pass. Fix: none; not a T0A-07 impl issue.
- Open: Dart golden test not run; T0A-06 human review needed.

# round 4
- Cause (changed): verify log now has 12 failures, all `validation.test.mjs` (T0A-08): `src/errors/index.ts` imports `@lims/contracts`, not resolvable (no dep/link in shared-ts; tsconfig excludes errors/validation pending `.orchestra/cr/T0A-08.md`). Zero money failures.
- Re-ran money.test.mjs: 19/19 pass. Fix: none; T0A-08 CR/ownership issue, not a T0A-07 impl change.
- Open: Dart golden test not run; T0A-08 CR needs resolution.

# round 5
- Cause (unchanged from round 4): all 12 verify failures are in `validation.test.mjs` (T0A-08): `src/errors/index.ts` can't resolve `@lims/contracts` (ERR_MODULE_NOT_FOUND). Zero money failures.
- Re-ran money.test.mjs: 19/19 pass. Fix: none; T0A-08 dependency/CR (`.orchestra/cr/T0A-08.md`) issue, not a T0A-07 impl change.
- Open: Dart golden test not run (dart needs approval); T0A-08 CR needs resolution.

# round 6
- Cause (unchanged from round 4/5): all 12 verify failures are in `validation.test.mjs` (T0A-08): `src/errors/index.ts` can't resolve `@lims/contracts` (ERR_MODULE_NOT_FOUND). Zero money failures (0 "money" hits in log).
- Re-ran money.test.mjs: 19/19 pass. Fix: none; T0A-08 dependency/CR issue, not a T0A-07 impl change.
- Open: Dart golden test not run (dart needs approval); T0A-08 CR needs resolution.
