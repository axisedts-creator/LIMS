# HC-T21 dispute (writer)
`apps/phlebo_app/__tests__/app_skeleton_test.dart:130` does not compile on Flutter 3.47.9: `ThemeData` has no `fontFamily` getter
(`app.theme?.fontFamily`, `LimsTheme.light().fontFamily`). The whole file fails to load, so all its tests (flavours, LD-24, router, theme) are unrunnable.
Fix (tester): compare `theme.textTheme.bodyMedium?.fontFamily` instead (or drop the line; `colorScheme.primary` already covers the theme).
All other test files pass (38 tests); impl for the skeleton files is written and awaits this fix to be verified.
