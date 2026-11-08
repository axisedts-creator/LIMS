# C6-T41 impl
Files: NEW `handlers/regenerate.handlers.ts` (R9), NEW `repository/regenerate.repo.ts`, `service/reports.service.ts` (+regenerateReport), `index.ts` (wired); worker `tasks/assemble_report.ts` (reads payload.regeneration -> Regeneration input + report_versions.regeneration_reason_code/_text). domain/version.ts unchanged (rule 0 already there from T02).
[CONV] assemble_report.ts is a T08 file outside T41's list: edited minimally, as the tester flagged -> lead: widen scope or CR. Malformed payload.regeneration is ignored, not rejected.
[CONV] reason_code checked in-handler against merged active regeneration_reasons (tenant cs_reasons shadows g_cs_reasons); order: ctx -> uuid -> body -> actor user -> assertRole -> lock -> cancelled -> reason -> bump -> enqueue.
Results: worker reporting 579/579 pass; api regenerate.test 53/54 (1 disputed, see C6-T41-dispute.md); manifest/retry-render/domain pass alone. repository.static fails on pre-existing portal.service.ts inline SQL (not T41).
Open: job-key collapse of a queued `assemble:<id>` may drop an earlier reason; no real PG/RLS test.
