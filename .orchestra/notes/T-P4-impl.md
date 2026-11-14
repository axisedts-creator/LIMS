# T-P4 impl (writer) — done; app dispute resolved by T-P4-ruling.md (tests revised)
- Files: worker `tasks/fetch_smart_summary.ts` (+ manifest), api `service/report.service.ts` + `handlers/report.handlers.ts` (E24), app `lib/features/reports/smart/` smart_summary_{api,providers,screen,entry}.dart (A14 + A13 hook).
- Results: worker 33/33 (after ruling), API 24/24, app 43/43 (after second ruling), `flutter analyze` clean on smart/.
- [CONV] reason_code `follow_up_test`; snapshot approved without approvedAt / templateLibraryVersion or > 256 KiB: skipped, not retried; other port errors -> common.dependency_unavailable.
- [CONV] summary `ON CONFLICT DO NOTHING` then SELECT id; reminders `ON CONFLICT DO NOTHING` on the partial unique.
- [CONV] A14 tones (LD-140 tone+icon+word): in_range/good/improved success, borderline/fair/worsened warning, out_of_range/needs_attention danger, critical critical, stable neutral. Unknown words not shown; wrong-shaped body = error state.
- [CONV] A14 not_found = LimsEmptyState "No smart summary" (no retry); other failures = LimsErrorState with Retry; no server text.
- Open: past-due reminder check (spec silent); E1 `features.smart_report` hiding in app (no config provider); router/A13 embedding of SmartSummaryEntry.
