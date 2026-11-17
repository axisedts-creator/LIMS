IMPLEMENTATION_WRONG — the static test is right; tests/load/reporting-load.js and tests/e2e/reporting-journey.e2e.ts (the task's deliverables) must be rewritten to the spec routes.
- The dispute raises no spec objection to any pin (writer: "The static test is spec-correct"); it is an ownership/harness (run.ps1) blocker, which is a lead decision, not a spec ruling.
- Bulk release must POST /v1/reporting/report-versions/bulk-release with body {ids} + Idempotency-Key (spec/chunks/C6-reporting-delivery/02-TRD.md:565 R7); current code posts /report-versions/release with {report_version_ids}.
- Delivery must POST /reports/{report_id}/deliveries with Idempotency-Key (02-TRD.md:584 D3); POST /v1/reporting/deliveries does not exist (D1 is GET only, 02-TRD.md:582).
- QR verify body field is qr_token, not token (02-TRD.md:674 Q1).
- No invented /render route; only R8 retry-render (02-TRD.md:566) or R9 regenerations; test-support routes only with .orchestra/cr/C6-T34.md filed.
- Portal calls use /v1/reporting/portal/ prefix and X-Lims-Portal-Credential header, not Bearer / bare /portal (02-TRD.md:231, :636; 03-IC.md:2437 P7).
- Order lookup via R2 POST /reports/search with PHI in body, not ?order_id= in URL (02-TRD.md:560).
- Held-dues step must assert link_purpose dues + reporting.release_blocked_due (02-TRD.md:385; 03-IC.md:2575); load setup must throw when tokens.length is 0.
- Process note for lead: since run.ps1 reverts writer edits under tests/, either route items 1–10 (content per C6-T34-debug.md round 2) to the TESTER, or add tests/(load|e2e) non-*.test.* files to $TestExempt.
