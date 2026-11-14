# T-L6 debug (debugger)
Only 1 failing test: a9_register_screen_test.dart "Myself segment is RENDERED disabled" (other 135 pass).
Cause: spec 04-UI-UX.md:102 requires Myself disabled; `LimsSegmentedControl` (packages/ui-flutter/lib/src/cr16_widgets.dart:100, not C16-owned) has no per-option disabled. register_screen.dart:304-310 can only ignore the tap.
No impl fix possible: raw `SegmentedButton` in feature code breaks LD-140 + design_rules_test; editing the kit is outside C16 paths. Test is right (spec-backed), so no dispute.
Already filed as item 3 of `.orchestra/cr/T-L6.md` (owner C0-0D, blocking). No code changed. Needs lead to route the CR; then pass `disabled: {'self'}` when `_hasSelf`.

## Round 2
Re-checked: verify log still shows the same single failure (a9 test line 129, 135 others pass). `cr16_widgets.dart` still has no per-option disabled, so cause and conclusion are unchanged. No code edited; blocked on CR item 3 (C0-0D) being applied to the kit.

## Round 3
Re-checked: kit still has no per-option disabled (`cr16_widgets.dart` no match), CR `.orchestra/cr/T-L6.md` item 3 still unapplied. Same single failure (a9 Myself disabled). No code edited; blocked on C0-0D CR.
