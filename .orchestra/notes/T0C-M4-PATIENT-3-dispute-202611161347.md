# T0C-M4-PATIENT-3 dispute (writer)
Test: m4_booking_membership_test.dart:266 "A18 keeps items with indicative prices, [Cancel], [Reschedule] ..." expects `find.widgetWithText(LimsButton, 'Cancel')` (exact text).
Conflict: the A18 button label is "Cancel booking" and the EXISTING test test/features/bookings/a16_a18_bookings_test.dart:124-199 (8 uses of `btn('Cancel booking')`) locks that label. The brief says existing tests stay green unchanged and the task is restyle only (no wording change); the writer may not edit tests.
04-UI-UX A16/A18 writes the control as "[Cancel]" (a control name, the same notation as "[Reschedule]"), which the existing label satisfies.
Fix asked of the tester: line 266 -> `find.widgetWithText(LimsButton, 'Cancel booking')` (or `find.ancestor(of: find.textContaining('Cancel'), ...)`). Everything else of the task passes: 411 of 412 in the two M4 files.
