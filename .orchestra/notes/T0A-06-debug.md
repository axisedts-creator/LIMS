# T0A-06 debug
- Cause: no impl bug. (a) `golden-2000-2099.json` never generated (needs `test-fixtures/bsdate/generate.mjs`) -> 11 ENOENT fails. (b) `review.json` has 107 `unresolved` entries (B.S. 2084-2097, libs disagree on days/ad_first_day) -> needs named human; done_when requires zero.
- Fix: none applied. Writer's wrappers pass 19/20 vs preview golden. Faking `resolved_by` or generating golden from unresolved data would hide real disagreements.
- Needed: human resolves review.json -> writer applies overrides in TS+Dart -> run generate.mjs, commit golden, run `dart test`.
