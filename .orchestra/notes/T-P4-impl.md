# T-P4 impl (writer) — PARTIAL, blocked by test dispute (see T-P4-dispute.md)
- Files: `services/worker/src/jobs/engagement/tasks/fetch_smart_summary.ts` (new; manifest wired in `index.ts`), `service/report.service.ts` (+ `smart` E24), `handlers/report.handlers.ts` (+ getMySmartSummary).
- API `reports.smart.handlers.test.ts`: 24/24 pass. Worker test: 18 pass / 15 fail, all 15 caused by the test fixture (fake port never sees the seeded report). App A14 (`lib/features/reports/smart/**`): not started.
- [CONV] reason_code `follow_up_test`; snapshot approved without valid approvedAt / templateLibraryVersion, or > 256 KiB: skipped, not retried; port errors other than common.not_found are rethrown as generic common.dependency_unavailable (no message echo).
- [CONV] summary insert `ON CONFLICT DO NOTHING` then SELECT id (retry keeps the first copy); reminders `ON CONFLICT DO NOTHING` on the partial unique.
- Open: dispute in T-P4-dispute.md; no past-due check on reminder due_at (spec silent).
