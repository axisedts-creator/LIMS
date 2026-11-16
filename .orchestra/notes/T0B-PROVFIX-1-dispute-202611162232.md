# T0B-PROVFIX-1 dispute (writer)
The tests are consistent with the brief, but the brief's premise is wrong, so green tests do NOT clear the staging barrier.
- Inside ctx.db.withTenantScope the claims are replaced by {sub: identity system actor, actor_type: 'system', tenant_id} (services/api/src/core/db/tx.ts:186).
  app.is_platform_actor() needs scope='platform', aal2 and a platform_staff row for sub -> FALSE inside the scope.
- identity.ird_annex_records has ONE insert policy, ird_annex_records__insert__platform (is_platform_actor()). So the INSERT inside the scope is
  refused by RLS (42501 -> "Not found"), just on ird_annex_records instead of audit_log.
- Outside the scope, audit_log__insert__owner_only refuses the audit row (the staging error). No placement works without a DB change.
- Code was moved inside the scope as ordered (tests 177/177 green). A DB change is required: blocking CR .orchestra/cr/T0B-PROVFIX-1.md
  (recommended option 1: A12.5-style audit_log clause for identity.ird_annex_records, then move the call back outside; the tester's
  "first inside the scope" test would then need the reverse rule). Do NOT tell the founder to retry until the CR lands.
