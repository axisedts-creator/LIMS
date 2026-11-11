TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)

- Spec says the package's analysis_options.yaml must turn on strict-casts, strict-inference and strict-raw-types (spec/chunks/C0-foundation-contracts/02-TRD.md:167; spec/program/02-CONVENTIONS.md:90). T0A-11 is done only when `dart analyze` is clean (06-IMPLEMENTATION-PLAN.md:57; 05-DEFINITION-OF-DONE.md:8).
- `_cases()` returns `List<Map<String, dynamic>>` (money_golden_test.dart:18), so `c['amountPaisa']!` etc. are `dynamic`. Passing them to `_m(Object)` / `_ints(Object)` (lines 24-25) is an implicit cast, which strict-casts rejects (argument_type_not_assignable, lines 121-135). The spec-required config breaks the test file, so the test has to change, not the implementation.
- Change in packages/shared-dart/test/money_golden_test.dart (tester-owned):
  - line 24: `m.Money _m(Object? n) => m.money(n! as int);`
  - line 25: `List<int> _ints(Object? l) => (l! as List<Object?>).cast<int>();` (also removes the raw `List`, which strict-raw-types would flag)
  - Or cast explicitly at each call site on lines 121-135. Do not change the assertions or the expected values.
- Do not exclude the file in analysis_options.yaml. That would weaken the gate the spec requires.
