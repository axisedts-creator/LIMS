# HC-T27 dispute (writer)
Test: `__tests__/route_screen_test.dart` "pull to refresh calls onRefresh once" (line 127).
Why wrong: Flutter's `RefreshIndicator` arms only when the drag is >= 25% of the list viewport height. The test fling is 400 px, but `pumpScreen` sets a 800x1800 view, so the route list viewport is ~1690 px and needs ~422 px. The same code refreshes on a 1500 px view (probe: h=1800 -> 0 refreshes, h=1500 -> 1, h=1200 -> 1). No phone screen is 1800 dp tall, so the test only fails because of the fixture size.
Impl: `RefreshIndicator(onRefresh: widget.onRefresh, child: ListView(physics: AlwaysScrollableScrollPhysics))` in `route_screen.dart`; standard behaviour, nothing to fix.
Fix options (tester): fling `Offset(0, 600)` or larger, or use `t.view.physicalSize` height < 1600 for this test. Writer alternative (not done, hack): cap the list height at 1500 dp.
Other results: 73 of 74 HC-T27 tests pass; `flutter test __tests__` 458 pass, this 1 fails; `flutter analyze lib` clean.
