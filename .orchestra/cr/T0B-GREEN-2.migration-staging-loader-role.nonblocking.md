Title: CR-C0-T0B-GREEN-2-001: lims_migration (C18 loader role) cannot evaluate its own RLS policies until D-136 is decided
From chunk: C0 (lane C0-0B, T0B-GREEN-2)            To owner: C0-0B (lead decision; founder for D-136)
Type: schema
Blocking? no (tests adjusted, see below; no migration_staging row is written in production yet: the loader does not run)
Problem: db/bootstrap/00_roles.sql (LD-226, CR-C18-001) creates lims_migration NOLOGIN with NO lims_app membership. Every migration_staging policy is TO lims_migration and calls app.current_tenant_id() / app.is_staff_or_system(); EXECUTE on those functions is granted to lims_owner, lims_app, lims_queue only. Evidence on the pinned image: has_function_privilege('lims_migration','app.current_tenant_id()','EXECUTE') = false; as lims_migration `SELECT 1 FROM migration_staging.runs` fails with E42501 "permission denied for function current_tenant_id". C18 05-SCHEMA s2 wants `GRANT lims_app TO lims_migration WITH INHERIT TRUE, SET FALSE` (PROPOSED EXCEPTION, 08 A19 D-136, still undecided), which would fix it.
Proposed change (exact): lead / founder decide D-136: (a) accept and add the GRANT (bootstrap or a migration), or (b) keep lims_migration outside lims_app and instead GRANT EXECUTE ON FUNCTION app.current_tenant_id(), app.is_staff_or_system(), app.current_actor_type() TO lims_migration (narrower; no inherited lims_app table grants).
Backward compatible? yes (additive grant).
Tenant/security impact: (b) is the least-privilege path; (a) also gives the loader every lims_app table grant under FORCE RLS.
IRD/regulatory impact: none
Alternatives considered: leaving T0B-13.C18_behaviour red; rejected because it aborts psql at the first T1 line and hides the 214 assertions behind it.
Tests that will prove it: T0B-13.C18_behaviour.test.sql, assertion "C18 setup / LD-226" pins the current state (goes red when the grant lands: then delete the in-transaction `GRANT lims_app TO lims_migration` line and that assertion); T0B-13.C18_schema.test.sql checks 37/38 (now: member of no role) are restored to the §2 expectation if option (a).
