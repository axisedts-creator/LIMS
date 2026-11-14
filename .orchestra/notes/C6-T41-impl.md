# C6-T41 impl
Files: NEW `handlers/regenerate.handlers.ts` (R9), NEW `repository/regenerate.repo.ts`, `service/reports.service.ts` (+regenerateReport), `index.ts` (wired); worker `tasks/assemble_report.ts` (reads payload.regeneration -> Regeneration input + report_versions.regeneration_reason_code/_text). domain/version.ts unchanged (rule 0 already there from T02).
[CONV] assemble_report.ts is a T08 file outside T41's list: edited minimally, as the tester flagged -> lead: widen scope or CR. Malformed payload.regeneration is ignored, not rejected.
[CONV] reason_code checked in-handler against merged active regeneration_reasons (tenant cs_reasons shadows g_cs_reasons); order: ctx -> uuid -> body -> actor user -> assertRole -> lock -> cancelled -> reason -> bump -> enqueue.
Results (after ruling, no code change): verify.cmd api 104/104, worker 78/78; tsc clean on touched files. repository.static fails on pre-existing portal.service.ts inline SQL (not T41).
Review #1: no code change (the spec has no column to hold the reason). Filed `.orchestra/cr/C6-T41.md` (CR-C6-028, blocking): add nullable `reports.pending_regeneration_reason_code/_text`. Note: `app.enqueue_job` uses `unsafe_dedupe`, not `replace`, so R9 loses to a job already queued. Re-run after review: api 104/104, worker 79/79.
Open: release of T41 is blocked on CR-C6-028. No real PG/RLS test.
