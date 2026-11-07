# T0A-06 impl (writer, round 3) — LD-08 applied
- Files: `packages/test-fixtures/bsdate/generate.mjs` (LD-08 auto-resolve + comment), `review.json` (107 entries resolved_by "LD-08", resolution = @remotemerge 1.2.7 value, `verify_before_golive: true`), new `golden-2000-2099.json` (1200 months, 200 probes; 107 rows B.S. 2084–2097 carry `verify_before_golive: true`).
- [CONV] Generator now refuses only resolutions that DIFFER from the wrapper (needs override); LD-08 resolutions equal the wrapper, so no wrapper change. Generated with `--today 2026-11-07` (projection_after 2088).
- RAN: `node --test packages/shared-ts/test/bsdate.test.mjs` 20/20 pass.
- NOT run: `dart test test/bsdate_golden_test.dart` (dart command needs approval in this session). nepali_utils `--dart` comparison still not done.
- Open: run Dart side; risk nepali_utils lacks B.S. 2100-01 (2099-12 length). All 107 LD-08 months must be checked against an official calendar before go-live.
