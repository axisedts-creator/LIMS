# T-P4 dispute (writer) — 3 app tests fail in the harness, not the screen
Tests (apps/patient_app/test/features/smart/a14_smart_summary_test.dart): "health score value and band label" (l.104), "disclaimer ..." (l.203), "superseded: true ..." (l.229).
Failure: `The finder "Found 0 widgets with text "Open summary"" (used in a call to "tap()")` in smart_fakes.dart:122 on the SECOND `openSummary` of the test.
Cause: each test calls `openSummary` a second time without first resetting the tree (`await tester.pumpWidget(const SizedBox())`). The new `h.scope(...)` reuses the same ProviderScope > MaterialApp elements, so the Navigator keeps the A14 route pushed by the first call; the "Open summary" host page sits under it and cannot be tapped. No screen code can change that.
Proof: the malformed-body test and the loop iterations already reset with `pumpWidget(const SizedBox())` between opens and pass; the first open of each failing test passes its asserts.
Fix (test only): add `await tester.pumpWidget(const SizedBox());` before the second `openSummary` at l.102 (before the loop), l.202 and l.228. Keep every assertion.
Everything else: worker 33/33, API 24/24, app 40/43.
