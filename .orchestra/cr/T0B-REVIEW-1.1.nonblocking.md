Title: CR-C0-T0B-REVIEW-1-001: reporting.provider_events UPDATE by lims_app (LD-232 item 2; audit item 2)
From chunk: C0 (lane C0-0B, T0B-REVIEW-1)            To owner: C0-0B (lead; founder yes needed, policy change)
Type: security (narrowing)
Blocking? no (LD-232: report only; no migration, policy, grant, test or code was changed)

## Intent
- C0 01-PRD AC-0B-4.3: class A tables `audit.audit_log`, `audit.access_log`, `core.event_log`, every `<m>.event_inbox` must have no `lims_app` UPDATE. `reporting.provider_events` is NOT in that list.
- C6 05-SCHEMA §1 table inventory: `reporting.provider_events` is "A (one lifecycle column)"; §2.10 heading "provider_events (A + `applied_at`, `delivery_id`)"; §3 trigger table: `enforce_mutable_columns` on applied_at, delivery_id, ignored_reason "(NULL → value)"; §5 policy matrix: `__select__tenant` / `__insert__tenant` / `__update__tenant`; §6 grant table: "provider_events | SELECT, INSERT, UPDATE (mutable trigger limits to apply columns)".
- So the spec intends a lims_app UPDATE that only stamps the three apply columns once (NULL → value), done by the C6 apply task (C6 02-TRD §4.8, §9; C6-T29, AC-09.3). It is not "append-only" in the AC-0B-4.3 sense. LD-232 asks to confirm this and narrow if possible.

## Current behaviour
- Grant: `GRANT SELECT, INSERT, UPDATE ON reporting.provider_events TO lims_app` (db/migrations/20261105001900_reporting__create_reporting_schema.sql:1029).
- Policy `provider_events__update__tenant` (db/policies/reporting.sql:210): USING / WITH CHECK `tenant_id = current tenant AND app.is_staff_or_system()`. `app.is_staff_or_system()` is true for actor types user, system AND device, so a staff user or a device actor of the tenant may UPDATE, and may do it on rows already applied.
- Trigger `provider_events__mutable_columns` (`app.enforce_mutable_columns('applied_at','delivery_id','ignored_reason')`) blocks every other column (raises `immutable_row`), but does not stop re-stamping an already-applied row (applied_at value → other value, delivery_id re-pointed).
- The ON CONFLICT hint: the ingest DEFINER `app.reporting_ingest_provider_callback` uses `INSERT … ON CONFLICT ON CONSTRAINT provider_events__dedupe__uq DO NOTHING` as lims_reporting_lookup (migration line 1227). DO NOTHING needs SELECT (granted, line 1115), not UPDATE; ON CONFLICT is NOT a reason for the lims_app UPDATE grant.

## Callers
- The only UPDATE: `markEventApplied` in services/api/src/modules/reporting/repository/provider-events.repo.ts:39 (`UPDATE … SET applied_at, delivery_id, ignored_reason … WHERE … AND applied_at IS NULL`), called by the worker task at services/worker/src/jobs/reporting/tasks/apply_provider_events.ts:36 under the reporting system actor (withTenantScope, LD-49 (b)).
- Read of pending rows: services/api/src/modules/reporting/repository/provider-events.repo.ts:11 (`applied_at IS NULL`).
- Ingest (no UPDATE): db/migrations/20261105001900_reporting__create_reporting_schema.sql:1227.
- DB test that exercises the UPDATE as the system actor: db/tests/reporting/T0B-10.C6_behaviour.test.sql:368.
- No staff (user) or device code path updates provider_events.

## Proposal
Keep the UPDATE grant (the apply task needs it). Narrow the policy to the system actor and to unapplied rows (one NULL → value stamp, matching §3 "NULL → value"). Additive migration in the C0-owned path plus the same text in db/policies/reporting.sql:
```sql
-- LD-232 item 2 (CR-C0-T0B-REVIEW-1-001): apply columns are stamped once, by the system actor only
ALTER POLICY provider_events__update__tenant ON reporting.provider_events
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
              AND (SELECT app.current_actor_type()) = 'system' AND applied_at IS NULL)
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
              AND (SELECT app.current_actor_type()) = 'system' AND applied_at IS NOT NULL);
```
No REVOKE (it would break C6-T29). Not proposed: a column-level UPDATE grant (it needs a GRANT, outside LD-232's narrowing-only rule). Spec follow-up for the lead: C6 05-SCHEMA §5 row for provider_events U = SYS + `applied_at IS NULL`.

## Tests
- db/tests/reporting/T0B-10.C6_behaviour.test.sql: must assert (a) system actor UPDATE of an unapplied row stamping applied_at / delivery_id → n=1 (line 368 stays green); (b) a second UPDATE of the same, now applied, row → n=0; (c) the same UPDATE under user claims and under device claims → n=0; (d) system UPDATE setting applied_at = NULL on an unapplied row → 42501 (WITH CHECK).
- db/tests/policy/T0B-08_policy_shape.test.sql: `provider_events__update__tenant` keeps `is_staff_or_system` in USING and WITH CHECK.
- services/worker/src/jobs/reporting/__tests__/apply_provider_events.test.ts stays green (re-run changes nothing).
