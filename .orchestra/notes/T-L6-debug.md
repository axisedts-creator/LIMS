# T-L6 debug (debugger)
Only 1 failing test: a9_register_screen_test.dart "Myself segment is RENDERED disabled" (other 135 pass).
Cause: spec 04-UI-UX.md:102 requires Myself disabled; `LimsSegmentedControl` (packages/ui-flutter/lib/src/cr16_widgets.dart:100, not C16-owned) has no per-option disabled. register_screen.dart:304-310 can only ignore the tap.
No impl fix possible: raw `SegmentedButton` in feature code breaks LD-140 + design_rules_test; editing the kit is outside C16 paths. Test is right (spec-backed), so no dispute.
Already filed as item 3 of `.orchestra/cr/T-L6.md` (owner C0-0D, blocking). No code changed. Needs lead to route the CR; then pass `disabled: {'self'}` when `_hasSelf`.
