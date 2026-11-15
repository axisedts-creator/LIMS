Title: CR-SESSION-ACTOR-1 (to C2 and C0): app.identity_session_actor is not yet in C2 05-SCHEMA s10.3
Severity: non-blocking. Authority: LD-208 (founder yes, 2026-11-15).
Fact: db/migrations/20261115155000_identity__add_session_actor_definer.sql adds app.identity_session_actor(p_user_id uuid, p_tenant_id uuid, p_membership_id uuid) RETURNS TABLE (display_name text, role_codes text[], tenant_code text): plpgsql, SECURITY DEFINER, owner lims_owner, search_path '', read-only, EXECUTE lims_api only. The lead put the s5.4 / s6 rows into 05-SCHEMA (uncommitted in main).
Ask C2: take the s5.4 / s6 rows as written. Ask C0: transcribe the SQL body of that migration into C2 05-SCHEMA s10.3; until then the migration is the body of record.
Also: item 2 of CR C2.T6 is withdrawn (see C2.T6.nonblocking.md).
