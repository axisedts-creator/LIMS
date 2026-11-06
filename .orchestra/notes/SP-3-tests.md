# SP-3 tests
- File: tests/spikes/SP-3.decision.test.mjs (node:test, no deps; same layout as SP-1/SP-2)
- Run: `node --test tests/spikes/SP-3.decision.test.mjs`
- Checks db/meta/decisions/SP-3.md: pinned image named, Harness pgtap|sql-harness, pg_available_extensions evidence for pgtap/pg_trgm/btree_gin/pgcrypto/pg_uuidv7 (each version or missing), CREATE EXTENSION pgtap in throwaway DB as superuser, pg_trgm in `extensions`, GoTrue/Storage/PostgREST database + login roles (supabase_auth_admin, supabase_storage_admin, authenticator), GRANT CONNECT decision, no secrets.
- Conditional: pgtap -> test DBs only; sql-harness -> pgtap failure reason; pg_trgm missing -> CR to C4 (REQ-ARCH-023); btree_gin missing -> index exception; LIMS DB -> exact GRANT CONNECT per role.
- Expected now: all 15 fail (verified by run) with "db/meta/decisions/SP-3.md must exist".
- Live image behaviour not unit-testable; record checked structurally only.
