TESTS_WRONG — the assertions are correct, but the test requires the indeterminate `LimsLoading` spinner to settle, which the spec does not require.
1. spec/chunks/C17-home-collection/03-APP-FLOW.md:117: Route (today) empty copy "No visits assigned for today. Pull down to refresh."; loading state "first pull: `LimsLoading`". The test's expects at route_screen_test.dart:168-171 match this line exactly. Keep them.
2. The spec does not say the loading state must be finite. `LimsLoading` (packages/ui-flutter/lib/src/base_widgets.dart:268-279) is a `CircularProgressIndicator` with no end, so `pumpScreen`'s `pumpAndSettle` (__tests__/support/visit_fixture.dart:157) always times out. The failure comes from the test harness, not the implementation.
3. LD-140 says to build screens only from lims_ui components. Feature code must not freeze or replace `LimsLoading` (for example with TickerMode off) to get past this.
Change to make in apps/phlebo_app/__tests__/route_screen_test.dart only:
- Add a `settle` option to `open` (default true). When `loading: true`, do not call `pumpScreen`'s `pumpAndSettle`. Set the view size as pumpScreen does, then call `t.pumpWidget(MaterialApp(...same theme/builder...))` followed by one `await t.pump();`.
- Keep line 168-169 expects as they are. The second `open(t, const [])` (line 170) keeps the normal settling path, and its expect at 171 stays.
- Do not change `pumpScreen` in visit_fixture.dart, because other suites depend on it.
