# SP-3 impl
- Files: db/meta/decisions/SP-3.md (record, outcome pass), .orchestra/cr/SP-3.nonblocking.md (fill 05-SCHEMA §1 GRANT CONNECT placeholder).
- Live run on supabase/postgres:17.6.1.136 (digest recorded); throwaway container removed.
- Harness: pgtap 1.3.3. pg_trgm 1.6, btree_gin 1.3, pgcrypto 1.3 available; pg_uuidv7 not available (app.uuidv7() covers it).
- Finding: extensions/auth/storage schemas exist only in image init DB, so LIMS DB = services' DB; GRANT CONNECT to supabase_auth_admin, supabase_storage_admin, authenticator needed.
- Finding: image superuser is supabase_admin; postgres is not superuser.
- Open: services not started (connect target inferred); POSTGRES_DB rename untested; pgtap schema placement (public default) for T0B-08.
- Tests: node --test tests/spikes/SP-3.decision.test.mjs 15/15 pass; SP-1 + SP-2 regression pass (38/38 total).
