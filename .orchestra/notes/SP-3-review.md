CHANGES

Scope: `git diff 43dc048..HEAD` holds only fed04e5 (rename `.orchestra/cr/SP-3.md` -> `SP-3.nonblocking.md`). The SP-3 deliverable (83979b8 record, cf4d0b9 tests) predates the base, so it was reviewed at HEAD as well.

1. db/meta/decisions/SP-3.md:5 — dangling reference after the rename: "CR `.orchestra/cr/SP-3.md` fills the 05-SCHEMA §1 placeholder." Fix: replace `.orchestra/cr/SP-3.md` with `.orchestra/cr/SP-3.nonblocking.md`. (Same stale path in .orchestra/notes/SP-3-impl.md:2; writer may update its own note.)

Checked, no defect:
- done_when met: Harness = pgtap 1.3.3 (test DBs only, bootstrap never creates it, matches 05-SCHEMA §1 l.76); pg_trgm 1.6 available, created WITH SCHEMA extensions (05-SCHEMA §1 l.73, REQ-ARCH-023), no CR to C4; btree_gin 1.3 (08 A31.1) with tenant-leading gin index built; GoTrue/Storage/PostgREST login roles recorded (supabase_auth_admin, supabase_storage_admin, authenticator) with database + GRANT CONNECT answer for review C0 m#36 (05-SCHEMA §1 l.78-80).
- Names cross-checked against spec (app.uuidv7, @lims/shared-ts/uuidv7, 08 A31.1, m#36, REQ-ARCH-023); nothing invented. pg_uuidv7 absence handled without new mechanism.
- No secrets (`<scratch>` placeholder), synthetic scratch DBs only, container bound to 127.0.0.1. No RLS/permission/error-code surface in this task.
- Path: db/meta/decisions/SP-3.md is the path named in the task brief (same as SP-1/SP-2); tests in tests/spikes/ as SP-1/SP-2.
- Tests: `node --test tests/spikes/SP-3.decision.test.mjs` run by reviewer: 15/15 pass. Structural only; live image behaviour not re-run.
- Open points (services not started, POSTGRES_DB rename, pgtap schema) are declared and routed to SP-5/T0A-09/T0B-08; acceptable for a spike.
