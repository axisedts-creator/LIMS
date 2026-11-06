# T0A-06 impl (writer, round 2) — BLOCKED on human review of review.json
- Files: round 1 (TS `src/bsdate/{impl,index}.ts`, pins, `test-fixtures/bsdate/{generate.mjs,review.json}`) + new `packages/shared-dart/lib/src/bsdate/bsdate.dart`.
- TS vs local `--preview` golden (deleted after): 19/20 pass, incl. revised l.168 Ashadh test. Only fail: review.json 107 unresolved (B.S. 2084–2097) — by design.
- Dart: NOT run (dart needs approval). nepali_utils comparison + `--dart` dump still not done.
- [CONV] Dart builds month table once from `NepaliDateTime(y,m,1).toDateTime()` 1975-01..2100-01, then UTC day-number arithmetic (no DST drift). `BsDateError{code}` until LimsException (T0A-08). FY startsOn/endsOn getters throw out_of_range at table edges (same as TS).
- Open: human (founder/delegate) resolves review.json; then apply overrides in both wrappers, run `generate.mjs`, commit golden, run `dart test`. Risk: nepali_utils may lack B.S. 2100-01 (needed for 2099-12 length).
