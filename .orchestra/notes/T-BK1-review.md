APPROVE
- Scope reviewed: `git diff 3f0654f7..HEAD`. The only code change is the test edit in apps/patient_app/test/features/bookings/a19_addresses_test.dart:41-43. Everything else in the range is orchestra notes (impl/ruling/dispute rename).
- The test edit matches T-BK1-ruling.md exactly: it unmounts with `pumpWidget(const SizedBox())`, keeps every assertion (LimsEmptyState findsOneWidget) and adds `addressListCalls.length == 2`. The field exists in test/support/bookings_fakes.dart:115. No assertion was weakened. No implementation change is in the range, so there is nothing new for names, RLS, permissions, idempotency, error codes, PHI or secrets.
- Ran `flutter test test/features/bookings`: 77/77 pass.
- Not checked here: the 456f623e implementation (it was outside this range). The open items in T-BK1-impl.md still stand: a CR for `sex` on E13 Profile, the LimsSlotPicker "9+" label against the E32 cap, and real Postgres RLS not being exercised.
