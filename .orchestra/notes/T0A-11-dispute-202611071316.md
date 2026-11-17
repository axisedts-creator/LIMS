# T0A-11 dispute (writer)
- `dart analyze --fatal-infos` (step 1 of T0A-11-verify.cmd, done_when "dart analyze clean") fails with 11 errors, all in `test/money_golden_test.dart:121-135` (T0A-07 test, not writer-editable):
  `The argument type 'dynamic' can't be assigned to the parameter type 'Object'. - argument_type_not_assignable`
- Why the test is wrong: `c` is `Map<String, dynamic>`, so `c['amountPaisa']!` is `dynamic`; under CV §1.3 `strict-casts: true` (now active via the required package `analysis_options.yaml`) passing it to `_m(Object n)` / `_ints(Object l)` is an implicit cast. Code is otherwise correct (runtime: all 43 tests pass).
- Fix (tester): change helpers to `m.Money _m(Object? n) => m.money(n! as int);` and `List<int> _ints(Object? l) => (l! as List<Object?>).cast<int>();` (same shape as public_api_test.dart), or cast at call sites.
- Not done by writer: excluding the file in analysis_options would weaken the gate.
