# T0D-UI-R05 impl (LD-140, 10-DESIGN-SYSTEM s5)
- theme.dart: font Plus Jakarta Sans first (+ Devanagari, packages/lims_ui/ spellings, Noto Sans last); CardTheme white/radiusLg/elevation 0; Filled/Outlined/Text button themes pill (StadiumBorder) + 48 min.
- base_widgets.dart: new `LimsPressScale` (Listener + AnimatedScale .96, motion.duration.fast, easing from tokens, zero duration when disableAnimations) [CONV]; LimsButton pill + wrapped, disabled = no scale.
- cr16_widgets.dart: LimsBottomNav current tab = accent.highlight pill (radiusFull) around icon+label, accent.default text; each item press-scaled.
- Goldens re-recorded: status_chips, cr16_widgets; new restyle_buttons, restyle_card_nav.
- Verify set (6 files): 80/80 pass. Full `flutter test`: 99 pass, 2 fail = dependency_pins_test.dart (pre-existing, per tester note).
- LD-155: added packages/ui-flutter/.gitignore = `test/failures/`; verify set re-run 80/80 pass.
- Open: LimsPressScale is exported publicly (apps may reuse); dark mode out of scope.
