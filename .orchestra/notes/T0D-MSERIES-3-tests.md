# T0D-MSERIES-3 tests (tester)
Files (packages/ui-flutter/test): `mseries3_test.dart` (new), `restyle_r05_test.dart` and `tokens_theme_test.dart` (Metro Green values replaced by 13-M-SERIES values: #F3F3F3, #005A52, radius 24, Poppins, 48 dp; nothing weakened), `golden_widgets_test.dart` (unchanged; fails until goldens are re-recorded).
Run: `.orchestra\notes\T0D-MSERIES-3-verify.cmd` from the repo root (= `flutter test` of those four files inside packages/ui-flutter).
Fail now for the right reason: Poppins not in pubspec/assets/licence, Plus Jakarta Sans still present, theme font not read from `LimsTokens.fontFamilySans`, card/dialog radius 16 not 24, no input theme, nav label on lime 3.90:1, no 450 ms enter motion, 4 goldens not re-recorded (hash check vs the committed Metro Green PNGs).
Implementer: Poppins TTF (not woff2) 400/500/600/700 + OFL text in assets/fonts; run `flutter test --update-goldens` for the four PNGs in test/goldens; label/icon on lime use a token (neutral.900 as on web), not accent.default.
ASSUMED API (spec names none): enter motion is on `LimsCard` (fade over `LimsTokens.motionDurationNormal`, none when `MediaQuery.disableAnimations`). Say so in a CR if you place it elsewhere.
Not mine, failing before this task: `dependency_pins_test.dart` (2 tests: pin table rows), not in the verify.
