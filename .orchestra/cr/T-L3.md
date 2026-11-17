Title: CR-C16-T-L3: SECURITY DEFINER count of active links per patient so E15/E14 can enforce `max_accounts_per_patient`
From chunk: C16            To owner: C16 (05-SCHEMA §6 DEFINER functions, db/ migration)
Type: schema
Blocking? no for T-L3 delivery (account limit `max_profiles_per_account` enforced); yes for the per-patient half of 02-TRD §4.3.2 step 4 / §4.3.3 step 4 and 01-PRD:170 (US-EN-04 AC 8: "patient X already has `max_accounts_per_patient` (default 3) active links -> 409 engagement.link_limit_reached").
Problem: E15 runs as `lims_app` under patient RLS (`account_patient_links__select__owner_only`), so a count of active links for `patient_id` sees only the caller's own account rows. 05-SCHEMA §6 lists no function returning the tenant-wide count, so the per-patient limit cannot be checked. `checkLimit` in services/api/src/modules/engagement/service/link.service.ts enforces only the account limit today.
Proposed change (exact): add
  CREATE FUNCTION app.engagement_count_patient_links(p_patient_id uuid) RETURNS integer
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
    AS $$ SELECT count(*)::int FROM engagement.account_patient_links
          WHERE tenant_id = app.current_tenant_id() AND patient_id = p_patient_id AND status = 'active' $$;
  owner lims_owner, EXECUTE to lims_app only; add the row to 05-SCHEMA §6 DEFINER table (reads `account_patient_links` · SELECT).
  Alternative shape: extend `app.engagement_apply_report_link` / `app.engagement_redeem_link_code` to raise `engagement.link_limit_reached` themselves when inserting would exceed the limit (keeps the count inside the locked transaction; avoids a check-then-insert race).
Backward compatible? yes — additive function.
Tenant/security impact: returns a count only (no account ids / PHI); tenant fixed from session GUC, never a parameter. Reveals to a caller who holds a valid report link/code whether other accounts are linked to that patient (via 409) — this is already implied by the PRD AC.
IRD/regulatory impact: none.
Alternatives considered: counting under patient RLS (wrong: sees only own rows); running the count as a BYPASSRLS role from the API (rejected: violates 02-CONVENTIONS RLS rules).
Tests that will prove it: schema test — function returns tenant-wide active count, ignores suspended/revoked rows and other tenants; T-L3/T-L2 service tests — patient with `max_accounts_per_patient` active links on other accounts -> 409 `engagement.link_limit_reached`, nothing inserted, no job enqueued.
