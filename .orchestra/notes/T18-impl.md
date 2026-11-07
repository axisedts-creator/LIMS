# T18 impl (writer)
Files: identity/repository/audit-read.repo.ts (all SQL), identity/service/audit-view.service.ts, identity/handlers/{listAuditEntries,getAuditEntry,listAccessLogEntries,listAuthEvents}.ts + handlers/_audit-view.bind.ts (shared fail-closed glue).
[CONV] Centre clause copied verbatim from the RLS policy (app.has_all_centres() / current_centre_ids()::uuid[], A16.1); tenant_id = $1 everywhere. Keyset (occurred_at, id), cursor = base64url [occurred_at::text, id].
[CONV] Optional filters as `($n IS NULL OR col = $n)`. Display name via LEFT JOIN core.users on (tenant_id, actor_id) for actor_type 'user'.
[CONV] Detail: view logged via ctx.audit.access before return; write failure propagates (D-T3). Bad cursor -> common.validation_failed.
Review item 1 (DELETE action / NULL actor_id rows off-contract): no mapping invented; filed .orchestra/cr/T18.md (CR-C2-T18-a, to C0-0C, blocking). Impl unchanged pending ruling; then add delete/NULL-actor service tests.
Tests: T18-verify.cmd 3 files, 99/99 pass (re-run 2026-11-07 20:44; no ruling on CR-C2-T18-a yet, identity.yaml still enum [insert, update] / required [type, id], so code left unchanged per review). tsc: only pre-existing shared-ts/bsdate TS5097.
Open: CR-C2-T18-a; no live Postgres/EXPLAIN run; HTTP manifest not wired.
