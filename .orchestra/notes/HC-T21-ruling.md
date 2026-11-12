TESTS_WRONG — the test asserts something the spec does not require (and that does not compile)
- Spec requires only that the app uses `LimsTheme.light` (spec/chunks/C17-home-collection/04-UI-UX.md:101; 02-TRD.md:136 "lib/app/ ... LimsTheme"). No spec line requires comparing a `fontFamily` property.
- `ThemeData` exposes no `fontFamily` getter (it is a constructor-only argument folded into `textTheme`), so `app_skeleton_test.dart:130` is a compile error that makes the whole file (flavours, LD-24, router, theme tests) unrunnable.
- Change in test (tester): replace line 130 with
  `expect(app.theme?.textTheme.bodyMedium?.fontFamily, LimsTheme.light().textTheme.bodyMedium?.fontFamily);`
  Keep line 129 (`colorScheme.primary`) unchanged. Do not weaken any other assertion.
- Implementation needs no change for this point; writer re-runs the full file after the tester fix.
