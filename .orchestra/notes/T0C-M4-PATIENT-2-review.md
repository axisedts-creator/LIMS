APPROVE
# T0C-M4-PATIENT-2 review (reviewer)
Diff 85f8b2777..HEAD: 19 files (<= 24). lib changes in profiles/orders/reports/payments only, plus new orders/status_look.dart (ToneChip, StateCard); 3 new test files; no existing test edited; no packages/ui-flutter, spec or route/API/storage edits.
Restyle only: wrappers (LimsCard / StateCard / Card) around existing widgets; strings, providers, idempotency key, LimsSecureScreen, secure temp file, error-code switch on A13 unchanged. A13 share IconButton gains semanticLabel + 48 dp constraints (a11y, not behaviour). A11 empty timeline now hidden (presentation). A14 Row->Wrap fixes 1.3 overflow.
Status chips: ToneChip adds a tone icon next to the text chip (10-DESIGN-SYSTEM 2.6); colours via limsTone, no hex literals, radius via LimsTokens.
No PHI in logs (no new logging), no secrets, no invented content; board-only elements listed as gaps in impl note. RLS/permissions/rate tier n/a (client restyle).
Checks run: `flutter test` in apps/patient_app = +1177 All tests passed. `flutter analyze` on touched dirs: no issue in touched files (9 pre-existing info/warnings in untouched test/support/*_fakes.dart).
Non-blocking: harness lives in test/support/ (brief says test/features/**; same pattern as PATIENT-1). Open item from impl note (A10/A12 not filtered by selected profile) is out of restyle scope; founder follow-up. Eye check vs board not done (founder).
