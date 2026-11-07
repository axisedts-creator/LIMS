# T18 impl (writer)
Files: identity/repository/audit-read.repo.ts (all SQL), identity/service/audit-view.service.ts, identity/handlers/{listAuditEntries,getAuditEntry,listAccessLogEntries,listAuthEvents}.ts + handlers/_audit-view.bind.ts; contracts/openapi/identity.yaml (LD-64 cross-lane exception).
[CONV] Centre clause copied verbatim from the RLS policy (app.has_all_centres() / current_centre_ids()::uuid[], A16.1); tenant_id = $1 everywhere. Keyset (occurred_at, id), cursor = base64url [occurred_at::text, id].
[CONV] Detail: view logged via ctx.audit.access before return; write failure propagates (D-T3). Bad cursor -> common.validation_failed.
LD-64 / CR-C2-T18-a applied: action enum [insert, update, delete] on AuditEntrySummary, AuditEntry and listAuditEntries ?action (service filter now accepts delete); AuditActor required [type]; actor.id omitted via compact() when actor_id IS NULL. No maintenance property. No codegen script exists in repo; nothing regenerated.
Tests 2026-11-08: T18-verify.cmd 3 files 99/99 pass; contracts suite 250/250 pass.
Open: no delete / NULL-actor service tests (writer may not edit tests; tester to add); no live Postgres/EXPLAIN; HTTP manifest not wired; PR to main needs cr-approved-breaking label.
