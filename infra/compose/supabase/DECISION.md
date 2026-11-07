# Supabase compose decisions (C1)

## T-05 - Supabase compose layering (02-TRD s7.1/s7.2)

Decision: split

Spike run 2026-11-07 with Docker Compose 5.1.4 (`docker compose config`, both hosts, no daemon needed):
- Snapshot: supabase/supabase commit 189adda99d1b56da55fc5a6ee3f849354aaea92a, fetched with curl per LD-33,
  tags equal TRD s2 (gotrue v2.197.0, postgrest v14.18, storage-api v1.89.12, envoy v1.39.6, imgproxy v4.0.21,
  pgbouncer v1.25.2-p0). Digests via `docker buildx imagetools inspect`; all in `upstream/UPSTREAM.lock`.
- `!reset null` on a whole service works (db, supavisor, studio, meta, functions, realtime vanish on app-1).
- `depends_on: !reset {}` and `ports: !reset []` work. `depends_on: !reset { rest: ... }` (as TRD s7.2 sketches it)
  does NOT keep the content: `!reset` clears the value. Storage uses `!override` instead.
- `!override` is needed for `networks:` (otherwise upstream `default` stays attached), `ports:` (db, pgbouncer) and
  storage `volumes:`.
- Removed services leave no dangling `depends_on`: the app-1 closure of the five services is exactly those five.
- Envoy trim: `functions`/`studio`/`meta`/`realtime` routes, their Lua/RBAC parts and cds clusters are deleted in
  `envoy/lds.template.yaml` + `envoy/cds.yaml` (outside `upstream/`, mounted over the upstream targets).
  Envoy runtime behaviour with the trimmed files is NOT yet run (no daemon in the writer session).
- Added to the snapshot beyond the four files the TRD names: `volumes/api/envoy/{envoy.yaml,cds.yaml,docker-entrypoint.sh}`
  (api-gw mounts them) and `volumes/db/*.sql` (db init scripts). All sha256-locked.

Gaps (need data-1/app-1, not verifiable here): GoTrue health + reach to data-1 and the SMTP relay over db_net,
Storage upload/download through api-gw from an app_net container (`infra/tests/integration/test_t05_live.py`),
Compose behaviour with pre-created `app_net`/`auth_net`/`db_net` (`name:` set so the project attaches to the
docker_engine networks; if Compose rejects the missing project label, declare them `external: true` and drop ipam).
`DB_IMAGE_DIGEST` for the derived db image comes from the release lock (T-23); the all-zero default fails closed.

## T-09 - WAL archiving / backup tool (02-TRD s9.1)

Decision: pgBackRest 2.60.0 (PROVISIONAL until the build spike passes on CI; fallback WAL-G per TRD s9.1).

Status of the done-when items (2026-11-07):
- Committed: derived image `infra/images/postgres-pgbackrest/Dockerfile` (builder stage, digest-pinned base,
  sha256-checked release tarball), `infra/database/pgbackrest/pgbackrest.conf.j2` (repo1 posix + repo2 sftp,
  `aes-256-cbc` on both), `archive_command = 'pgbackrest --stanza=lims archive-push %p'`, role `pgbackrest`
  (timers: full weekly, incr daily, check every 15 min, verify weekly, metrics every minute), `pgbackrest_metrics.sh`.
- Open, deferred until real hosts exist (blocker B12, LD-34): `pgbackrest check` on both repos, first full + incr
  backup, `info`/`repo-ls --output=json` field names against real output. Record results here when run.
- Tarball: release 2.60.0 fetched with curl, sha256 computed with sha256sum and recorded in the Dockerfile ARG
  (2026-11-07); pgbackrest.org lists v2.60.0 as Current Stable Release (released October 18, 2026).

Multi-repo failure behaviour (03-APP-FLOW s3.3). Re-checked 2026-11-07 against pgbackrest.org (release notes, 2.60
is current stable; the archive-push multi-repo note reads: when one repository is failing, `archive-push` cannot
push ahead to the other repositories unless `archive-async` is enabled). Earlier source: the EDB-hosted guide:
- `archive-push` tries every reachable repo; when one repo (repo1 or repo2) fails it still returns an error to
  PostgreSQL, so PostgreSQL keeps the segment in `pg_wal` and retries.
- With `archive-async=y` the async process keeps delivering WAL to the working repo, so a repo1 failure does
  not stop repo2 (off-site) from staying current; `pg_wal` grows on data-1 -> `WalArchiveFailing` + `DiskFillForecast`.
- Spool above `archive-push-queue-max` (20GiB): queued WAL is dropped and success is reported -> PITR gap
  until the next full backup (runbook forces one).

WAL volume per day (06 R8, founder item F-10): open, deferred to data-1 (B12, LD-34); no value is recorded here.
Planning estimate from TRD s9.4 worst case: 24 GiB/day before compression (1,536 segments x 16 MiB); the size
after `compress-type=zst` is the M2 measurement. Replace this line with the measured value, and apply R8 if
repo2 exceeds 60 % of its volume.
