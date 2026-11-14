TESTS_WRONG — the test name string has an unescaped `$` that will not compile; the assertions themselves are correct.
Reasons:
- apps/phlebo_app/__tests__/visit_collect_test.dart:167 (the dispute says :168): the name `'manual field: max 20 chars, pattern ^[A-Z0-9]{1,20}$'` ends in a bare `$` followed by `'`. Dart treats `$` as the start of an interpolation, so this is a compile error and the whole file fails to load. M6 has no test coverage until it is fixed.
- The behaviour the test checks is required by the spec: spec/chunks/C17-home-collection/04-UI-UX.md:119 says "Type barcode" → `LimsTextField` max 20, uppercase, pattern `^[A-Z0-9]{1,20}$`. spec/chunks/C17-home-collection/02-TRD.md:369 gives the `scanned_barcode` pattern `^[A-Z0-9]{1,20}$`.
- Fix (tester): change only the name string. Either escape the dollar sign (`...{1,20}\$'`) or use a raw string (`r'manual field: max 20 chars, pattern ^[A-Z0-9]{1,20}$'`). Do not change the test body, the keys or the expectations.
