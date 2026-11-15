Title: CR-AUTH-PLATFORM-SESSION-1 (to C2 and C0): app.identity_platform_auth_load_session and app.identity_platform_auth_read_mfa_factors are not yet in C2 05-SCHEMA s5.4, s6, s10.3
Severity: non-blocking. Authority: LD-216 (founder yes, 2026-11-15 15:41 NPT).
Fact: db/migrations/20261115156000_identity__add_platform_mfa_read_definers.sql adds two read-only SECURITY DEFINER functions (owner lims_owner, search_path '', EXECUTE lims_api only): app.identity_platform_auth_load_session(p_user_id uuid, p_session_id uuid) and app.identity_platform_auth_read_mfa_factors(p_user_id uuid). They read identity.sessions / platform_staff / mfa_factors through the existing owner-only policies (app.pre_user_id, app.pre_tenant_id) and reset both GUCs to ''. Two rows are in db/meta/definer-inventory.yaml.
Ask C2: name both functions in 05-SCHEMA s5.4 (owner-only policies read by DEFINERs) and s6.
Ask C0: transcribe the SQL bodies into 05-SCHEMA s10.3; until then the migration is the body of record.
NOT run in the lane: the migration and db/tests/identity/AUTH-PLATFORM-SESSION-1_platform_reads.test.sql (no psql or docker).
