TESTS_WRONG — the test harness does not compile; it asserts nothing the spec could be checked against yet.
Change: in `apps/patient_app/test/support/orders_fakes.dart` add `import 'package:flutter_test/flutter_test.dart';` alongside its other package imports (lines 13–25). No other change to the tests.
Reasons:
- Verified independently: `flutter test` reports `test/support/orders_fakes.dart:120:25 / 126:23 / 133:21: Error: Type 'WidgetTester' not found.`
- Dart imports are not transitive. `auth_fakes.dart:17` imports flutter_test for itself but does not re-export it, and `rig.dart` neither imports nor exports it, so `orders_fakes.dart` must import it directly (the sibling `auth_fakes.dart` does exactly that).
- This is a defect in the test setup, not a spec question. The plan row requires a working "app: polling lifecycle test" (spec/chunks/C16-patient-engagement/06-IMPLEMENTATION-PLAN.md:77), and right now that test cannot run.
- The behaviour the tests assert (30 s foreground polling that stops in background, US-EN-07.6–8, plan :77) is untouched. After the fix, the writer must rerun a10_orders_list_test.dart and a11_order_polling_test.dart. Any behavioural failures then are the implementation's to fix.
- Not affected: orders_source_rules_test.dart and the API orders.handlers.test.ts.
