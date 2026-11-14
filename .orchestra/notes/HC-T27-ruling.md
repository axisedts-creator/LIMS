TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)
Reasons:
1. Spec requires only that the route list supports pull-down refresh: spec/chunks/C17-home-collection/03-APP-FLOW.md:117 (empty state "No visits assigned for today. Pull down to refresh."). It sets no drag distance and no viewport size.
2. Impl uses standard `RefreshIndicator` + `AlwaysScrollableScrollPhysics` (route_screen.dart), which meets that requirement; writer probe shows 1 refresh at view heights 1500/1200.
3. Failure comes from the fixture: `__tests__/support/visit_fixture.dart:149` sets an 800x1800 view, so a 400 px fling at `__tests__/route_screen_test.dart:129` is below RefreshIndicator's arm distance (~25% of a ~1690 px viewport). That is a test-geometry artefact, not a spec gap.
4. Change in the test (route_screen_test.dart:129): fling far enough for any viewport, e.g. `await t.fling(find.byType(ListView).first, const Offset(0, 800), 1000);` then `await t.pumpAndSettle();` — keep `expect(refreshes, 1)` unchanged. Do not change the shared fixture size (other tests depend on it) and do not cap list height in the implementation.
