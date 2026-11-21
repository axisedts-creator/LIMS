# HC-T27 debug (debugger)
Failing: route_screen_test.dart "first pull: LimsLoading shows..." — `pumpAndSettle timed out` in pumpScreen (visit_fixture.dart:157).
Cause: spec 03-APP-FLOW:117 requires LimsLoading on first pull; LimsLoading = indeterminate CircularProgressIndicator (ui-flutter base_widgets.dart:268), animates forever, so pumpAndSettle can never settle. Impl (route_screen.dart) is correct; test is wrong.
Fix: none in impl (freezing spinner would break real loading state). Dispute stands: .orchestra/notes/HC-T27-dispute.md (loading case must use pumpWidget + pump, not pumpAndSettle). Stopped per rules.
