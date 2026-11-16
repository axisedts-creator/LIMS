TESTS_WRONG — the test asserts an exact button label "Cancel" the spec does not require; it must match the existing label "Cancel booking".
Reasons:
1. spec/chunks/C16-patient-engagement/04-UI-UX.md:137 writes the A18 control as "[Cancel]" — bracket notation names a control (same as "[Reschedule]"), not a verbatim label; the quoted strings on that line ("You can cancel in the app until {cancellable_until}") are the only verbatim text.
2. Task brief (T0C-M4-PATIENT-3 done_when): restyle only, no behaviour/wording change, "every string stays an existing localisation key or the spec wording", existing tests change only for the presentation change.
3. Existing test apps/patient_app/test/features/bookings/a16_a18_bookings_test.dart:124-199 locks label "Cancel booking" (lib/features/bookings/booking_detail_screen.dart:235); renaming it would break that test and change wording, which the brief forbids.
Change in apps/patient_app/test/features/m4/m4_booking_membership_test.dart:
- line 266: `find.widgetWithText(LimsButton, 'Cancel')` -> `find.widgetWithText(LimsButton, 'Cancel booking')` (findsOneWidget).
- line 275: same replacement (findsNothing); with 'Cancel' it passes vacuously and does not prove the button is hidden.
Implementation stays as is.
