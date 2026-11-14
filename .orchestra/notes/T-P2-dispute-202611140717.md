# T-P2 dispute (writer)
- `apps/patient_app/test/support/orders_fakes.dart` uses `WidgetTester` (lines 120, 126, 133: `openDetail`, `openList`, `elapse`) but imports no `package:flutter_test/flutter_test.dart` (its imports: dart:async, material, riverpod, lims_ui, patient_app providers/orders, auth_fakes, rig). Neither `auth_fakes.dart` nor `rig.dart` re-exports it.
- Result: `a10_orders_list_test.dart` and `a11_order_polling_test.dart` fail to COMPILE: `test/support/orders_fakes.dart:120:25: Error: 'WidgetTester' isn't a type.` Not caused by missing implementation: `lib/features/orders/*` now exists and `flutter analyze lib/features/orders` is clean.
- Fix (tester): add `import 'package:flutter_test/flutter_test.dart';` to `orders_fakes.dart`. Test files are not writer-editable, so A10/A11 behaviour (27 tests) is NOT verified yet.
- Unaffected: `orders_source_rules_test.dart` 15/15 pass; API `orders.handlers.test.ts` 32/32 pass.
