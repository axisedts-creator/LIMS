# T0A-06 debug
- Cause: no impl bug. (a) `golden-2000-2099.json` never generated (needs `test-fixtures/bsdate/generate.mjs`) -> 11 ENOENT fails. (b) `review.json` has 107 `unresolved` entries (B.S. 2084-2097, libs disagree on days/ad_first_day) -> needs named human; done_when requires zero.
- Fix: none applied. Writer's wrappers pass 19/20 vs preview golden. Faking `resolved_by` or generating golden from unresolved data would hide real disagreements.
- Needed: human resolves review.json -> writer applies overrides in TS+Dart -> run generate.mjs, commit golden, run `dart test`.
- Round 2 recheck: state unchanged (golden still absent, review.json still unresolved, only generate.mjs + review.json in test-fixtures/bsdate). Still no impl bug; no code edited. Blocked on human.
- Round 3 recheck: unchanged. golden absent, review.json 107 unresolved / 0 resolved, tree clean. No impl bug; no code edited. Still blocked on human resolving review.json.
- Round 4 recheck: verify.log failures are all `validation.test.mjs` (T0A-08): `Cannot find package '@lims/contracts'` — T0C-02/T0C-05 not present, see `.orchestra/cr/T0A-08.md`. Not T0A-06 impl; no code edited.
- bsdate state unchanged: golden absent (11 ENOENT), `review.json` 107 unresolved. FY test ruling (TESTS_WRONG) is for tester to apply. Still blocked on human resolving review.json.
- Round 5 recheck: unchanged. golden absent, review.json 107 unresolved / 0 resolved. verify.log failures are validation.test.mjs (`@lims/contracts` missing, T0A-08 CR). No impl bug; no code edited. Blocked on human resolving review.json.
- Round 6 recheck: unchanged. golden absent, review.json 107 unresolved (resolved_by null). verify.log has no bsdate failures; all are validation.test.mjs (`@lims/contracts` missing, T0A-08 CR). No impl bug; no code edited. Blocked on human resolving review.json.
