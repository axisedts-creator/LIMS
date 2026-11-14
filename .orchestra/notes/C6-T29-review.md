APPROVE

Scope: `git diff e16160e8..HEAD` = migration 20261105001900 (edited in place per LD-77) + impl note.
- Matches LD-77 item by item: signature unchanged; RETURNS uuid; v_n dropped; all 5 reject paths RETURN NULL (token GUC reset kept on the lookup-miss path; early guard returns before any GUC set); PERFORM app.enqueue_job removed; three set_config(..., '', true) resets then RETURN v_tenant; lims_queue GRANT block + its comment removed. Nothing else in db/ touched.
- No JWT claims set in DEFINER (LD-49). Owner/REVOKE/GRANT lims_api unchanged. No PHI/secrets.
- Caller consistent: callbacks.repo.ts maps non-string to null; callbacks.service.ts throws the single reporting.callback_rejected (done_when: identical 400) and enqueues `pe:<tenant>` inside withTenantScope(tenant, systemActorOf('reporting')).
- Ran: `node --test --test-name-pattern="lookup DEFINERs|LD-49" tests/db/T0B-10.C6.reporting.test.mjs` -> 3/3 pass. pgTAP (behaviour.test.sql:346-363, schema.test.sql:171) not run (no PG).
Non-blocking (outside writer's allowed db/ edits per LD-77): db/meta/definer-inventory.yaml:135 "why" still says "enqueues reporting.apply_provider_events"; spec 05-SCHEMA §6.2 / 02-TRD §6.7 need an addendum. Route to lead. DBs that already applied the old migration must be rebuilt.
