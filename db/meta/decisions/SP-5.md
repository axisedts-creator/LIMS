# SP-5 — Migration runner: Atlas community vs sqitch

- Date run: 2026-11-06 · Plan row: `spec/chunks/C0-foundation-contracts/06-IMPLEMENTATION-PLAN.md` SP-5 · 02-TRD §4.2 (a)–(g), CV §5.12, CV §15.2, 04 S12, 04 §11, research 03 §3.5, R-9
- Database: `supabase/postgres:17.6.1.136` (same pinned image as SP-3), started empty in a throwaway sandbox.
- **Outcome: pass for Atlas.** Atlas community was evaluated first (research 03 §3.5 preference), then sqitch. Atlas meets (a)–(g) with three conditions (see "Runner contract"); sqitch fails (c). Not supabase CLI: supabase CLI / supabase db migrations are excluded (04 S12, keeps Supabase removable). CR `.orchestra/cr/SP-5.md` carries the bootstrap grant and the check-migrations rules.

## Decision

Decision: **atlas** — Atlas community build **1.3.1** (`atlas community version v1.3.1`), image `arigaio/atlas:1.3.1-community` (`sha256:76cc66fb31f99d5d316676b8a9866ef4b6d6bf5aacc0639485d04848670839e4`, binary sha256 `521aafcdc4c81a6aee3d553adc97633821a7cb28076ffcdf4add27add930c804`). Pin exactly this tag + digest; never a floating tag (`arigaio/atlas:<floating>-community` resolved to a canary build `v1.3.1-90dacfc-canary`).

### Atlas 1.3.1 community (chosen)

| # | Criterion (02-TRD §4.2) | Verdict and evidence |
|---|---|---|
| a | (a) forward-only plain `.sql` in lexical order | pass — `migrate apply` runs `db/migrations/*.sql` in lexical file-name order; forward-only (no down files) |
| b | (b) per-file non-transactional mode for CREATE INDEX CONCURRENTLY | pass — file directive `-- atlas:txmode none` followed by a blank line; without the blank line the file still ran in a transaction (`25001`) |
| c | (c) first statement is the owner role switch (`SET LOCAL ROLE lims_owner` / `SET ROLE lims_owner`) | pass — every object created is owned by `lims_owner`; needs the revision-table grant to `lims_owner` (condition 1) |
| d | (d) revision table in `migrations_meta`, owned by `lims_migrator`, no grants to `lims_app` | pass — `--revisions-schema migrations_meta` creates `migrations_meta.atlas_schema_revisions` owned by `lims_migrator`; `lims_app` has no grant (USAGE f, SELECT f) |
| e | (e) checksum / integrity mode | pass — `atlas.sum` (`migrate hash`); an edited file without a new hash is refused (`Error: checksum mismatch`). Condition 3 covers edits of applied files |
| f | (f) no network call at run time; telemetry disabled or absent | pass — only call seen is the update check (DNS for `vercheck.ariga.io`); off with `ATLAS_NO_UPDATE_NOTIFIER=1` (0 lookups); no `atlas login` |
| g | (g) licence allowed by CV §15.2 | pass — community build licence Apache-2.0 (ariga/atlas repository); the official non-community binary is under the Atlas EULA and is not used |

### sqitch 1.6.1 (fallback, R-9)

sqitch 1.6.1 (`sqitch/sqitch@sha256:f247ab0e0b66e9c2d09a400864f7314358893f5cf209cddcc4f213f7d5bfe4d3`) is the fallback and is rejected: it fails the owner role switch criterion. Evaluation stopped there.

| # | Criterion | sqitch 1.6.1 |
|---|---|---|
| a | (a) lexical order | extra work — order comes from `sqitch.plan`, not file names; a plan line per file must be generated |
| b | (b) CONCURRENTLY | sqitch never wraps a script in a transaction |
| c | (c) owner role switch `SET LOCAL ROLE lims_owner` | fail — no transaction around the script, so `SET LOCAL ROLE` is ignored (`WARNING: SET LOCAL can only be used in transaction blocks`); objects ended up owned by `lims_migrator`. Every file would need its own `BEGIN;`, so the first statement would no longer be the role switch |
| d | (d) `--registry migrations_meta` | registry tables created in `migrations_meta` |
| e | (e) integrity | not tested |
| f | (f) network | no lookups other than the DB host |
| g | (g) licence | MIT (`App::Sqitch` POD "License") |

## Runner contract (input for T0A-09, T0B-01, T0B-02, check-migrations.ts)

```sh
# CI and dev: run inside the pinned image, no login, update check off
docker run --rm -e ATLAS_NO_UPDATE_NOTIFIER=1 -e PGPASSWORD=<from secret store> \
  -v "$PWD/db/migrations:/migrations" arigaio/atlas:1.3.1-community \
  migrate apply --dir file:///migrations --revisions-schema migrations_meta --allow-dirty \
  --url "postgres://lims_migrator@<host>:5432/<dbname>?sslmode=<mode>&lock_timeout=5s&statement_timeout=15min"
```

- Session settings: `lock_timeout = 5s` and `statement_timeout = 15min` are passed as URL run-time parameters; verified inside a migration as `lt = 5s`, `st = 15min`, `current_user = lims_owner`.
- No `atlas login`, never; no Atlas Cloud URL, no `ATLAS_TOKEN`. Update check off with `ATLAS_NO_UPDATE_NOTIFIER=1` (must be set everywhere Atlas runs).
- `--allow-dirty` is needed because the image ships its own schemas (`auth`, `storage`, `extensions`; error without it: `connected database is not clean: found schema "auth"`). Atlas does not manage those schemas.
- Password via `PGPASSWORD` from the secret store, never inside the URL.
- Condition 1 (CR): the revision row is written inside each file's transaction, after `SET LOCAL ROLE lims_owner`, so `lims_owner` needs `USAGE` on schema `migrations_meta` and `SELECT, INSERT, UPDATE` on `migrations_meta.atlas_schema_revisions`. Without it: `write revision: pq: permission denied for schema migrations_meta`. Owner stays `lims_migrator`; still nothing to `lims_app`. Bootstrap form (verified on a fresh database, first run, `lims_migrator` granted `lims_owner WITH INHERIT FALSE, SET TRUE` as in 05-SCHEMA §2):

```sql
CREATE SCHEMA migrations_meta AUTHORIZATION lims_migrator;
GRANT USAGE ON SCHEMA migrations_meta TO lims_owner;
ALTER DEFAULT PRIVILEGES FOR ROLE lims_migrator IN SCHEMA migrations_meta GRANT SELECT, INSERT, UPDATE ON TABLES TO lims_owner;
```
- Condition 2 (CR): transactional files start `SET LOCAL ROLE lims_owner;`. Non-transactional files are exactly:

```sql
-- atlas:txmode none

SET ROLE lims_owner;
CREATE INDEX CONCURRENTLY <name> ON <schema>.<table> (tenant_id, ...);
```

  check-migrations.ts must accept the directive comment + blank line before the first statement. After a `SET ROLE` file the session stays `lims_owner` for later files in the same run (harmless: later files switch again, revision writes covered by condition 1).
- Condition 3 (CR): Atlas community does not re-check files already applied. A tampered applied file with a re-generated `atlas.sum` was not detected (`No migration files to execute`, status OK). check-migrations.ts must fail any PR that modifies or deletes an existing file under `db/migrations/` (only new files appended; `atlas.sum` change = added lines + header hash only).
- Lint gap: `atlas migrate lint` is Pro-only since v0.38 (research 03 §3.5, 04 S13, D7); its concurrent-index analyzers are Pro. Not used as the B10 gate. Linter = squawk (SP-6) plus check-migrations.ts; B10 stays with SP-6 / founder (04 S13).

## Evidence

Sandbox: docker network `sp5net` created with `--internal` (egress blocked, no route out). Postgres, Atlas and sqitch ran only on it. A `nicolaka/netshoot:v0.13` container on the same network ran `tcpdump -i any`; Atlas and sqitch ran with `--network container:sp5_tap`, so every packet they sent was captured. Synthetic migrations only (`app.sp5_probe`, no LIMS data). All containers and the network removed afterwards.

```sh
docker network create --internal sp5net
docker run -d --name sp5_pg --network sp5net -e POSTGRES_PASSWORD=<scratch> supabase/postgres:17.6.1.136
psql -U supabase_admin -f bootstrap.sql   # lims_owner NOLOGIN, lims_migrator LOGIN (member of lims_owner), lims_app, schema migrations_meta AUTHORIZATION lims_migrator
docker run --rm --network none arigaio/atlas:1.3.1-community version
docker run --rm --network none sqitch/sqitch@sha256:f247ab0e0b66e9c2d09a400864f7314358893f5cf209cddcc4f213f7d5bfe4d3 --version
atlas migrate hash --dir file:///migrations
atlas migrate apply --allow-dirty --dir file:///migrations --revisions-schema migrations_meta --url "postgres://lims_migrator@sp5_pg:5432/postgres?sslmode=disable&lock_timeout=5s&statement_timeout=15min"
sqitch deploy --registry migrations_meta "db:pg://lims_migrator@sp5_pg:5432/sp5_sq"   # PGOPTIONS="-c lock_timeout=5s -c statement_timeout=15min"
tcpdump -nn -r cap.pcap -X "udp and dst host 127.0.0.11"   # DNS names asked
```

Output (trimmed):

```text
$ atlas version
atlas community version v1.3.1
https://github.com/ariga/atlas/releases/tag/v1.3.1
$ sqitch --version
sqitch (App::Sqitch) v1.6.1

-- Atlas, empty LIMS database (image schemas only), 2 files:
Error: sql/migrate: connected database is not clean: found schema "auth". baseline version or allow-dirty is required
sql/migrate: write revision: pq: permission denied for schema migrations_meta (42501)      -- before condition 1 grant
pq: CREATE INDEX CONCURRENTLY cannot run inside a transaction block (25001)                 -- directive without blank line
Error: checksum mismatch                                                                     -- file edited, atlas.sum not re-hashed
-- migrating version 20261106000001  -> SET LOCAL ROLE lims_owner; CREATE SCHEMA app; CREATE TABLE ... -- ok
-- migrating version 20261106000002  -> SET ROLE lims_owner; CREATE INDEX CONCURRENTLY sp5_probe_name_idx ... -- ok
app.sp5_settings: lt=5s | st=15min | who=lims_owner
owners: schema app, sp5_probe, sp5_probe_pkey, sp5_probe_name_idx = lims_owner ; migrations_meta = lims_migrator
migrations_meta.atlas_schema_revisions acl {lims_migrator=arwdDxtm/lims_migrator,lims_owner=arw/lims_migrator}
lims_app: has_schema_privilege(migrations_meta, USAGE)=f has_table_privilege(SELECT)=f
fresh database (bootstrap form above, INHERIT FALSE SET TRUE), first run, no --allow-dirty: 2 migrations ok;
  atlas_schema_revisions owner lims_migrator acl {lims_owner=arw/...} ; app objects owner lims_owner ; 5s|15min|lims_owner
applied file 1 edited + atlas.sum re-hashed -> "No migration files to execute"; status OK (not detected)

-- network capture (Atlas)
DNS names asked: sp5_pg (42), vercheck.ariga.io (16); TCP to any host other than sp5_pg: 0
migrate status without ATLAS_NO_UPDATE_NOTIFIER: 8 lookups vercheck.ariga.io (ServFail, offline)
migrate status / migrate apply with ATLAS_NO_UPDATE_NOTIFIER=1: 0 lookups, 0 outbound TCP, no telemetry call

-- sqitch, empty database sp5_sq
+ 20261106000001_app__create_schemas .. WARNING:  SET LOCAL can only be used in transaction blocks  ok
+ 20261106000002_app__create_index_sp5_probe_name .. ERROR:  permission denied for schema app  not ok
schema app owner = lims_migrator ; sp5_settings.who = lims_migrator    -- (c) not met
registry tables in migrations_meta: releases, projects, changes, tags, dependencies, events
sqitch DNS: no name other than sp5_pg ; 0 outbound TCP
```

## Hand-off

- T0A-09 (dev stack): run migrations with the contract above; `ATLAS_NO_UPDATE_NOTIFIER=1` in the dev env.
- T0B-01 (bootstrap): add the condition 1 bootstrap form (USAGE + default privileges, CR), keep `migrations_meta` owned by `lims_migrator`.
- T0B-02 (first migrations): file layout per condition 2; CI applies from empty (AC-0B-6.1) on `supabase/postgres:17.6.1.136`.

## Open points

- Licence text of ariga/atlas at v1.3.1 was not re-fetched in this session (web access blocked); Apache-2.0 for the community build is taken from the repository; confirm in the T0B-01 licence scan. The image's `org.opencontainers.image.licenses` label is empty.
- Only 2 synthetic files were applied, not the full C0 migration set (it does not exist yet); re-run from empty in T0B-02 CI.
- `migrate lint` in the community build ran but its rule coverage was not assessed (SP-6 scope).
- `--allow-dirty` is only needed on the image init database (SP-3: LIMS dbname = that database); on a new empty database Atlas ran without it. With `--allow-dirty`, Atlas does not refuse a database that already holds unexpected LIMS objects; the CI fresh + upgrade applies (DoD §1.7) cover that.
