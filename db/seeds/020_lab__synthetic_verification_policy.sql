-- T0C-VERLEVEL-1 (LD-316): default verification policy of the synthetic tenants (dev, ci, staging; SYNTHETIC ONLY, never production: REQ-SEC-041, REQ-SEC-136).
-- One active lab scope row per tenant: required_verifiers 2, require_pathologist true, allow_enterer_verify false (reproduces today: a technologist verifies,
-- a pathologist approves). Tenants that exist when 20261117150000_lab__add_verification_policy_and_signoffs.sql runs get the same row from the migration;
-- tenants created later get it from the service on first read (T0B-VERLEVEL-1). Hand written (gen-seeds.ts does not cover module tables).
-- Idempotent: fixed ids and timestamps, ON CONFLICT DO NOTHING (the PK and the one-active-per-target index); re-running inserts nothing new.
-- ---------- tenant_a ----------
SELECT set_config('request.jwt.claims', '{"tenant_id":"01a1a98a-ac40-7000-8000-00000000a001","sub":"01a1b34e-1004-782c-a681-49b1ce74d717","actor_type":"system"}', true);
SET LOCAL ROLE lims_app; -- LD-30: after claims, so lab.verification_policy__insert__tenant WITH CHECK applies

INSERT INTO lab.verification_policy (id, tenant_id, scope, required_verifiers, require_pathologist, allow_enterer_verify, active, created_at, updated_at, updated_by) VALUES
  ('01a1a98a-ac40-7000-8000-00000000a6a1', '01a1a98a-ac40-7000-8000-00000000a001', 'lab', 2, true, false, true, '2026-11-07 00:00:00+00', '2026-11-07 00:00:00+00', '01a1b34e-1004-782c-a681-49b1ce74d717')
ON CONFLICT DO NOTHING;

-- ---------- tenant_b ----------
SELECT set_config('request.jwt.claims', '{"tenant_id":"01a1a98a-ac40-7000-8000-00000000b001","sub":"01a1b34e-1004-782c-a681-49b1ce74d717","actor_type":"system"}', true);

INSERT INTO lab.verification_policy (id, tenant_id, scope, required_verifiers, require_pathologist, allow_enterer_verify, active, created_at, updated_at, updated_by) VALUES
  ('01a1a98a-ac40-7000-8000-00000000b6a1', '01a1a98a-ac40-7000-8000-00000000b001', 'lab', 2, true, false, true, '2026-11-07 00:00:00+00', '2026-11-07 00:00:00+00', '01a1b34e-1004-782c-a681-49b1ce74d717')
ON CONFLICT DO NOTHING;
