```
Title: CR-C0-<nnn>: SP-5 — Atlas 1.3.1 community runner contract: migrations_meta grant to lims_owner, txmode directive, append-only migrations
From chunk: C0 (SP-5)      To owner: C0-0B (05-SCHEMA §1/§2 bootstrap, 02-TRD §4.2/§4.3, db/tools/check-migrations.ts) · C0-0A (T0A-09 dev stack env)
Type: schema
Blocking? no for SP-5 · T0B-01/T0B-02 need item 1 (else first migration fails: "write revision: pq: permission denied for schema migrations_meta")
Problem: SP-5 (db/meta/decisions/SP-5.md). Atlas writes its revision row inside each file's transaction, after the file's
  `SET LOCAL ROLE lims_owner`, so lims_owner must be able to write migrations_meta.atlas_schema_revisions. 05-SCHEMA §2 row
  `migrations_meta | lims_migrator | runner revision table | none` gives no grant. Also: Atlas needs a directive comment before the
  first statement of a non-transactional file, and does not re-verify already-applied files if atlas.sum is re-hashed.
Proposed change (exact):
  1. 05-SCHEMA bootstrap, after `CREATE SCHEMA migrations_meta AUTHORIZATION lims_migrator;`:
       GRANT USAGE ON SCHEMA migrations_meta TO lims_owner;
       ALTER DEFAULT PRIVILEGES FOR ROLE lims_migrator IN SCHEMA migrations_meta GRANT SELECT, INSERT, UPDATE ON TABLES TO lims_owner;
     05-SCHEMA §2 migrations_meta row, grants column: "none" → "lims_owner: USAGE; SELECT, INSERT, UPDATE on runner tables (SP-5)".
  2. 02-TRD §4.2 "First statement of every file": non-transactional files begin with the line `-- atlas:txmode none` and one blank
     line, then `SET ROLE lims_owner;` and exactly one `CREATE INDEX CONCURRENTLY …;`. check-migrations.ts accepts that header.
  3. 02-TRD §4.3 new ⚙ item: a PR may only add files under db/migrations/; modifying or deleting an existing migration file fails.
  4. 02-TRD §4.2 runner: `arigaio/atlas:1.3.1-community` by digest, `ATLAS_NO_UPDATE_NOTIFIER=1` wherever Atlas runs, no `atlas login`,
     `--revisions-schema migrations_meta`, URL parameters `lock_timeout=5s&statement_timeout=15min`, password via PGPASSWORD,
     `--allow-dirty` on the image init database (SP-3).
Backward compatible? yes (nothing applied yet)
Tenant/security impact: lims_owner (NOLOGIN, owner of all module objects) gains write on the runner table only; lims_app still has
  no access to migrations_meta (verified has_schema_privilege = f). No RLS change.
IRD/regulatory impact: n/a
Alternatives considered: sqitch 1.6.1 (rejected: SET LOCAL ROLE ignored outside a transaction, objects owned by lims_migrator);
  Atlas without the grant (fails on first file); move the role switch out of files (contradicts 02-TRD §4.2 (c)).
Tests that will prove it: db/tests/roles — lims_owner has INSERT on migrations_meta.atlas_schema_revisions, lims_app has no USAGE
  on migrations_meta; CI apply from empty (AC-0B-6.1); check-migrations.ts fixture with an edited old file → fail.
```
