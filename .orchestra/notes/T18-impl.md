# T18 impl (writer)
Files: identity/repository/audit-read.repo.ts (all SQL), identity/service/audit-view.service.ts, identity/handlers/{listAuditEntries,getAuditEntry,listAccessLogEntries,listAuthEvents}.ts + handlers/_audit-view.bind.ts (shared fail-closed glue).
[CONV] Centre clause copied verbatim from the RLS policy (app.has_all_centres() / current_centre_ids()::uuid[], A16.1), not passed as params; tenant_id = $1 everywhere.
[CONV] Keyset (occurred_at, id) with a sentinel bound when no cursor (NIL / ffff uuid) -> one statement per list; cursor = base64url [occurred_at::text, id] so µs precision survives (pg Date is ms).
[CONV] Optional filters as `($n IS NULL OR col = $n)` (unnamed statements -> custom plans). Display name via LEFT JOIN core.users on (tenant_id, actor_id) for actor_type 'user' (APP-FLOW says "via core.memberships"; same tenant, same result).
[CONV] Detail: view logged via ctx.audit.access before return; write failure propagates (D-T3). Bad cursor -> common.validation_failed (tests), not common.invalid_cursor.
Tests: service 64/64, static 16/16 pass; handlers 15/19 fail on a test-loader bug -> T18-dispute.md (all pass with static imports).
Open: DB action 'DELETE' / NULL actor_id (maintenance rows) would not fit AuditEntrySummary (enum insert|update, actor.id required); no live Postgres/EXPLAIN run; HTTP manifest not wired.
