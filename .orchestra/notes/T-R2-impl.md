# T-R2 impl (W9 Reminders) — round 3, 2026-11-13. Run: `.orchestra\notes\T-R2-verify.cmd` → 33/33 pass (2 files).
- Files (apps/web/src/app/(staff)/engagement/reminders/): reminders.server.ts, page.tsx, RemindersView.tsx. CR: .orchestra/cr/T-R2.md (R1 `kind?`, non-blocking).
- Review items 1–4 applied (Kathmandu day-bound instants, 92-day inclusive cap, T3a reasons, Kind filter [CONV], 409 Banner + Reload). Ruling = test-only.
- Round 3: Filters skip navigation when the typed range equals the last applied range (fixes "92 accepted; 93 rejected" — re-typing From re-sent the old range).
- LD-140: cited in RemindersView header; only @lims/ui components + kit classes (lims-inline, lims-error); no hex, px radii or inline styles; one primary per page.
- tsc: impl clean; test file has TS2353 at t-r2.reminders.test.tsx:81 (`onUnhandledRequest`) — tester's file.
- Open: R1 Reminder has no patient_display (fallback "Patient …<id tail>"); R4 panel not built (T-P4 missing).
