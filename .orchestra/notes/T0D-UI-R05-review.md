TESTER: packages/ui-flutter/test/goldens/status_chips.png and cr16_widgets.png are still the pre-restyle bytes (the debugger measured 100% pixel difference against the restyled render). The debugger regenerated both three times and the harness reverted them each time (REVERT lines in the C0 log at 14:32:53/54) because test/goldens is a test path, so only you may change them.
1. From packages/ui-flutter run: flutter test --update-goldens test\golden_widgets_test.dart test\restyle_r05_test.dart
2. Look at the two regenerated PNGs and confirm the only differences are the R05 restyle of the status chips and CR-16 widgets; if anything else changed, say so in the note instead of keeping them.
3. Re-run the command in T0D-UI-R05-verify.cmd and confirm it passes (the debugger saw 80/80 on the affected set).
4. Do not edit any assertion; both PNGs must stay in your commit.
WRITER: no change.
