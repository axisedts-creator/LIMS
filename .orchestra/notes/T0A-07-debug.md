# T0A-07 debug (debugger)
- Cause: verify log has only bsdate failures (T0A-06): `packages/test-fixtures/bsdate/golden-2000-2099.json` missing. Its generate.mjs writes it only once review.json has no unresolved entry (human resolution pending, see T0A-06 notes). No money test fails.
- Fix: none. Money code (TS/Dart/golden) unchanged. Out of T0A-07 scope; fixing needs T0A-06 human review, not a T0A-07 impl change.
- Open: Dart golden test never run (needs approval to run `dart test`).
