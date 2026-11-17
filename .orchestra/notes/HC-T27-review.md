APPROVE
Scope: `git diff c4238880..HEAD` = test harness change in apps/phlebo_app/__tests__/route_screen_test.dart (owned path) + orchestra note renames/updates. No lib/ change.
- Matches arbiter ruling (HC-T27-ruling.md): `settle` option added; loading path sets the same 800x1800 view, theme and textScaler builder as pumpScreen, pumpWidget + one pump; visit_fixture.dart pumpScreen untouched; expects at route_screen_test.dart:180-183 unchanged; refresh fling at :145 is 800 px per the earlier ruling.
- No feature code freezes/replaces LimsLoading (LD-140 respected).
- No names invented, no PHI (synthetic "Test Patient" only), no secrets. Backend items (RLS, rate tier, error codes) not touched by this diff.
- Verified: `flutter test __tests__/route_screen_test.dart` -> 16/16 pass (2026-11-14).
