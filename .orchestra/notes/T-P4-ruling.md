TESTS_WRONG — the second `openSummary` in three tests runs on a tree still holding the A14 route from the first open, so "Open summary" cannot be tapped; the spec does not require a pushed route to vanish when the host page is re-pumped.
Change (test file apps/patient_app/test/features/smart/a14_smart_summary_test.dart only): add `await tester.pumpWidget(const SizedBox());` immediately before the second `openSummary` at l.102 (before the band loop), l.202-203 (disclaimer default) and l.228-229 (superseded default). Keep every assertion unchanged.
Reasons:
1. smart_fakes.dart:84-92 `scope()` builds ProviderScope > MaterialApp with no keys, so a re-pump reuses the same elements; the Navigator keeps the route pushed at smart_fakes.dart:116 and the tap at :122 finds 0 widgets. This is harness state, not screen behaviour.
2. The same file already resets the tree between opens (l.92, l.106) and those passes show the reset is the intended pattern.
3. What the tests check stays required by the spec: content and disclaimer exactly as returned (01-PRD.md:216, US-EN-09.2); older version shown as superseded (01-PRD.md:218, US-EN-09.4); label "Replaced by a newer version" (04-UI-UX.md:125).
4. Nothing in 01-PRD.md:214-218 or 06-IMPLEMENTATION-PLAN.md:79 (row T-P4) asks a screen to pop routes it did not push, so no implementation change can fix this.
